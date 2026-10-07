import { Router, type Response } from "express";
import mongoose from "mongoose";
import type { QueryFilter } from "mongoose";
import AdvertisingExpense, {
  type IAdvertisingExpense,
} from "../models/AdvertisingExpense.js";
import Order from "../models/Orders.js";
import {
  createAdvertisingExpenseSchema,
  updateAdvertisingExpenseSchema,
} from "../schemas/advertisingSchemas.js";
import {
  WindsorError,
  externalKeyFor,
  fetchAllWindsorData,
  legacyExternalKeyFor,
} from "../lib/windsor.js";
import {
  AED_PER_USD_LABEL,
  WINDSOR_SOURCE_CURRENCY,
  aedToUsd,
} from "../lib/currency.js";

import {
  BUSINESS_TIMEZONE as TIMEZONE,
  DAY_MS,
  startOfDayInTimeZone,
  startOfBusinessDay,
  dayKeyFormatter,
} from "../lib/date.js";
import { round2 } from "../lib/money.js";
import {
  getProductTotalsFrom,
  startOfWindowForRange,
} from "../lib/orderTotals.js";

import {
  ALL_ACCOUNT_KEYS,
  BUSINESS_ACCOUNT_KEYS,
  accountFilter,
  isAccountKey,
  resolveBusinessAccount,
  type BusinessAccountKey,
} from "../lib/adAccounts.js";
import Product from "../models/Product.js";

/** Translates a plain-English verdict key into the app's localised copy.
 *
 * Server-side nodes have no locale, and the same English copy lives in
 * messages/en.json and messages/ar.json keyed identically, so the pages
 * can translate the verdict text with the existing `useTranslations`
 * dictionary without the backend knowing about i18n.
 *
 * @param key English message key inside the "advertising" namespace.
 */
function advertisingT(key: string): string {
  const dict: Record<string, string> = {
    "verdictReason.noAdSpend": "No ad spend was recorded in this period.",
    "verdictReason.noProfitBaseline":
      "There is no positive profit in this period to compare against.",
    "verdictReason.noDeliveredOrders":
      "There are no delivered orders in this period yet.",
    "verdictNext.scale":
      "Ads cost less than half of what each order earns. Safe to increase the budget.",
    "verdictNext.watch":
      "Ads cost between half and all of each order's profit. Keep watching before scaling.",
    "verdictNext.losing":
      "Ads cost more than each order earns. Pause them or fix the campaigns first.",
    "breakEvenMessage": "Break-even per order: {amount}",
  };

  return dict[key] ?? key;
}

/** Business-account bucket -> Windsor ad-account key for the window. */
function accountBucketToKey(bucket: BusinessAccountKey): string {
  switch (bucket) {
    case "viora":
      return "viora";
    case "trendora_facebook":
      return "trendora_facebook";
    case "trendora_instagram":
      return "trendora_instagram";
    default:
      return "trendora_other";
  }
}

/**
 * Per-account spend/messages for the window, resolved through the business
 * account directory (same as /advertising/insights).
 */
async function resolveWindowAccounts(
  windowStart: Date,
): Promise<
  Array<{
    key: BusinessAccountKey;
    spend: number;
    messages: number;
    accountId: string | null;
    accountStatus: string;
  }>
> {
  const rows = await AdvertisingExpense.find({
    date: { $gte: windowStart },
    source: "windsor",
  }).lean();

  const buckets = new Map<BusinessAccountKey, { spend: number; messages: number }>(
    BUSINESS_ACCOUNT_KEYS.map((k) => [k, { spend: 0, messages: 0 }]),
  );

  for (const row of rows as Array<{
    store: string | null;
    accountId: string | null;
    amount: number;
    messages?: number;
  }>) {
    const key = resolveBusinessAccount(row.store, row.accountId);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.spend += row.amount;
      bucket.messages += row.messages ?? 0;
    }
  }

  return ALL_ACCOUNT_KEYS.filter((key) => buckets.has(key)).map((key) => ({
    key,
    spend: round2((buckets.get(key) ?? { spend: 0, messages: 0 }).spend),
    messages: Math.round((buckets.get(key) ?? { spend: 0, messages: 0 }).messages),
    accountId: null,
    accountStatus: "",
  }));
}

const router = Router();

/** Keep listing queries bounded, mirroring productRoutes.ts. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 10;

/** Escape user input before it becomes a regex (same as productRoutes.ts). */
const escapeRegex = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function badRequest(res: import("express").Response, message: string, issues?: unknown) {
  return res.status(400).json({ message, errors: issues });
}

/**
 * Parse an optional `from`/`to` (YYYY-MM-DD) filter into a date range.
 * `to` is inclusive, so it is pushed to the end of that business day.
 */
function parseRange(query: Record<string, unknown>) {
  const from = typeof query.from === "string" ? query.from.trim() : "";
  const to = typeof query.to === "string" ? query.to.trim() : "";

  const range: { $gte?: Date; $lte?: Date } = {};

  if (from) {
    const parsed = new Date(`${from}T00:00:00.000Z`);

    if (!Number.isNaN(parsed.getTime())) {
      range.$gte = parsed;
    }
  }

  if (to) {
    const parsed = new Date(`${to}T00:00:00.000Z`);

    if (!Number.isNaN(parsed.getTime())) {
      range.$lte = new Date(parsed.getTime() + 24 * 60 * 60 * 1000 - 1);
    }
  }

  return Object.keys(range).length > 0 ? range : null;
}

