import { Router } from "express";
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

export default router;
