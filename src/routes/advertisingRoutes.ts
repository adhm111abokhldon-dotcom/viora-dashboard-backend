import { Router, type Response } from "express";
import mongoose from "mongoose";
import type { QueryFilter } from "mongoose";
import AdvertisingExpense, {
  type IAdvertisingExpense,
} from "../models/AdvertisingExpense.js";
import {
  createAdvertisingExpenseSchema,
  updateAdvertisingExpenseSchema,
} from "../schemas/advertisingSchemas.js";
import { round2 } from "../lib/money.js";
import {
  AED_PER_USD,
  AED_PER_USD_LABEL,
  aedToUsd,
  WINDSOR_SOURCE_CURRENCY,
} from "../lib/currency.js";
import {
  WindsorError,
  configuredConnections,
  externalKeyFor,
  fetchAllWindsorData,
  legacyExternalKeyFor,
} from "../lib/windsor.js";

import {
  getProductTotalsFrom,
  startOfWindowForRange,
} from "../lib/orderTotals.js";

const router = Router();

/** Keep listing queries bounded, mirroring productRoutes.ts. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 10;

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

    const filter: QueryFilter<IAdvertisingExpense> = {};

    const range = parseRange(req.query as Record<string, unknown>);
    if (range) filter.date = range;

    if (platform) filter.platform = platform;

    const skip = (page - 1) * limit;

    const [expenses, totalExpenses, summaryRows, platforms] = await Promise.all([
      AdvertisingExpense.find(filter)
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      AdvertisingExpense.countDocuments(filter),

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

      AdvertisingExpense.aggregate([
        { $match: filter },
        {
          $group: {
            _id: "$platform",
            total: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
        { $sort: { total: -1 } },
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
        byPlatform: platforms.map((row) => ({
          platform: row._id,
          total: round2(row.total),
          count: row.count,
        })),
      },
    });
  } catch (error) {
    console.error("Failed to fetch advertising expenses:", error);

    return res
      .status(500)
      .json({ message: "Failed to fetch advertising expenses" });
  }
});

/** GET /api/advertising/platforms - distinct platforms already in use. */
router.get("/platforms", async (_req, res) => {
  try {
    const platforms = await AdvertisingExpense.distinct("platform");

    return res.status(200).json({
      platforms: platforms
        .filter(
          (value): value is string =>
            typeof value === "string" && value.length > 0,
        )
        .sort((a, b) => a.localeCompare(b)),
    });
  } catch (error) {
    console.error("Failed to fetch advertising platforms:", error);

    return res.status(500).json({ message: "Failed to fetch platforms" });
  }
});