/**
 * GET /api/advertising
 *
 * Paginated list plus the summary and platform breakdown for the same filter,
 * so the page needs a single request.
 */
router.get("/", async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(
      Math.max(Number(req.query.limit) || DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );

    const platform =
      typeof req.query.platform === "string" ? req.query.platform.trim() : "";

    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";

    const filter: QueryFilter<IAdvertisingExpense> = {};

    const range = parseRange(req.query as Record<string, unknown>);
    if (range) filter.date = range;

    if (platform) filter.platform = platform;

    /*
     * Business filters. Everything is applied BEFORE countDocuments and the
     * skip/limit slice, so `summary` and `pagination` always describe the
     * FULL filtered set - never just the current page.
     *
     * Applied in this order so overlapping params INTERSECT (a contradictory
     * combination narrows to an empty result instead of returning wrong rows):
     *   1. account -> source + store + accountId
     *   2. source  (manual | windsor) - manual rows predate `store`, so this
     *      correctly excludes them when an account is selected
     *   3. store
     */
    const account =
      typeof req.query.account === "string" ? req.query.account.trim() : "";

    if (account) {
      if (!isAccountKey(account)) {
        return badRequest(res, "Invalid account filter");
      }

      Object.assign(filter, accountFilter(account));
    }

    const source =
      typeof req.query.source === "string" ? req.query.source.trim() : "";

    if (source === "manual") {
      // Missing `source` = a document written before the field existed = manual.
      filter.source = { $in: [null, "manual"] };
    } else if (source === "windsor") {
      filter.source = "windsor";
    } else if (source) {
      return badRequest(res, "Invalid source filter");
    }

    const store =
      typeof req.query.store === "string" ? req.query.store.trim() : "";

    if (store === "viora" || store === "trendora") {
      filter.store = store;
    } else if (store) {
      return badRequest(res, "Invalid store filter");
    }

    if (search) {
      const rx = escapeRegex(search);

      filter.$or = [
        { campaign: { $regex: rx, $options: "i" } },
        { platform: { $regex: rx, $options: "i" } },
        { note: { $regex: rx, $options: "i" } },
      ];
    }

    const skip = (page - 1) * limit;

    const [expenses, totalExpenses, summaryRows] = await Promise.all([
      AdvertisingExpense.find(filter)
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      AdvertisingExpense.countDocuments(filter),

      // Totals over the FULL filtered set - never just the current page.
      AdvertisingExpense.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            total: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const totalPages = Math.ceil(totalExpenses / limit);
    const summary = summaryRows[0] ?? { total: 0, count: 0 };

    return res.status(200).json({
      expenses: expenses.map((expense) => ({
        ...expense,
        _id: expense._id.toString(),
      })),

      pagination: {
        currentPage: page,
        limit,
        totalExpenses,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },

      summary: {
        totalSpend: round2(summary.total),
        expenseCount: summary.count,
        averageExpense:
          summary.count > 0 ? round2(summary.total / summary.count) : 0,
      },
    });
  } catch (error) {
    console.error("Failed to fetch advertising expenses:", error);

    return res
      .status(500)
      .json({ message: "Failed to fetch advertising expenses" });
  }
});

router.post("/", async (req, res) => {
  const result = createAdvertisingExpenseSchema.safeParse(req.body);

  if (!result.success) {
    return badRequest(res, "Invalid advertising expense", result.error.issues);
  }

  try {
    const expense = await AdvertisingExpense.create({
      ...result.data,
      // Explicit on purpose: manual rows are never touched by a Windsor sync
      // (every sync query pins source: "windsor").
      source: "manual" as const,
      date: new Date(result.data.date),
      campaign: result.data.campaign || undefined,
      note: result.data.note || undefined,
    });

    return res.status(201).json(expense);
  } catch (error) {
    console.error("Failed to create advertising expense:", error);

    return res
      .status(500)
      .json({ message: "Failed to create advertising expense" });
  }
});

router.put("/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: "Invalid expense ID" });
  }

  const result = updateAdvertisingExpenseSchema.safeParse(req.body);

  if (!result.success) {
    return badRequest(res, "Invalid advertising expense", result.error.issues);
  }

  try {
    const existing = await AdvertisingExpense.findById(req.params.id);

    if (!existing) {
      return res.status(404).json({ message: "Expense not found" });
    }

    // Windsor rows are owned by the sync: editing one here would silently
    // revert on the next sync. Only manual rows are editable.
    if (existing.source === "windsor") {
      return res.status(400).json({
        message:
          "This record comes from Windsor sync. Use Sync Windsor to update it.",
      });
    }

    const expense = await AdvertisingExpense.findByIdAndUpdate(
      req.params.id,
      {
        ...result.data,
        date: new Date(result.data.date),
        campaign: result.data.campaign || undefined,
        note: result.data.note || undefined,
      },
      { new: true, runValidators: true },
    );

    if (!expense) {
      return res.status(404).json({ message: "Expense not found" });
    }

    return res.status(200).json(expense);
  } catch (error) {
    console.error("Failed to update advertising expense:", error);

    return res
      .status(500)
      .json({ message: "Failed to update advertising expense" });
  }
});

