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
  BUSINESS_ACCOUNT_KEYS,
  accountFilter,
  campaignKeyFor,
  excludeUnmappedWindsorAccountsFilter,
  isBusinessAccountConfigured,
  isAccountKey,
  isKnownBusinessAccount,
  parseCampaignKey,
  resolveBusinessAccount,
  type BusinessAccountKey,
} from "../lib/adAccounts.js";
import Product from "../models/Product.js";
import { revalueCampaignAllocationSnapshot } from "../lib/campaignAllocation.js";
import WindsorSyncState from "../models/WindsorSyncState.js";
import { captureMissingCampaignAllocations } from "../lib/advertisingAllocationSnapshots.js";
import {
  emptyCampaignCatalogStateCounts,
  getCampaignCatalogState,
  getCampaignProviderState,
  type CampaignCatalogState,
  type CampaignCatalogStateCounts,
} from "../lib/campaignState.js";

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
    if (key === null) continue;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.spend += row.amount;
      bucket.messages += row.messages ?? 0;
    }
  }

  return BUSINESS_ACCOUNT_KEYS.filter((key) => buckets.has(key)).map((key) => ({
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

router.get("/campaigns", async (req, res) => {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? DEFAULT_LIMIT);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIMIT ||
    !Number.isSafeInteger((page - 1) * limit)
  ) {
    return badRequest(res, "Invalid pagination parameters");
  }

  const search = String(req.query.search ?? "").trim();
  const accountKey =
    typeof req.query.accountKey === "string" ? req.query.accountKey : null;
  if (accountKey && !isAccountKey(accountKey)) {
    return badRequest(res, "Invalid advertising account");
  }

  try {
    const match: Record<string, unknown> = {
      source: "windsor",
      store: { $in: ["viora", "trendora"] },
      campaign: { $type: "string", $ne: "" },
      ...excludeUnmappedWindsorAccountsFilter(),
    };
    if (accountKey && isAccountKey(accountKey)) {
      match.$and = [accountFilter(accountKey)];
    }
    const [groupedRows, syncStates] = await Promise.all([
      AdvertisingExpense.aggregate<{
        _id: { store?: string; accountId?: string; campaign: string };
        spend: number;
        allocatedSpend: number;
        unallocatedSpend: number;
        messages: number;
        clicks: number;
        platform: string;
        accountName?: string;
        campaignEffectiveStatus?: string | null;
        campaignConfiguredStatus?: string | null;
        firstActivity?: Date | null;
        lastActivity?: Date | null;
        lastSeenAt?: Date | null;
      }>([
        { $match: match },
        { $sort: { lastSeenAt: 1, date: 1, _id: 1 } },
        {
          $group: {
            _id: {
              store: "$store",
              accountId: "$accountId",
              campaign: "$campaign",
            },
            spend: { $sum: "$amount" },
            allocatedSpend: {
              $sum: { $ifNull: ["$allocationSnapshot.allocatedSpend", 0] },
            },
            unallocatedSpend: {
              $sum: {
                $ifNull: [
                  "$allocationSnapshot.unallocatedSpend",
                  "$amount",
                ],
              },
            },
            messages: { $sum: { $ifNull: ["$messages", 0] } },
            clicks: { $sum: { $ifNull: ["$clicks", 0] } },
            platform: { $first: "$platform" },
            accountName: { $first: "$accountName" },
            campaignEffectiveStatus: { $last: "$campaignEffectiveStatus" },
            campaignConfiguredStatus: { $last: "$campaignConfiguredStatus" },
            firstActivity: { $min: "$date" },
            lastActivity: { $max: "$date" },
            lastSeenAt: { $max: "$lastSeenAt" },
          },
        },
        ...(search
          ? [
              {
                $match: {
                  "_id.campaign": {
                    $regex: escapeRegex(search),
                    $options: "i",
                  },
                },
              },
            ]
          : []),
        {
          $sort: {
            spend: -1,
            "_id.store": 1,
            "_id.accountId": 1,
            "_id.campaign": 1,
          },
        },
      ]),
      WindsorSyncState.find().lean(),
    ]);

    const lastSyncByStore = new Map(
      syncStates.map((state) => [
        state.connectionId === "viora-windsor" ? "viora" : "trendora",
        state.lastSuccessfulSyncAt,
      ]),
    );
    const allCampaigns = groupedRows.flatMap((row) => {
      const { store, accountId, campaign } = row._id;
      if (
        (store !== "viora" && store !== "trendora") ||
        !accountId ||
        !isKnownBusinessAccount(store, accountId)
      ) {
        return [];
      }
      const key = campaignKeyFor(store, accountId, campaign);
      const lastSync = lastSyncByStore.get(store);
      const lastSeenAt = row.lastSeenAt ?? null;
      const providerState = getCampaignProviderState(lastSeenAt, lastSync);
      const catalogState = getCampaignCatalogState(
        row.campaignEffectiveStatus,
        providerState,
      );
      return [
        {
          key,
          store,
          accountId,
          campaign,
          accountKey: resolveBusinessAccount(store, accountId)!,
          accountName: row.accountName ?? accountId,
          platform: row.platform,
          status: row.campaignEffectiveStatus ?? null,
          configuredStatus: row.campaignConfiguredStatus ?? null,
          providerState,
          catalogState,
          firstActivity: row.firstActivity ?? null,
          lastActivity: row.lastActivity ?? null,
          lastSeenAt,
          spend: round2(row.spend),
          allocatedSpend: round2(row.allocatedSpend),
          unallocatedSpend: round2(row.unallocatedSpend),
          messages: row.messages,
          clicks: row.clicks,
          costPerMessage: roundedRatio(row.spend, row.messages),
        },
      ];
    });
    const stateCounts = emptyCampaignCatalogStateCounts();
    for (const campaign of allCampaigns) {
      stateCounts[campaign.catalogState] += 1;
    }
    const start = (page - 1) * limit;
    const pageCampaigns = allCampaigns.slice(start, start + limit);
    const campaignKeys = pageCampaigns.map((campaign) => campaign.key);
    const linkedCounts =
      campaignKeys.length > 0
        ? await Product.aggregate<{ _id: string; count: number }>([
            { $unwind: "$campaigns" },
            {
              $match: {
                "campaigns.key": { $in: campaignKeys },
              },
            },
            { $group: { _id: "$campaigns.key", count: { $sum: 1 } } },
          ])
        : [];
    const countByKey = new Map(linkedCounts.map((row) => [row._id, row.count]));
    const campaigns = pageCampaigns.map((campaign) => ({
      ...campaign,
      linkedProductCount: countByKey.get(campaign.key) ?? 0,
    }));

    const totalCampaigns = allCampaigns.length;
    const totalPages = Math.ceil(totalCampaigns / limit);
    return res.status(200).json({
      campaigns,
      summary: {
        totalCampaigns,
        stateCounts,
      },
      pagination: {
        currentPage: page,
        limit,
        totalCampaigns,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    });
  } catch (error) {
    console.error("Failed to fetch campaign catalog:", error);
    return res.status(500).json({ message: "Failed to fetch campaigns" });
  }
});

router.get("/campaigns/:key/products", async (req, res) => {
  const campaignRef = parseCampaignKey(req.params.key);
  if (
    !campaignRef ||
    !isKnownBusinessAccount(campaignRef.store, campaignRef.accountId)
  ) {
    return res.status(404).json({ message: "Campaign not found" });
  }

  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? DEFAULT_LIMIT);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIMIT ||
    !Number.isSafeInteger((page - 1) * limit)
  ) {
    return badRequest(res, "Invalid pagination parameters");
  }

  const search = String(req.query.search ?? "").trim();
  const productFilter = search
    ? {
        $or: [
          { name: { $regex: escapeRegex(search), $options: "i" } },
          { category: { $regex: escapeRegex(search), $options: "i" } },
        ],
      }
    : {};
  const key = campaignKeyFor(
    campaignRef.store,
    campaignRef.accountId,
    campaignRef.campaign,
  );

  try {
    const [spendRows, totalProducts, products, linkedProductRows, syncState] = await Promise.all([
      AdvertisingExpense.aggregate<{
        spend: number;
        allocatedSpend: number;
        unallocatedSpend: number;
        messages: number;
        clicks: number;
        platform: string;
        accountName?: string;
        campaignEffectiveStatus?: string | null;
        campaignConfiguredStatus?: string | null;
        firstActivity?: Date | null;
        lastActivity?: Date | null;
        lastSeenAt?: Date | null;
      }>([
        {
          $match: {
            source: "windsor",
            store: campaignRef.store,
            accountId: campaignRef.accountId,
            campaign: campaignRef.campaign,
            ...excludeUnmappedWindsorAccountsFilter(),
          },
        },
        { $sort: { lastSeenAt: 1, date: 1, _id: 1 } },
        {
          $group: {
            _id: null,
            spend: { $sum: "$amount" },
            allocatedSpend: {
              $sum: { $ifNull: ["$allocationSnapshot.allocatedSpend", 0] },
            },
            unallocatedSpend: {
              $sum: {
                $ifNull: [
                  "$allocationSnapshot.unallocatedSpend",
                  "$amount",
                ],
              },
            },
            messages: { $sum: { $ifNull: ["$messages", 0] } },
            clicks: { $sum: { $ifNull: ["$clicks", 0] } },
            platform: { $first: "$platform" },
            accountName: { $first: "$accountName" },
            campaignEffectiveStatus: {
              $last: "$campaignEffectiveStatus",
            },
            campaignConfiguredStatus: {
              $last: "$campaignConfiguredStatus",
            },
            firstActivity: { $min: "$date" },
            lastActivity: { $max: "$date" },
            lastSeenAt: { $max: "$lastSeenAt" },
          },
        },
      ]),
      Product.countDocuments(productFilter),
      Product.find(productFilter)
        .select("name category imageUrl price cost stock campaigns.key")
        .sort({ name: 1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Product.find({ "campaigns.key": key })
        .select("_id")
        .sort({ _id: 1 })
        .lean(),
      WindsorSyncState.findOne({
        connectionId:
          campaignRef.store === "viora" ? "viora-windsor" : "trendora-windsor",
      }).lean(),
    ]);

    const spend = spendRows[0];
    if (!spend && linkedProductRows.length === 0) {
      return res.status(404).json({ message: "Campaign not found" });
    }
    const linkedProductIds = linkedProductRows.map((product) =>
      product._id.toString(),
    );
    const historicalAllocations = await AdvertisingExpense.aggregate<{
      _id: { productId: string; productName: string };
      amount: number;
    }>([
      {
        $match: {
          source: "windsor",
          store: campaignRef.store,
          accountId: campaignRef.accountId,
          campaign: campaignRef.campaign,
          ...excludeUnmappedWindsorAccountsFilter(),
        },
      },
      { $unwind: "$allocationSnapshot.products" },
      {
        $group: {
          _id: {
            productId: "$allocationSnapshot.products.productId",
            productName: "$allocationSnapshot.products.productName",
          },
          amount: { $sum: "$allocationSnapshot.products.amount" },
        },
      },
      { $sort: { "_id.productName": 1, "_id.productId": 1 } },
    ]);
    const allocationByProductId = new Map<string, number>();
    for (const allocation of historicalAllocations) {
      allocationByProductId.set(
        allocation._id.productId,
        round2(
          (allocationByProductId.get(allocation._id.productId) ?? 0) +
            allocation.amount,
        ),
      );
    }
    const providerState = getCampaignProviderState(
      spend?.lastSeenAt,
      syncState?.lastSuccessfulSyncAt,
    );
    const catalogState = getCampaignCatalogState(
      spend?.campaignEffectiveStatus,
      providerState,
    );
    const totalPages = Math.ceil(totalProducts / limit);
    return res.status(200).json({
      campaign: {
        key,
        ...campaignRef,
        accountKey: resolveBusinessAccount(
          campaignRef.store,
          campaignRef.accountId,
        ),
        accountName: spend?.accountName ?? campaignRef.accountId,
        platform: spend?.platform ?? "Meta",
        status: spend?.campaignEffectiveStatus ?? null,
        configuredStatus: spend?.campaignConfiguredStatus ?? null,
        providerState,
        catalogState,
        firstActivity: spend?.firstActivity ?? null,
        lastActivity: spend?.lastActivity ?? null,
        lastSeenAt: spend?.lastSeenAt ?? null,
        spend: round2(spend?.spend ?? 0),
        allocatedSpend: round2(spend?.allocatedSpend ?? 0),
        unallocatedSpend: round2(spend?.unallocatedSpend ?? 0),
        messages: spend?.messages ?? 0,
        clicks: spend?.clicks ?? 0,
        costPerMessage: roundedRatio(spend?.spend ?? 0, spend?.messages ?? 0),
        linkedProductCount: linkedProductIds.length,
      },
      products: products.map((product) => ({
        _id: product._id.toString(),
        name: product.name,
        category: product.category,
        imageUrl: product.imageUrl ?? null,
        price: product.price,
        cost: product.cost,
        stock: product.stock,
        linked: (product.campaigns ?? []).some((ref) => ref.key === key),
        allocation: allocationByProductId.get(product._id.toString()) ?? null,
      })),
      historicalAllocations: historicalAllocations.map((allocation) => ({
        productId: allocation._id.productId,
        productName: allocation._id.productName,
        amount: round2(allocation.amount),
        linked: linkedProductIds.includes(allocation._id.productId),
      })),
      pagination: {
        currentPage: page,
        limit,
        totalProducts,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    });
  } catch (error) {
    console.error("Failed to fetch campaign detail:", error);
    return res.status(500).json({ message: "Failed to fetch campaign detail" });
  }
});

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
    Object.assign(filter, excludeUnmappedWindsorAccountsFilter());

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
  const validRows = result.connections
    .flatMap((conn) => conn.rows)
    .filter((row) => isKnownBusinessAccount(row.store, row.accountId));
  const availableDates = validRows.map((row) => row.date).sort();

  // Accounts with usable rows.
  const sources = result.connections.flatMap((conn) =>
    conn.accounts.flatMap((acc) => {
      const accountKey = resolveBusinessAccount(acc.store, acc.accountId);
      if (!accountKey) return [];

      return [{
        store: acc.store,
        connectionId: conn.connectionId,
        connectionLabel: conn.label,
        accountKey,
        accountId: acc.accountId,
        accountName: acc.accountName,
        accountStatus: acc.accountStatus,
        from: acc.from,
        to: acc.to,
        rowCount: acc.rowCount,
        sourceSpend: round2(acc.sourceSpend),
        spend: aedToUsd(acc.sourceSpend),
        messages: acc.messages,
        clicks: acc.clicks,
        costPerMessage: ratio(aedToUsd(acc.sourceSpend), acc.messages),
      }];
    }),
  );

  /*
   * Windsor accounts that appeared in the response but produced no usable
   * rows (disabled, or no dated campaign data). They are listed with zeroes so
   * the owner can SEE that the account exists rather than assume it is gone.
   */
  const emptySources = result.connections.flatMap((conn) =>
    conn.sightings.flatMap((sighting) => {
      const accountKey = resolveBusinessAccount(conn.store, sighting.accountId);
      if (
        !accountKey ||
        conn.accounts.some(
          (acc) => (acc.accountId || "unknown") === (sighting.accountId || "unknown"),
        )
      ) {
        return [];
      }

      return [{
        store: conn.store,
        connectionId: conn.connectionId,
        connectionLabel: conn.label,
        accountKey,
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
      }];
    }),
  );

  return {
    rate: AED_PER_USD_LABEL,
    currency: WINDSOR_SOURCE_CURRENCY,
    availableFrom: availableDates[0] ?? null,
    availableTo: availableDates.at(-1) ?? null,
    connections: result.connections.map((conn) => ({
      id: conn.connectionId,
      store: conn.store,
      label: conn.label,
      rowCount: conn.rows.filter((row) =>
        isKnownBusinessAccount(row.store, row.accountId),
      ).length,
      accountCount: conn.accounts.filter(
        (account) => isKnownBusinessAccount(account.store, account.accountId),
      ).length,
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

    const rows = result.connections
      .flatMap((c) => c.rows)
      .filter((row) => isKnownBusinessAccount(row.store, row.accountId));
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
        campaignEffectiveStatus: r.campaignEffectiveStatus,
        campaignConfiguredStatus: r.campaignConfiguredStatus,
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
    const syncAt = new Date();
    const rows = result.connections
      .flatMap((c) => c.rows)
      .filter((row) => isKnownBusinessAccount(row.store, row.accountId));
    const successfulConnections = result.connections.map(
      (connection) => connection.connectionId,
    );
    await captureMissingCampaignAllocations({
      connectionIds: successfulConnections,
    });

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
                campaignEffectiveStatus: row.campaignEffectiveStatus,
                campaignConfiguredStatus: row.campaignConfiguredStatus,
                lastSeenAt: syncAt,
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
        campaignEffectiveStatus: row.campaignEffectiveStatus,
        campaignConfiguredStatus: row.campaignConfiguredStatus,
        lastSeenAt: syncAt,
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

      const priorSnapshot = updatedDoc.value?.allocationSnapshot;
      if (priorSnapshot) {
        await AdvertisingExpense.updateOne(
          { _id: updatedDoc.value?._id },
          {
            $set: {
              allocationSnapshot: revalueCampaignAllocationSnapshot(
                amount,
                priorSnapshot,
              ),
            },
          },
        );
      }

      // "unchanged" = Windsor re-reported the identical stored amount.
      if (round2(updatedDoc.value?.amount ?? NaN) === amount) unchanged += 1;
    }

    await captureMissingCampaignAllocations({
      connectionIds: successfulConnections,
    });

    await Promise.all(
      result.connections.map((connection) =>
        WindsorSyncState.findOneAndUpdate(
          { connectionId: connection.connectionId },
          {
            $set: {
              lastSuccessfulSyncAt: syncAt,
              historyFrom:
                connection.accounts
                  .map((account) => account.from)
                  .filter((date): date is string => Boolean(date))
                  .sort()[0] ?? null,
              historyTo:
                connection.accounts
                  .map((account) => account.to)
                  .filter((date): date is string => Boolean(date))
                  .sort()
                  .at(-1) ?? null,
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        ),
      ),
    );

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
 *                   their own totals and campaign counts, resolved through
 *                   the business-account directory (adAccounts.ts).
 *  - `manual`     : manual expenses broken out on their own.
 *
 * Reports does NOT depend on this endpoint - it runs its own aggregation.
 */
router.get("/insights", async (_req, res) => {
  try {
    const [accountAgg, campaignAgg, manualAgg, syncStates] = await Promise.all([
      // Per ad account, ALL time. Pinned sort: $group output order is
      // unspecified, and refetches must be byte-identical.
      AdvertisingExpense.aggregate([
        {
          $match: {
            source: "windsor",
            ...excludeUnmappedWindsorAccountsFilter(),
          },
        },
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

      // Campaign counts only; campaign details are served through the
      // paginated catalog endpoint instead of embedding every row here.
      AdvertisingExpense.aggregate([
        {
          $match: {
            source: "windsor",
            campaign: { $type: "string", $ne: "" },
            ...excludeUnmappedWindsorAccountsFilter(),
          },
        },
        { $sort: { lastSeenAt: 1, date: 1, _id: 1 } },
        {
          $group: {
            _id: {
              store: "$store",
              accountId: "$accountId",
              campaign: "$campaign",
            },
            campaignEffectiveStatus: { $last: "$campaignEffectiveStatus" },
            lastSeenAt: { $max: "$lastSeenAt" },
          },
        },
      ]),

      // ALL manual expenses (missing `source` = written before the field
      // existed, which also means manual).
      AdvertisingExpense.aggregate([
        { $match: { source: { $in: [null, "manual"] } } },
        { $group: { _id: null, spend: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
      WindsorSyncState.find().lean(),
    ]);

    type Bucket = {
      spend: number;
      messages: number;
      clicks: number;
      campaignCount: number;
      campaignStateCounts: CampaignCatalogStateCounts;
    };

    const emptyBucket = (): Bucket => ({
      spend: 0,
      messages: 0,
      clicks: 0,
      campaignCount: 0,
      campaignStateCounts: emptyCampaignCatalogStateCounts(),
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

    const bucketFor = (store: unknown, accountId: unknown): Bucket | null => {
      const key = resolveBusinessAccount(
        typeof store === "string" ? store : null,
        typeof accountId === "string" ? accountId : null,
      );
      if (key === null) return null;

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
        store: "viora" | "trendora" | null;
        accountId: string | null;
        campaign: string;
      };
      campaignEffectiveStatus?: string | null;
      lastSeenAt?: Date | null;
    };

    for (const row of accountAgg as AccountAggRow[]) {
      const bucket = bucketFor(row._id.store, row._id.accountId);
      if (!bucket) continue;

      bucket.spend += row.spend;
      bucket.messages += row.messages ?? 0;
      bucket.clicks += row.clicks ?? 0;
    }

    const lastSyncByStore = new Map(
      syncStates.map((state) => [
        state.connectionId === "viora-windsor" ? "viora" : "trendora",
        state.lastSuccessfulSyncAt,
      ]),
    );

    for (const row of campaignAgg as CampaignAggRow[]) {
      const bucket = bucketFor(row._id.store, row._id.accountId);
      if (!bucket) continue;
      const providerState =
        row._id.store === "viora" || row._id.store === "trendora"
          ? getCampaignProviderState(
              row.lastSeenAt,
              lastSyncByStore.get(row._id.store),
            )
          : "unknown";
      const catalogState = getCampaignCatalogState(
        row.campaignEffectiveStatus,
        providerState,
      );
      bucket.campaignCount += 1;
      bucket.campaignStateCounts[catalogState] += 1;
    }

    const accounts = BUSINESS_ACCOUNT_KEYS.filter((key) => buckets.has(key)).map(
      (key) => {
        const bucket = buckets.get(key)!;

        return {
          key,
          configured: isBusinessAccountConfigured(key),
          spend: round2(bucket.spend),
          messages: Math.round(bucket.messages),
          clicks: Math.round(bucket.clicks),
          costPerMessage: roundedRatio(bucket.spend, bucket.messages),
          campaignCount: bucket.campaignCount,
          campaignStateCounts: bucket.campaignStateCounts,
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

/**
 * POST /api/advertising/performance
 *
 * Ad analytics behind the Advertising page. The default is all available
 * history; an explicit `7` or `30` range selects the Beirut business window.
 *
 *   - delivered orders / product profit come from Delivered orders only;
 *   - ad spend and messages come from every stored advertising row in the
 *     window (manual + Windsor, counted exactly once each);
 *   - the verdict compares cost-per-order against profit-per-order, so the
 *     owner sees at a glance whether the ads are paying for themselves.
 */
router.post("/performance", async (req, res) => {
  try {
    const parsedRange: "all" | 7 | 30 =
      req.query.range === "7" ? 7 : req.query.range === "30" ? 30 : "all";

    // Beirut midnight "today", expressed as a real UTC instant.
    const startOfToday = startOfDayInTimeZone(new Date(), TIMEZONE);

    const startOfWindow =
      parsedRange === "all" ? undefined : startOfWindowForRange(parsedRange);

    /* ------------------------------------------------------------------ */
    /* Delivered orders in the window (product sales + profit).           */
    /* ------------------------------------------------------------------ */
    const [orderCountRows, productTotals] = await Promise.all([
      Order.aggregate<{ count: number }>([
        {
          $match: {
            status: "Delivered",
            ...(startOfWindow ? { createdAt: { $gte: startOfWindow } } : {}),
          },
        },
        { $count: "count" },
      ]),
      getProductTotalsFrom(startOfWindow),
    ]);
    const orders = {
      deliveredOrders: orderCountRows[0]?.count ?? 0,
      productSales: productTotals.productSales,
      productProfit: productTotals.productProfit,
    };

    /* ------------------------------------------------------------------ */
    /* Advertising rows in the window (manual + Windsor, exactly once).   */
    /* ------------------------------------------------------------------ */
    const advertisingAgg = await AdvertisingExpense.aggregate([
      {
        $match: {
          ...(startOfWindow ? { date: { $gte: startOfWindow } } : {}),
          ...excludeUnmappedWindsorAccountsFilter(),
        },
      },
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
      {
        $match: {
          ...(startOfWindow ? { date: { $gte: startOfWindow } } : {}),
          ...excludeUnmappedWindsorAccountsFilter(),
        },
      },
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
      if (key === null) continue;
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.spend += row.spend;
        bucket.messages += row.messages;
      }
    }

    const accounts = BUSINESS_ACCOUNT_KEYS.filter((key) => buckets.has(key)).map(
      (key) => ({
        key,
        configured: isBusinessAccountConfigured(key),
        spend: round2((buckets.get(key) ?? { spend: 0, messages: 0 }).spend),
        messages: Math.round((buckets.get(key) ?? { spend: 0, messages: 0 }).messages),
        accountId: null,
        accountStatus: "",
      }),
    );

    const dailyAdSpend = new Map<string, number>();
    const dailyAdMessages = new Map<string, number>();

    const dailyRows = await AdvertisingExpense.find({
      ...(startOfWindow ? { date: { $gte: startOfWindow } } : {}),
      ...excludeUnmappedWindsorAccountsFilter(),
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
          ...(startOfWindow ? { date: { $gte: startOfWindow } } : {}),
          ...excludeUnmappedWindsorAccountsFilter(),
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