/** GET /api/advertising/summary - spend inside a business-date window. */
router.get("/summary", async (req, res) => {
  try {
    const daysParam = Number(req.query.days);
    const days = [7, 30, 90].includes(daysParam) ? daysParam : 30;

    const range = parseRange(req.query as Record<string, unknown>);

    const filter: QueryFilter<IAdvertisingExpense> = range
      ? { date: range }
      : { date: { $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) } };

    const rows = await AdvertisingExpense.aggregate([
      { $match: filter },
      {
        $group: {
          _id: "$platform",
          total: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
      { $sort: { total: -1 } },
    ]);

    const totalSpend = rows.reduce((sum, row) => sum + row.total, 0);

    return res.status(200).json({
      days,
      totalSpend: round2(totalSpend),
      expenseCount: rows.reduce((sum, row) => sum + row.count, 0),
      byPlatform: rows.map((row) => ({
        platform: row._id,
        total: round2(row.total),
        count: row.count,
      })),
    });
  } catch (error) {
    console.error("Failed to fetch advertising summary:", error);

    return res
      .status(500)
      .json({ message: "Failed to fetch advertising summary" });
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

/** Already-stored Windsor externalKeys, so preview can count create vs update. */
async function existingWindsorKeys(keys: string[]) {
  const rows = await AdvertisingExpense.find(
    { source: WINDSOR_SOURCE, externalKey: { $in: keys } },
    { projection: { externalKey: 1 } },
  ).lean();

  return new Set(rows.map((row) => row.externalKey));
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
    const keys = rows.map((r) =>
      externalKeyFor(r.store, r.accountId, r.date, r.campaign),
    );
    const existing = await existingWindsorKeys(keys);

    let created = 0;
    let updated = 0;

    const previewRows = rows.map((r) => {
      const key = externalKeyFor(r.store, r.accountId, r.date, r.campaign);
      if (existing.has(key)) updated += 1;
      else created += 1;

      return {
        store: r.store,
        accountId: r.accountId,
        accountName: r.accountName,
        accountStatus: r.accountStatus,
        date: r.date,
        campaign: r.campaign,
        sourceSpend: round2(r.spend),
        spend: aedToUsd(r.spend),
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
      unchanged: 0,
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
        { projection: { _id: 1, externalKey: 1 } },
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
       */
      const updatedDoc = await AdvertisingExpense.findOneAndUpdate(
        { source: WINDSOR_SOURCE, externalKey },
        { $set: set, $setOnInsert: { externalKey } },
        {
          upsert: true,
          new: true,
          includeResultMetadata: true,
          setDefaultsOnInsert: true,
        },
      );

      if (updatedDoc.lastErrorObject?.updatedExisting === false) {
        created += 1;

        continue;
      }

      updated += 1;

      // "unchanged" = Windsor re-reported identical numbers.
      if (round2(updatedDoc.value?.amount ?? NaN) === amount) unchanged += 1;
    }

    return res.status(200).json({
      ...summarise(result),
      created,
      updated,
      unchanged,
      totalSourceSpend: round2(rows.reduce((s, r) => s + r.spend, 0)),
      totalSpend: round2(rows.reduce((s, r) => s + aedToUsd(r.spend), 0)),
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
/* Insights                                                                   */
/* -------------------------------------------------------------------------- */

function connectionLabelFor(id: string): string {
  return (
    configuredConnections().find((c) => c.id === id)?.label ?? id
  );
}

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

type Verdict = "scale" | "watch" | "losing" | "noData";

/**
 * scale  -> costPerOrder < 0.5 * profitPerOrderBeforeAds
 * watch  -> between 0.5x and 1x
 * losing -> above 1x
 * noData -> no delivered orders, or no ad spend in the window
 */
export function resolveVerdict(input: {
  costPerOrder: number | null;
  profitPerOrderBeforeAds: number | null;
  deliveredOrders: number;
  adSpend: number;
}): { verdict: Verdict; reason: string } {
  const { costPerOrder, profitPerOrderBeforeAds, deliveredOrders, adSpend } =
    input;

  if (deliveredOrders === 0) return { verdict: "noData", reason: "noDeliveredOrders" };
  if (adSpend === 0) return { verdict: "noData", reason: "noAdSpend" };

  if (
    costPerOrder === null ||
    profitPerOrderBeforeAds === null ||
    profitPerOrderBeforeAds <= 0
  ) {
    return { verdict: "noData", reason: "noProfitBaseline" };
  }

  const ratioValue = costPerOrder / profitPerOrderBeforeAds;

  if (ratioValue < 0.5) return { verdict: "scale", reason: "" };
  if (ratioValue <= 1) return { verdict: "watch", reason: "" };

  return { verdict: "losing", reason: "" };
}

/** Per-store / per-ad-account breakdown from stored rows (all available data). */
async function sourceBreakdown() {
  const rows = await AdvertisingExpense.aggregate([
    { $match: { source: "windsor" } },
    {
      $group: {
        _id: {
          store: "$store",
          connectionId: "$connectionId",
          accountId: "$accountId",
          accountName: "$accountName",
          accountStatus: "$accountStatus",
        },
        spend: { $sum: "$amount" },
        sourceSpend: { $sum: { $ifNull: ["$originalAmount", 0] } },
        messages: { $sum: { $ifNull: ["$messages", 0] } },
        clicks: { $sum: { $ifNull: ["$clicks", 0] } },
        from: { $min: "$date" },
        to: { $max: "$date" },
        rowCount: { $sum: 1 },
      },
    },
  ]);

  const toDateOnly = (d?: Date) => (d ? d.toISOString().slice(0, 10) : null);

  return rows.map(
    (r: {
      _id: {
        store: string;
        connectionId: string;
        accountId: string;
        accountName: string;
        accountStatus: string;
      };
      spend: number;
      sourceSpend: number;
      messages: number;
      clicks: number;
      from: Date;
      to: Date;
      rowCount: number;
    }) => ({
      store: r._id.store,
      connectionId: r._id.connectionId,
      accountLabel: connectionLabelFor(r._id.connectionId),
      accountId: r._id.accountId,
      accountName: r._id.accountName,
      accountStatus: r._id.accountStatus,
      from: toDateOnly(r.from),
      to: toDateOnly(r.to),
      rowCount: r.rowCount,
      sourceSpend: round2(r.sourceSpend),
      spend: round2(r.spend),
      messages: r.messages ?? 0,
      clicks: r.clicks ?? 0,
      costPerMessage: roundedRatio(r.spend, r.messages ?? 0),
    }),
  );
}

/** Campaign breakdown from stored Windsor rows, worst cost-per-message first. */
async function campaignBreakdown() {
  const rows = await AdvertisingExpense.aggregate([
    { $match: { source: "windsor" } },
    {
      $group: {
        _id: {
          store: "$store",
          accountId: "$accountId",
          accountName: "$accountName",
          campaign: "$campaign",
        },
        spend: { $sum: "$amount" },
        sourceSpend: { $sum: { $ifNull: ["$originalAmount", 0] } },
        messages: { $sum: { $ifNull: ["$messages", 0] } },
        clicks: { $sum: { $ifNull: ["$clicks", 0] } },
      },
    },
  ]);

  const items = rows.map(
    (row: {
      _id: { store: string; accountId: string; accountName: string; campaign: string };
      spend: number;
      sourceSpend: number;
      messages: number;
      clicks: number;
    }) => ({
      store: row._id.store,
      accountId: row._id.accountId,
      accountName: row._id.accountName,
      campaign: row._id.campaign,
      spend: round2(row.spend),
      sourceSpend: round2(row.sourceSpend),
      messages: row.messages ?? 0,
      clicks: row.clicks ?? 0,
      costPerMessage: roundedRatio(row.spend, row.messages ?? 0),
    }),
  );

  const totals = items.reduce(
    (acc, i) => ({ spend: acc.spend + i.spend, messages: acc.messages + i.messages }),
    { spend: 0, messages: 0 },
  );

  const average = roundedRatio(totals.spend, totals.messages);

  return items
    .map((item) => ({
      ...item,
      flagged:
        item.costPerMessage !== null &&
        average !== null &&
        item.costPerMessage > round2(average * 1.5),
    }))
    .sort((a, b) => {
      if (a.costPerMessage === null && b.costPerMessage === null) return 0;
      if (a.costPerMessage === null) return 1;
      if (b.costPerMessage === null) return -1;

      return b.costPerMessage - a.costPerMessage;
    });
}

/**
 * GET /api/advertising/insights?range=7|30
 *
 * Two clearly separated sections:
 *
 *  - `windsor`  : ALL available Windsor data (no artificial 7/30 limit).
 *  - `manual`   : ALL manual expenses (already USD).
 *  - `total`    : windsor + manual, the single advertising pool.
 *  - `funnel`   : period-scoped order/profit comparison. `range` only affects
 *                 THIS section, because delivered orders are a windowed fact.
 *
 * `total.adSpend` is what Reports uses for "Net Profit After Ads".
 */
router.get("/insights", async (req, res) => {
  const range = req.query.range === "30" ? 30 : 7;

  try {
    const startOfWindow = startOfWindowForRange(range);

    const [totals, adRows, campaigns, periodRows, manualAgg, windsorPeriod, allDates] =
      await Promise.all([
        getProductTotalsFrom(startOfWindow),

        // ALL Windsor + ALL manual, no date filter.
        AdvertisingExpense.aggregate([
          {
            $group: {
              _id: {
                $cond: [{ $eq: ["$source", "windsor"] }, "windsor", "manual"],
              },
              spend: { $sum: "$amount" },
              sourceSpend: { $sum: { $ifNull: ["$originalAmount", 0] } },
              messages: { $sum: { $ifNull: ["$messages", 0] } },
              clicks: { $sum: { $ifNull: ["$clicks", 0] } },
            },
          },
        ]),

        campaignBreakdown(),

        // Same period as the funnel, for messages/orders in that window.
        AdvertisingExpense.aggregate([
          { $match: { source: "windsor", date: { $gte: startOfWindow } } },
          {
            $group: {
              _id: null,
              messages: { $sum: { $ifNull: ["$messages", 0] } },
              clicks: { $sum: { $ifNull: ["$clicks", 0] } },
              spend: { $sum: "$amount" },
            },
          },
        ]),

        // Manual spend inside the window, for the period comparison only.
        AdvertisingExpense.aggregate([
          {
            $match: {
              source: { $in: [null, "manual"] },
              date: { $gte: startOfWindow },
            },
          },
          { $group: { _id: null, spend: { $sum: "$amount" } } },
        ]),

        // Earliest/latest date actually stored for Windsor.
        AdvertisingExpense.aggregate([
          { $match: { source: "windsor" } },
          { $group: { _id: null, from: { $min: "$date" }, to: { $max: "$date" } } },
        ]),

        AdvertisingExpense.aggregate([
          { $match: { source: { $in: [null, "manual"] } } },
          { $group: { _id: null, spend: { $sum: "$amount" }, count: { $sum: 1 } } },
        ]),
      ]);

    const bySource = new Map(
      adRows.map(
        (r: { _id: string; spend: number; sourceSpend: number; messages: number; clicks: number }) =>
          [r._id, r],
      ),
    );

    const manual = bySource.get("manual");
    const windsor = bySource.get("windsor");

    const windsorSpend = round2(windsor?.spend ?? 0);
    const manualSpend = round2(manual?.spend ?? 0);

    /* THE advertising pool: Windsor (USD) + Manual (USD). */
    const adSpend = round2(windsorSpend + manualSpend);

    const messages = Math.round(windsor?.messages ?? 0);
    const clicks = Math.round(windsor?.clicks ?? 0);

    const deliveredOrders = totals.deliveredOrders;
    const profitBeforeAds = round2(totals.productProfit);

    const profitPerOrder = roundedRatio(profitBeforeAds, deliveredOrders);

    const { verdict, reason } = resolveVerdict({
      costPerOrder: roundedRatio(adSpend, deliveredOrders),
      profitPerOrderBeforeAds: profitPerOrder,
      deliveredOrders,
      adSpend,
    });

    const period = periodRows[0] ?? { messages: 0, clicks: 0, spend: 0 };
    const periodAdSpend = round2(period.spend + (manualAgg[0]?.spend ?? 0));

    const stored = windsorPeriod[0];

    const toDateOnly = (d?: Date) =>
      d ? d.toISOString().slice(0, 10) : null;

    return res.status(200).json({
      rate: AED_PER_USD_LABEL,
      sourceCurrency: WINDSOR_SOURCE_CURRENCY,

      /** Actual period Windsor has delivered, from the stored rows. */
      availablePeriod: {
        from: toDateOnly(stored?.from),
        to: toDateOnly(stored?.to),
      },

      connections: configuredConnections(),

      windsor: {
        spend: windsorSpend,
        sourceSpend: round2(windsor?.sourceSpend ?? 0),
        messages,
        clicks,
        costPerMessage: roundedRatio(windsorSpend, messages),
      },

      manual: { spend: manualSpend, count: manualAgg[0]?.count ?? 0 },

      total: {
        adSpend,
        costPerMessage: roundedRatio(windsorSpend, messages),
      },

      /** Period-scoped funnel. range only affects this block. */
      funnel: {
        range,
        adSpend: periodAdSpend,
        windsorSpend: round2(period.spend),
        manualSpend: round2(manualAgg[0]?.spend ?? 0),
        messages: Math.round(period.messages ?? 0),
        clicks: Math.round(period.clicks ?? 0),
        costPerMessage: roundedRatio(windsorSpend, period.messages ?? 0),
        deliveredOrders,
        profitBeforeAds,
        costPerOrder: roundedRatio(periodAdSpend, deliveredOrders),
        profitPerOrderBeforeAds: profitPerOrder,
        messageToOrderRate: roundedRatio(deliveredOrders, period.messages ?? 0),
        breakEvenCostPerOrder: profitPerOrder,
        breakEvenCostPerMessage:
          profitPerOrder !== null && ratio(deliveredOrders, period.messages ?? 0) !== null
            ? round2(profitPerOrder * ratio(deliveredOrders, period.messages ?? 0)!)
            : null,
        verdict,
        verdictReason: reason,
      },

      sources: await sourceBreakdown(),
      campaigns,
    });
  } catch (error) {
    console.error("Failed to fetch advertising insights:", error);

    return res.status(500).json({ message: "Failed to fetch insights" });
  }
});

export default router;