router.delete("/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: "Invalid expense ID" });
  }

  try {
    const existing = await AdvertisingExpense.findById(req.params.id);

    if (!existing) {
      return res.status(404).json({ message: "Expense not found" });
    }

    // Windsor rows are owned by the sync (deleting one would only bring it
    // back on the next sync); only manual rows are deletable here.
    if (existing.source === "windsor") {
      return res.status(400).json({
        message:
          "This record comes from Windsor sync and is managed automatically.",
      });
    }

    const expense = await AdvertisingExpense.findByIdAndDelete(req.params.id);

    if (!expense) {
      return res.status(404).json({ message: "Expense not found" });
    }

    return res.status(200).json({ message: "Advertising expense deleted" });
  } catch (error) {
    console.error("Failed to delete advertising expense:", error);

    return res
      .status(500)
      .json({ message: "Failed to delete advertising expense" });
  }
});
/* -------------------------------------------------------------------------- */
/* Windsor sync                                                               */
/* -------------------------------------------------------------------------- */

const WINDSOR_SOURCE = "windsor";

function windsorError(res: Response, error: unknown) {
  if (error instanceof WindsorError) {
    return res.status(error.status).json({ message: error.message });
  }

  console.error("Windsor sync failed:", error);

  return res.status(500).json({ message: "Failed to sync from Windsor" });
}

/**
 * Stored Windsor amounts keyed by externalKey (new AND legacy formats), so
 * preview can count created / updated / unchanged exactly like the sync does.
 */
async function existingWindsorAmounts(newKeys: string[], legacyKeys: string[]) {
  const rows = await AdvertisingExpense.find(
    { source: WINDSOR_SOURCE, externalKey: { $in: [...newKeys, ...legacyKeys] } },
    // NOTE: this is the PROJECTION argument, not an options object. Passing
    // `{ projection: {...} }` here makes Mongoose project a field literally
    // named "projection", so `externalKey` never comes back and every key
    // looks new (preview would report created=N, updated=0 forever).
    { externalKey: 1, amount: 1, _id: 0 },
  ).lean();

  return new Map(rows.map((row) => [row.externalKey, row.amount]));
}

/**
 * Existing MANUAL spend, always in USD.
 *
 * Informational only. Manual rows are advertising the Windsor connections do
 * not cover (a different account), so they are ADDED to Windsor spend - they
 * are never a duplicate of it, and their presence never blocks a sync.
 */
async function manualSpendTotal() {
  const rows = await AdvertisingExpense.aggregate([
    { $match: { source: { $in: [null, "manual"] } } },
    { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
  ]);

  return { total: round2(rows[0]?.total ?? 0), count: rows[0]?.count ?? 0 };
}

/** Build the per-source rows the UI and the sync both need. */
function summarise(result: Awaited<ReturnType<typeof fetchAllWindsorData>>) {
  // Accounts with usable rows.
  const sources = result.connections.flatMap((conn) =>
    conn.accounts.map((acc) => ({
      store: acc.store,
      connectionId: conn.connectionId,
      connectionLabel: conn.label,
      /** Business account (Viora / Trendora — Facebook / …), resolved here
       *  so the UI never has to know Windsor ids. */
      accountKey: resolveBusinessAccount(acc.store, acc.accountId),
      accountId: acc.accountId,
      accountName: acc.accountName,
      accountStatus: acc.accountStatus,
      from: acc.from,
      to: acc.to,
      rowCount: acc.rowCount,
      /** AED as Windsor reported it. */
      sourceSpend: round2(acc.sourceSpend),
      /** USD after the fixed conversion. */
      spend: aedToUsd(acc.sourceSpend),
      messages: acc.messages,
      clicks: acc.clicks,
      costPerMessage: ratio(aedToUsd(acc.sourceSpend), acc.messages),
    })),
  );

  /*
   * Windsor accounts that appeared in the response but produced no usable
   * rows (disabled, or no dated campaign data). They are listed with zeroes so
   * the owner can SEE that the account exists rather than assume it is gone.
   */
  const emptySources = result.connections.flatMap((conn) =>
    conn.sightings
      .filter(
        (sighting) =>
          !conn.accounts.some(
            (acc) => (acc.accountId || "unknown") === (sighting.accountId || "unknown"),
          ),
      )
      .map((sighting) => ({
        store: conn.store,
        connectionId: conn.connectionId,
        connectionLabel: conn.label,
        accountKey: resolveBusinessAccount(conn.store, sighting.accountId),
        accountId: sighting.accountId,
        accountName: sighting.accountName,
        accountStatus: sighting.accountStatus,
        from: null,
        to: null,
        rowCount: 0,
        sourceSpend: 0,
        spend: 0,
        messages: 0,
        clicks: 0,
        costPerMessage: null,
        empty: true,
      })),
  );

  return {
    rate: AED_PER_USD_LABEL,
    currency: WINDSOR_SOURCE_CURRENCY,
    availableFrom: result.availableFrom,
    availableTo: result.availableTo,
    connections: result.connections.map((conn) => ({
      id: conn.connectionId,
      store: conn.store,
      label: conn.label,
      rowCount: conn.rows.length,
      accountCount: conn.accounts.length,
    })),
    errors: result.errors,
    sources: [...sources, ...emptySources],
  };
}

/**
 * POST /api/advertising/windsor/preview
 *
 * Read-only. Shows what a full-available-data sync would change.
 * No date range is required: Windsor returns everything it holds.
 */
router.post("/windsor/preview", async (_req, res) => {
  try {
    const result = await fetchAllWindsorData();

    if (result.connections.length === 0) {
      return res.status(200).json({
        ...summarise(result),
        rows: [],
        totals: { sourceSpend: 0, spend: 0, clicks: 0, messages: 0 },
        created: 0,
        updated: 0,
        unchanged: 0,
        manual: { total: 0, count: 0 },
      });
    }

    const rows = result.connections.flatMap((c) => c.rows);

    // BOTH key formats: rows synced before the store segment existed still
    // live under the legacy key until the sync re-keys them, so preview must
    // count them as updates rather than new rows.
    const newKeys = rows.map((r) =>
      externalKeyFor(r.store, r.accountId, r.date, r.campaign),
    );
    const legacyKeys = rows.map((r) =>
      legacyExternalKeyFor(r.accountId, r.date, r.campaign),
    );
    const existing = await existingWindsorAmounts(newKeys, legacyKeys);

    let created = 0;
    let updated = 0;
    let unchanged = 0;

    const previewRows = rows.map((r) => {
      const key = externalKeyFor(r.store, r.accountId, r.date, r.campaign);
      const legacyKey = legacyExternalKeyFor(r.accountId, r.date, r.campaign);

      /* Mirror EXACTLY what the sync stores: round2 first, then AED -> USD,
         so "unchanged" here means the sync really will write the same
         amount. */
      const usd = aedToUsd(round2(r.spend));
      const stored = existing.get(key) ?? existing.get(legacyKey);

      if (stored === undefined) created += 1;
      else if (stored === usd) unchanged += 1;
      else updated += 1;

      return {
        store: r.store,
        accountId: r.accountId,
        accountName: r.accountName,
        accountStatus: r.accountStatus,
        date: r.date,
        campaign: r.campaign,
        sourceSpend: round2(r.spend),
        spend: usd,
        clicks: r.clicks,
        messages: r.messages,
        costPerMessage:
          r.costPerMessage === null ? null : round2(r.costPerMessage),
      };
    });

    const totals = previewRows.reduce(
      (acc, r) => ({
        sourceSpend: round2(acc.sourceSpend + r.sourceSpend),
        spend: round2(acc.spend + r.spend),
        clicks: acc.clicks + r.clicks,
        messages: acc.messages + r.messages,
      }),
      { sourceSpend: 0, spend: 0, clicks: 0, messages: 0 },
    );

    return res.status(200).json({
      ...summarise(result),
      rows: previewRows,
      totals,
      created,
      updated,
      unchanged,
      manual: await manualSpendTotal(),
    });
  } catch (error) {
    return windsorError(res, error);
  }
});

/**
 * POST /api/advertising/windsor/sync
 *
 * Stores the FULL available Windsor period for every configured connection.
 * Each row is keyed on
 *
 *     windsor | store | ad-account | date | campaign
 *
 * so the two Trendora ad accounts stay separate, and re-running the sync
 * updates those same documents instead of creating duplicates.
 *
 * MANUAL rows are never touched: every query pins `source: "windsor"`.
 */
router.post("/windsor/sync", async (_req, res) => {
  try {
    const result = await fetchAllWindsorData();
    const rows = result.connections.flatMap((c) => c.rows);

    if (rows.length === 0) {
      return res.status(200).json({
        ...summarise(result),
        created: 0,
        updated: 0,
        unchanged: 0,
        totalSourceSpend: 0,
        totalSpend: 0,
        totalMessages: 0,
        totalClicks: 0,
        rekeyed: 0,
        staleRemoved: 0,
        manual: await manualSpendTotal(),
      });
    }

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let rekeyed = 0;
    let staleRemoved = 0;

    for (const row of rows) {
      const externalKey = externalKeyFor(
        row.store,
        row.accountId,
        row.date,
        row.campaign,
      );

      /*
       * Rows synced BEFORE the store segment existed use the older key
       * `windsor|account|date|campaign`. Left alone they sit beside the new
       * rows and the SAME spend is counted twice.
       *
       *  - new key free  -> rename the old row onto it (no data change)
       *  - new key taken -> the two rows are the same campaign-day, so the
       *                      stale pre-store row is removed
       *
       * Only ever affects Windsor rows this feature created; manual rows
       * have no externalKey and are never touched.
       */
      const legacyKey = legacyExternalKeyFor(
        row.accountId,
        row.date,
        row.campaign,
      );

      /* Match the old key OR a row that lost its key entirely. */
      const legacyRow = await AdvertisingExpense.findOne(
        {
          source: WINDSOR_SOURCE,
          $or: [
            { externalKey: legacyKey },
            {
              externalKey: { $exists: false },
              accountId: row.accountId,
              campaign: row.campaign,
              date: new Date(`${row.date}T00:00:00.000Z`),
            },
          ],
        },
        // Correct projection (see existingWindsorKeys above): an options-style
        // object here would be read as a projection, not as options.
        { _id: 1, externalKey: 1 },
      );

      const legacyExists = legacyRow !== null;

      if (legacyExists) {
        const newKeyTaken = await AdvertisingExpense.exists({
          source: WINDSOR_SOURCE,
          externalKey,
        });

        if (newKeyTaken) {
          await AdvertisingExpense.deleteOne({ _id: legacyRow!._id });

          staleRemoved += 1;
        } else {
          await AdvertisingExpense.updateOne(
            { _id: legacyRow!._id },
            {
              $set: {
                externalKey,
                store: row.store,
                accountName: row.accountName || undefined,
                accountStatus: row.accountStatus || undefined,
              },
            },
          );

          rekeyed += 1;
        }
      }

      /* Windsor reports AED; the app does its maths in USD. Convert ONCE,
         here, so `amount` is USD for every report and insight from now on.
         The raw AED figure stays on the document for traceability. */
      const sourceAmount = round2(row.spend);
      const amount = aedToUsd(sourceAmount);

      // `as const` keeps the literal types, matching the model unions.
      const set = {
        amount,
        originalAmount: sourceAmount,
        originalCurrency: row.currency,
        date: new Date(`${row.date}T00:00:00.000Z`),
        campaign: row.campaign,
        platform: "Meta",
        source: "windsor",
        store: row.store,
        connectionId: row.connectionId,
        accountId: row.accountId || undefined,
        accountName: row.accountName || undefined,
        accountStatus: row.accountStatus || undefined,
        messages: row.messages,
        clicks: row.clicks,
      } as const;

      /*
       * One atomic upsert keyed on (source, externalKey): a repeat sync
       * updates the same document instead of inserting a duplicate.
       * includeResultMetadata distinguishes insert (created) from match.
       * `new: false` returns the PRE-image, so `value.amount` below is the
       * amount stored BEFORE this sync - which is what "unchanged" must be
       * compared against (with new: true the comparison always matched).
       */
      const updatedDoc = await AdvertisingExpense.findOneAndUpdate(
        { source: WINDSOR_SOURCE, externalKey },
        { $set: set, $setOnInsert: { externalKey } },
        {
          upsert: true,
          new: false,
          includeResultMetadata: true,
          setDefaultsOnInsert: true,
        },
      );

      if (updatedDoc.lastErrorObject?.updatedExisting === false) {
        created += 1;

        continue;
      }

      updated += 1;

      // "unchanged" = Windsor re-reported the identical stored amount.
      if (round2(updatedDoc.value?.amount ?? NaN) === amount) unchanged += 1;
    }

    return res.status(200).json({
      ...summarise(result),
      created,
      updated,
      unchanged,
      totalSourceSpend: round2(rows.reduce((s, r) => s + r.spend, 0)),
      totalSpend: round2(rows.reduce((s, r) => s + aedToUsd(round2(r.spend)), 0)),
      totalMessages: rows.reduce((s, r) => s + r.messages, 0),
      totalClicks: rows.reduce((s, r) => s + r.clicks, 0),
      rekeyed,
      staleRemoved,
      manual: await manualSpendTotal(),
    });
  } catch (error) {
    return windsorError(res, error);
  }
});

/* -------------------------------------------------------------------------- */
/* Insights - the all-time business advertising summary                       */
/* -------------------------------------------------------------------------- */

/** Safe division: returns null instead of NaN/Infinity. */
function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator === 0) return null;

  return numerator / denominator;
}

function roundedRatio(numerator: number, denominator: number): number | null {
  const value = ratio(numerator, denominator);

  return value === null ? null : round2(value);
}

/**
 * GET /api/advertising/insights
 *
 * The ALL-TIME business summary behind the Advertising overview. There is
 * deliberately no range parameter: every number covers ALL stored data.
 *
 *  - `grandTotal` : Windsor spend (USD, every ad account) + ALL manual
 *                   expenses. Accounts and manual never overlap, so nothing
 *                   is counted twice.
 *  - `accounts`   : Viora / Trendora — Facebook / Trendora — Instagram with
 *                   their own totals and campaigns, resolved through the
 *                   business-account directory (adAccounts.ts).
 *  - `manual`     : manual expenses broken out on their own.
 *
 * Reports does NOT depend on this endpoint - it runs its own aggregation.
 */
router.get("/insights", async (_req, res) => {
  try {
    const [accountAgg, campaignAgg, manualAgg] = await Promise.all([
      // Per ad account, ALL time. Pinned sort: $group output order is
      // unspecified, and refetches must be byte-identical.
      AdvertisingExpense.aggregate([
        { $match: { source: "windsor" } },
        {
          $group: {
            _id: { store: "$store", accountId: "$accountId" },
            spend: { $sum: "$amount" },
            messages: { $sum: { $ifNull: ["$messages", 0] } },
            clicks: { $sum: { $ifNull: ["$clicks", 0] } },
          },
        },
        { $sort: { spend: -1, _id: 1 } },
      ]),

      // Per campaign, ALL time.
      AdvertisingExpense.aggregate([
        { $match: { source: "windsor" } },
        {
          $group: {
            _id: {
              store: "$store",
              accountId: "$accountId",
              campaign: "$campaign",
            },
            spend: { $sum: "$amount" },
            messages: { $sum: { $ifNull: ["$messages", 0] } },
            clicks: { $sum: { $ifNull: ["$clicks", 0] } },
          },
        },
        { $sort: { spend: -1, "_id.campaign": 1 } },
      ]),

      // ALL manual expenses (missing `source` = written before the field
      // existed, which also means manual).
      AdvertisingExpense.aggregate([
        { $match: { source: { $in: [null, "manual"] } } },
        { $group: { _id: null, spend: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
    ]);

    type Bucket = {
      spend: number;
      messages: number;
      clicks: number;
      campaigns: Array<{
        campaign: string;
        spend: number;
        messages: number;
        clicks: number;
        costPerMessage: number | null;
      }>;
    };

    const emptyBucket = (): Bucket => ({
      spend: 0,
      messages: 0,
      clicks: 0,
      campaigns: [],
    });

    /*
     * The three business accounts always exist - even at zero - so every card
     * renders without special cases; the fallback bucket joins in only when
     * an unmapped ad account actually holds data.
     */
    const buckets = new Map<BusinessAccountKey, Bucket>(
      BUSINESS_ACCOUNT_KEYS.map(
        (key): [BusinessAccountKey, Bucket] => [key, emptyBucket()],
      ),
    );

    const bucketFor = (store: unknown, accountId: unknown): Bucket => {
      const key = resolveBusinessAccount(
        typeof store === "string" ? store : null,
        typeof accountId === "string" ? accountId : null,
      );

      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = emptyBucket();
        buckets.set(key, bucket);
      }

      return bucket;
    };

    type AccountAggRow = {
      _id: { store: string | null; accountId: string | null };
      spend: number;
      messages: number;
      clicks: number;
    };

    type CampaignAggRow = {
      _id: {
        store: string | null;
        accountId: string | null;
        campaign: string | null;
      };
      spend: number;
      messages: number;
      clicks: number;
    };

    for (const row of accountAgg as AccountAggRow[]) {
      const bucket = bucketFor(row._id.store, row._id.accountId);

      bucket.spend += row.spend;
      bucket.messages += row.messages ?? 0;
      bucket.clicks += row.clicks ?? 0;
    }

    for (const row of campaignAgg as CampaignAggRow[]) {
      bucketFor(row._id.store, row._id.accountId).campaigns.push({
        campaign: typeof row._id.campaign === "string" ? row._id.campaign : "",
        spend: round2(row.spend),
        messages: row.messages ?? 0,
        clicks: row.clicks ?? 0,
        costPerMessage: roundedRatio(row.spend, row.messages ?? 0),
      });
    }

    // Fixed display order; the fallback bucket appears only when used.
    const accounts = ALL_ACCOUNT_KEYS.filter((key) => buckets.has(key)).map(
      (key) => {
        const bucket = buckets.get(key)!;

        // Highest spend first; the campaign name breaks every tie so the
        // response is fully deterministic across refetches.
        bucket.campaigns.sort(
          (a, b) => b.spend - a.spend || a.campaign.localeCompare(b.campaign),
        );

        return {
          key,
          spend: round2(bucket.spend),
          messages: Math.round(bucket.messages),
          clicks: Math.round(bucket.clicks),
          costPerMessage: roundedRatio(bucket.spend, bucket.messages),
          campaignCount: bucket.campaigns.length,
          campaigns: bucket.campaigns,
        };
      },
    );

    const manualSpend = round2(manualAgg[0]?.spend ?? 0);

    /*
     * THE advertising pool: every Windsor account + ALL manual entries.
     * Built from the already-rounded account totals so the grand total is
     * exactly the sum of the numbers shown on screen - manual rows live
     * outside every account bucket, so nothing can be counted twice.
     */
    const windsorSpend = round2(
      accounts.reduce((sum, account) => sum + account.spend, 0),
    );

    return res.status(200).json({
      grandTotal: round2(windsorSpend + manualSpend),
      manual: { spend: manualSpend, count: manualAgg[0]?.count ?? 0 },
      accounts,
    });
  } catch (error) {
    console.error("Failed to fetch advertising insights:", error);

    return res.status(500).json({ message: "Failed to fetch insights" });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/advertising/:id/products - products linked to this campaign       */
/* -------------------------------------------------------------------------- */

router.get("/:id/products", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: "Invalid campaign ID" });
  }

  const campaignId = new mongoose.Types.ObjectId(req.params.id);

  try {
    const campaign = await AdvertisingExpense.findById(campaignId).lean();

    if (!campaign) {
      return res.status(404).json({ message: "Campaign not found" });
    }

    /*
      Ad campaigns are IMPLICIT because there is no campaign collection:
      a campaign is (store, accountId, campaignName) rows in
      advertisingexpenses. A campaign collection would need to be frozen in
      time to be safe (rename/merge = audit disaster), so everything reads
      from advertisingexpenses - the same source the historical report uses
      and the same place owners update.
    */
    const key = campaignKeyFor(
      campaign.store,
      campaign.accountId ?? "",
      campaign.campaign ?? "",
    );

    const products = await Product.find({
      "campaigns.key": key,
    })
      .select("name category imageUrl price stock")
      .lean();

    const productsWithLinks = products.map((product) => {
      const ref = (product.campaigns ?? []).find(
        (c) => c.key === key,
      );

      return {
        product: {
          _id: product._id.toString(),
          name: product.name,
          category: product.category,
          imageUrl: product.imageUrl ?? null,
          price: product.price,
          cost: product.cost,
          stock: product.stock,
        },
        linkedAt: campaign.createdAt,
        link: ref
          ? { key: ref.key, store: ref.store, accountId: ref.accountId, campaign: ref.campaign }
          : null,
      };
    });

    return res.status(200).json({
      campaign: {
        _id: campaign._id.toString(),
        store: campaign.store,
        accountId: campaign.accountId,
        campaign: campaign.campaign,
        accountName: campaign.accountName,
        platform: campaign.platform,
        createdAt: campaign.createdAt,
        updatedAt: campaign.updatedAt,
      },
      products: productsWithLinks,
    });
  } catch (error) {
    console.error("Failed to fetch campaign products:", error);

    return res.status(500).json({
      message: "Failed to fetch campaign products",
    });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/advertising/:id/products - products linked to this campaign       */
/* -------------------------------------------------------------------------- */

router.get("/:id/products", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: "Invalid campaign ID" });
  }

  const campaignId = new mongoose.Types.ObjectId(req.params.id);

  try {
    const campaign = await AdvertisingExpense.findById(campaignId).lean();

    if (!campaign) {
      return res.status(404).json({ message: "Campaign not found" });
    }

    /*
      Ad campaigns are IMPLICIT because there is no campaign collection:
      a campaign is (store, accountId, campaignName) rows in
      advertisingexpenses. A campaign collection would need to be frozen in
      time to be safe (rename/merge = audit disaster), so everything reads
      from advertisingexpenses - the same source the historical report uses
      and the same place owners update.
    */
    const key = campaignKeyFor(
      campaign.store,
      campaign.accountId ?? "",
      campaign.campaign ?? "",
    );

    const products = await Product.find({
      "campaigns.key": key,
    })
      .select("name category imageUrl price stock")
      .lean();

    const productsWithLinks = products.map((product) => {
      const ref = (product.campaigns ?? []).find(
        (c) => c.key === key,
      );

      return {
        product: {
          _id: product._id.toString(),
          name: product.name,
          category: product.category,
          imageUrl: product.imageUrl ?? null,
          price: product.price,
          cost: product.cost,
          stock: product.stock,
        },
        linkedAt: campaign.createdAt,
        link: ref
          ? { key: ref.key, store: ref.store, accountId: ref.accountId, campaign: ref.campaign }
          : null,
      };
    });

    return res.status(200).json({
      campaign: {
        _id: campaign._id.toString(),
        store: campaign.store,
        accountId: campaign.accountId,
        campaign: campaign.campaign,
        accountName: campaign.accountName,
        platform: campaign.platform,
        createdAt: campaign.createdAt,
        updatedAt: campaign.updatedAt,
      },
      products: productsWithLinks,
    });
  } catch (error) {
    console.error("Failed to fetch campaign products:", error);

    return res.status(500).json({
      message: "Failed to fetch campaign products",
    });
  }
});


/**
 * POST /api/advertising/performance
 *
 * Period-scoped ad analytics behind the Advertising page's funnel and
 * performance verdicts. `range` is `7` or `30` and selects the Beirut
 * business window (same helper as the reports endpoint), so the verdicts
 * always answer "for the last N days".
 *
 *   - delivered orders / product profit come from Delivered orders only;
 *   - ad spend and messages come from every stored advertising row in the
 *     window (manual + Windsor, counted exactly once each);
 *   - the verdict compares cost-per-order against profit-per-order, so the
 *     owner sees at a glance whether the ads are paying for themselves.
 */
router.post("/performance", async (req, res) => {
  try {
    const range = Number(req.query.range);
    const parsedRange = range === 7 || range === 30 ? range : 7;

    // Beirut midnight "today", expressed as a real UTC instant.
    const startOfToday = startOfDayInTimeZone(new Date(), TIMEZONE);

    // First day of the window (range - 1 days ago, inclusive).
    const startOfWindow = startOfWindowForRange(parsedRange);

    /* ------------------------------------------------------------------ */
    /* Delivered orders in the window (product sales + profit).           */
    /* ------------------------------------------------------------------ */
    const orderAgg = await Order.aggregate([
      {
        $match: {
          status: "Delivered",
          createdAt: { $gte: startOfWindow },
        },
      },
      {
        $group: {
          _id: null,
          deliveredOrders: { $sum: 1 },
          productSales: { $sum: "$total" },
          productProfit: { $sum: "$profit" },
        },
      },
    ]);

    const orders = orderAgg[0] ?? {
      deliveredOrders: 0,
      productSales: 0,
      productProfit: 0,
    };

    /* ------------------------------------------------------------------ */
    /* Advertising rows in the window (manual + Windsor, exactly once).   */
    /* ------------------------------------------------------------------ */
    const advertisingAgg = await AdvertisingExpense.aggregate([
      { $match: { date: { $gte: startOfWindow } } },
      {
        $group: {
          _id: null,
          spend: { $sum: "$amount" },
          messages: { $sum: { $ifNull: ["$messages", 0] } },
        },
      },
    ]);

    const ads = advertisingAgg[0] ?? { spend: 0, messages: 0 };

    const accountAgg = await AdvertisingExpense.aggregate([
      { $match: { date: { $gte: startOfWindow } } },
      {
        $group: {
          _id: { store: "$store", accountId: "$accountId" },
          spend: { $sum: "$amount" },
          messages: { $sum: { $ifNull: ["$messages", 0] } },
        },
      },
      { $sort: { spend: -1, _id: 1 } },
    ]);

    const buckets = new Map<BusinessAccountKey, { spend: number; messages: number }>(
      BUSINESS_ACCOUNT_KEYS.map((k) => [k, { spend: 0, messages: 0 }]),
    );

    for (const row of accountAgg as Array<{
      _id: { store: string | null; accountId: string | null };
      spend: number;
      messages: number;
    }>) {
      const key = resolveBusinessAccount(row._id.store, row._id.accountId);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.spend += row.spend;
        bucket.messages += row.messages;
      }
    }

    const accounts = ALL_ACCOUNT_KEYS.filter((key) => buckets.has(key)).map(
      (key) => ({
        key,
        spend: round2((buckets.get(key) ?? { spend: 0, messages: 0 }).spend),
        messages: Math.round((buckets.get(key) ?? { spend: 0, messages: 0 }).messages),
        accountId: null,
        accountStatus: "",
      }),
    );

    const dailyAdSpend = new Map<string, number>();
    const dailyAdMessages = new Map<string, number>();

    const dailyRows = await AdvertisingExpense.find({
      date: { $gte: startOfWindow },
    }).lean();

    for (const row of dailyRows as Array<{
      date?: Date | string;
      amount: number;
      messages?: number;
    }>) {
      if (row.date) {
        const date =
          typeof row.date === "string" ? new Date(row.date) : row.date;
        if (!Number.isNaN(date.getTime())) {
          const key = dayKeyFormatter.format(date);
          dailyAdSpend.set(
            key,
            round2((dailyAdSpend.get(key) ?? 0) + Number(row.amount)),
          );
          dailyAdMessages.set(
            key,
            (dailyAdMessages.get(key) ?? 0) + Number(row.messages ?? 0),
          );
        }
      }
    }

    /* ------------------------------------------------------------------ */
    /* Verdict: is the advertising paying for itself?                     */
    /* ------------------------------------------------------------------ */
    // Cost per delivered order vs. profit per delivered order. Both come
    // back as null (not NaN/Infinity) when a denominator is zero.
    const profitPerOrder = roundedRatio(
      orders.productProfit,
      orders.deliveredOrders,
    );
    const costPerOrder = roundedRatio(ads.spend, orders.deliveredOrders);

    let verdict: "scale" | "watch" | "losing" | "noData" = "noData";
    let reason: "noAdSpend" | "noProfitBaseline" | "noDeliveredOrders" | null =
      null;

    if (ads.spend === 0) {
      verdict = "noData";
      reason = "noAdSpend";
    } else if (orders.productProfit <= 0) {
      verdict = "noData";
      reason = "noProfitBaseline";
    } else if (orders.deliveredOrders === 0) {
      verdict = "noData";
      reason = "noDeliveredOrders";
    } else if (costPerOrder === null || profitPerOrder === null) {
      verdict = "noData";
      reason = "noProfitBaseline";
    } else if (costPerOrder < profitPerOrder / 2) {
      // Ads cost less than half of what each order earns -> safe to scale.
      verdict = "scale";
    } else if (costPerOrder <= profitPerOrder) {
      // Ads cost between half and all of each order's profit.
      verdict = "watch";
    } else {
      // Ads cost more than each order earns.
      verdict = "losing";
    }

    return res.status(200).json({
      range: parsedRange,
      summary: {
        deliveredOrders: orders.deliveredOrders,
        productSales: round2(orders.productSales),
        productProfit: round2(orders.productProfit),
        adSpend: round2(ads.spend),
        adMessages: ads.messages,
        adCount: await AdvertisingExpense.countDocuments({
          date: { $gte: startOfWindow },
        }),
      },
      financials: {
        productSales: round2(orders.productSales),
        productProfit: round2(orders.productProfit),
        adSpend: round2(ads.spend),
        adMessages: ads.messages,
        netProfitAfterAds: round2(orders.productProfit - ads.spend),
      },
      verdict: {
        type: verdict,
        reason,
        costPerOrder,
        profitPerOrder,
        breakEvenPerOrder: roundedRatio(ads.spend, orders.productProfit),
        adSpentPerMessage: roundedRatio(ads.spend, ads.messages),
      },
      accounts,
      dailyAdSpend: [...dailyAdSpend.entries()]
        .map(([date, spend]) => ({ date, spend }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      dailyAdMessages: [...dailyAdMessages.entries()]
        .map(([date, messages]) => ({ date, messages }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      availableTo: dayKeyFormatter.format(startOfToday),
    });
  } catch (error) {
    console.error("Failed to fetch ad performance:", error);
    return res.status(500).json({ message: "Failed to fetch ad performance" });
  }
});

export default router;
