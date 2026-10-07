import { Router } from "express";
import Product from "../models/Product.js";
import Order from "../models/Orders.js";
import AdvertisingExpense from "../models/AdvertisingExpense.js";
import mongoose from "mongoose";
import {
  createProductSchema,
  campaignLinkSchema,
  updateProductSchema,
} from "../schemas/productSchemas.js";
import {
  performanceStages,
  toPerformance,
  type PerformanceRow,
} from "./productStatsRoutes.js";
import {
  itemPrologue,
  groupByProductAndOrder,
} from "../lib/productStats.js";
import {
  campaignKeyFor,
  isIgnoredAccount,
  resolveBusinessAccount,
  type StoreId,
} from "../lib/adAccounts.js";
import { allocateEvenly } from "../lib/campaignAllocation.js";
import { round2 } from "../lib/money.js";
import { calculateProductProfit } from "../lib/productProfit.js";

const router = Router();

const escapeRegex = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const LOW_STOCK_THRESHOLD = 10;

router.get("/", async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);

    const skip = (page - 1) * limit;

    const search = String(req.query.search ?? "").trim();

    const filter = search
      ? {
          $or: [
            { name: { $regex: escapeRegex(search), $options: "i" } },
            { category: { $regex: escapeRegex(search), $options: "i" } },
          ],
        }
      : {};

    const [products, totalProducts, statsResult] = await Promise.all([
      Product.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),

      Product.countDocuments(filter),

      Product.aggregate([
        {
          $group: {
            _id: null,
            totalProducts: { $sum: 1 },
            totalStock: { $sum: "$stock" },
            lowStockCount: {
              $sum: {
                $cond: [{ $lte: ["$stock", LOW_STOCK_THRESHOLD] }, 1, 0],
              },
            },
          },
        },
      ]),
    ]);

    const stats = statsResult[0] ?? {
      totalProducts: 0,
      totalStock: 0,
      lowStockCount: 0,
    };

    /*
     * Business performance for the products on THIS page only, in a single
     * aggregation (no N+1). Uses the shared productStats logic and counts
     * Delivered orders as the only completed sales.
     */
    const performanceRows = await Order.aggregate(
      performanceStages(products.map((product) => product._id)),
    );

    const performanceByProduct = new Map<string, PerformanceRow>(
      performanceRows.map((row) => [row._id.toString(), row]),
    );

    const totalPages = Math.ceil(totalProducts / limit);

    return res.status(200).json({
      products: products.map((product) => {
        const item = product.toObject();
        const performance = toPerformance(
          performanceByProduct.get(item._id.toString()),
        );

        return {
          ...item,
          campaigns: (item.campaigns ?? []).filter(
            (ref) => !isIgnoredAccount(ref.accountId),
          ),
          performance: {
            ...performance,

            /* Realised margin at the price customers actually paid, as
               opposed to `price - cost` which ignores negotiation. */
            realisedMargin:
              performance.sales - performance.cost - performance.deliveryCost,
          },
        };
      }),
      pagination: {
        currentPage: page,
        limit,
        totalProducts,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
      stats: {
        totalProducts: stats.totalProducts,
        totalStock: stats.totalStock,
        lowStockCount: stats.lowStockCount,
      },
    });
  } catch (error) {
    console.error("Failed to fetch products:", error);

    return res.status(500).json({
      message: "Failed to fetch products",
    });
  }
});

router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        message: "Invalid product ID",
      });
    }

    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        message: "Product not found",
      });
    }

    const safeProduct = product.toObject();
    safeProduct.campaigns = safeProduct.campaigns.filter(
      (ref) => !isIgnoredAccount(ref.accountId),
    );
    return res.status(200).json(safeProduct);
  } catch (error) {
    console.error("Failed to fetch product:", error);

    return res.status(500).json({
      message: "Failed to fetch product",
    });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/products/:id/performance - Product Profitability                  */
/* -------------------------------------------------------------------------- */

router.get("/:id/performance", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: "Invalid product ID" });
  }

  const requestedPage = Number(req.query.page ?? 1);
  const requestedLimit = Number(req.query.limit ?? 10);
  if (
    !Number.isSafeInteger(requestedPage) ||
    requestedPage < 1 ||
    !Number.isSafeInteger(requestedLimit) ||
    requestedLimit < 1 ||
    requestedLimit > 100 ||
    !Number.isSafeInteger((requestedPage - 1) * requestedLimit)
  ) {
    return res.status(400).json({ message: "Invalid pagination parameters" });
  }

  const rawStatus =
    typeof req.query.status === "string" ? req.query.status : "Delivered";
  if (
    !["all", "Pending", "Cancelled", "Delivered"].includes(rawStatus)
  ) {
    return res.status(400).json({ message: "Invalid order status filter" });
  }

  const productId = new mongoose.Types.ObjectId(req.params.id);
  const page = requestedPage;
  const limit = requestedLimit;
  const skip = (page - 1) * limit;
  const statusFilter = rawStatus;

  try {
    const product = await Product.findById(productId).lean();
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const campaignRefs = [
      ...new Map(
        (product.campaigns ?? [])
          .filter((ref) => !isIgnoredAccount(ref.accountId))
          .map((ref) => [ref.key, ref]),
      ).values(),
    ].sort((a, b) => a.key.localeCompare(b.key));
    const refKeys = campaignRefs.map((ref) => ref.key);

    type SalesTotals = {
      orders: number;
      units: number;
      revenue: number;
      productCost: number;
      deliveryCost: number;
    };
    type StatusTotal = { _id: string; orders: number; units: number };
    type OrderRow = {
      _id: mongoose.Types.ObjectId;
      orderNumber?: number;
      createdAt: Date;
      status: string;
      quantity: number;
      revenue: number;
      cost: number;
    };
    type CampaignSpend = {
      _id: { store: StoreId; accountId: string; campaign: string };
      spend: number;
      messages: number;
      clicks: number;
      platform: string;
      accountName?: string;
    };
    type LinkedProduct = {
      _id: mongoose.Types.ObjectId;
      campaigns: { key: string }[];
    };

    const baseItemStages = [
      ...itemPrologue(),
      { $match: { "items.productId": productId } },
      groupByProductAndOrder,
    ];
    const statusMatch =
      statusFilter === "all" ? [] : [{ $match: { status: statusFilter } }];

    const [salesRows, statusRows, orderResults, spendRows, linkedRows] =
      await Promise.all([
        Order.aggregate<SalesTotals>([
          { $match: { status: "Delivered", "items.productId": productId } },
          ...baseItemStages,
          {
            $group: {
              _id: null,
              orders: { $sum: 1 },
              units: { $sum: "$units" },
              revenue: { $sum: "$revenue" },
              productCost: { $sum: "$cost" },
              deliveryCost: { $sum: "$deliveryCost" },
            },
          },
        ]),
        Order.aggregate<StatusTotal>([
          { $match: { "items.productId": productId } },
          ...baseItemStages,
          {
            $group: {
              _id: "$status",
              orders: { $sum: 1 },
              units: { $sum: "$units" },
            },
          },
        ]),
        Order.aggregate<{ rows: OrderRow[]; total: { count: number }[] }>([
          { $match: { "items.productId": productId } },
          ...baseItemStages,
          ...statusMatch,
          {
            $facet: {
              rows: [
                { $sort: { createdAt: -1, _id: -1 } },
                { $skip: skip },
                { $limit: limit },
                {
                  $project: {
                    _id: "$_id.orderId",
                    orderNumber: 1,
                    createdAt: 1,
                    status: 1,
                    quantity: "$units",
                    revenue: 1,
                    cost: 1,
                  },
                },
              ],
              total: [{ $count: "count" }],
            },
          },
        ]),
        refKeys.length > 0
          ? AdvertisingExpense.aggregate<CampaignSpend>([
              {
                $match: {
                  source: "windsor",
                  accountId: { $nin: ["1783521163010511"] },
                  $or: campaignRefs.map((ref) => ({
                    store: ref.store,
                    accountId: ref.accountId,
                    campaign: ref.campaign,
                  })),
                },
              },
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
                  platform: { $first: "$platform" },
                  accountName: { $first: "$accountName" },
                },
              },
            ])
          : Promise.resolve([] as CampaignSpend[]),
        refKeys.length > 0
          ? Product.find({ "campaigns.key": { $in: refKeys } })
              .select("_id campaigns.key")
              .lean<LinkedProduct[]>()
          : Promise.resolve([] as LinkedProduct[]),
      ]);

    const sales = salesRows[0] ?? {
      orders: 0,
      units: 0,
      revenue: 0,
      productCost: 0,
      deliveryCost: 0,
    };
    const statusByName = new Map(statusRows.map((row) => [row._id, row]));
    const orderResult = orderResults[0] ?? { rows: [], total: [] };
    const totalOrderRows = orderResult.total[0]?.count ?? 0;

    const productIdsByCampaign = new Map<string, Set<string>>(
      refKeys.map((key) => [key, new Set<string>()]),
    );
    for (const row of linkedRows) {
      for (const ref of row.campaigns) {
        productIdsByCampaign.get(ref.key)?.add(row._id.toString());
      }
    }

    const spendByKey = new Map(
      spendRows.map((row) => [
        campaignKeyFor(row._id.store, row._id.accountId, row._id.campaign),
        row,
      ]),
    );
    const campaigns = campaignRefs.map((ref) => {
      const linkedIds = [
        ...(productIdsByCampaign.get(ref.key) ?? new Set([productId.toString()])),
      ].sort();
      const spend = spendByKey.get(ref.key);
      const businessAccount = resolveBusinessAccount(ref.store, ref.accountId);

      return {
        key: ref.key,
        store: ref.store,
        accountId: ref.accountId,
        accountKey: businessAccount,
        accountName: spend?.accountName ?? businessAccount,
        campaign: ref.campaign,
        platform: spend?.platform ?? "Meta",
        spend: round2(spend?.spend ?? 0),
        messages: spend?.messages ?? 0,
        clicks: spend?.clicks ?? 0,
        linkedProductCount: linkedIds.length,
        allocation:
          allocateEvenly(spend?.spend ?? 0, linkedIds.length)[
            linkedIds.indexOf(productId.toString())
          ] ?? 0,
      };
    });
    const advertisingCost = round2(
      campaigns.reduce((sum, campaign) => sum + campaign.allocation, 0),
    );
    const profit = calculateProductProfit(
      sales.revenue,
      sales.productCost,
      sales.deliveryCost,
      advertisingCost,
      sales.orders,
    );
    const totalOrders = statusRows.reduce((sum, row) => sum + row.orders, 0);
    const totalPages = Math.ceil(totalOrderRows / limit);

    return res.status(200).json({
      product: {
        _id: product._id.toString(),
        name: product.name,
        category: product.category,
        imageUrl: product.imageUrl ?? null,
        price: product.price,
        cost: product.cost,
        stock: product.stock,
      },
      overview: {
        campaignCount: campaignRefs.length,
        totalOrders,
        unitsSold: sales.units,
        outOfStock: product.stock === 0,
        lowStock: product.stock > 0 && product.stock <= LOW_STOCK_THRESHOLD,
      },
      sales: {
        deliveredOrders: sales.orders,
        unitsSold: sales.units,
        revenue: round2(sales.revenue),
        productCost: round2(sales.productCost),
        deliveryCost: round2(sales.deliveryCost),
        averageSellingPrice:
          sales.units > 0 ? round2(sales.revenue / sales.units) : 0,
        pendingOrders: statusByName.get("Pending")?.orders ?? 0,
        pendingUnits: statusByName.get("Pending")?.units ?? 0,
        cancelledOrders: statusByName.get("Cancelled")?.orders ?? 0,
        cancelledUnits: statusByName.get("Cancelled")?.units ?? 0,
      },
      inventory: {
        currentStock: product.stock,
        costPerUnit: round2(product.cost),
        inventoryValue: round2(product.stock * product.cost),
      },
      campaigns,
      advertising: { totalAllocated: advertisingCost },
      profit: {
        revenue: round2(sales.revenue),
        productCost: round2(sales.productCost),
        deliveryCost: round2(sales.deliveryCost),
        advertisingCost,
        ...profit,
      },
      orders: {
        status: statusFilter,
        rows: orderResult.rows.map((row) => ({
          orderNumber: row.orderNumber ?? null,
          orderId: row._id.toString(),
          createdAt: row.createdAt,
          status: row.status,
          quantity: row.quantity,
          revenue: round2(row.revenue),
          cost: round2(row.cost),
          unitPrice: row.quantity > 0 ? round2(row.revenue / row.quantity) : 0,
          unitCost: row.quantity > 0 ? round2(row.cost / row.quantity) : 0,
        })),
        pagination: {
          currentPage: page,
          limit,
          totalOrders: totalOrderRows,
          totalPages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1,
        },
      },
    });
  } catch (error) {
    console.error("Failed to fetch product performance:", error);
    return res
      .status(500)
      .json({ message: "Failed to fetch product performance" });
  }
});

router.post("/", async (req, res) => {
  try {
    const result = createProductSchema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        message: "Invalid product data",
        errors: result.error.issues,
      });
    }

    const product = await Product.create(result.data);

    return res.status(201).json(product);
  } catch (error) {
    console.error("Failed to create product:", error);

    return res.status(500).json({
      message: "Failed to create product",
    });
  }
});

router.put("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        message: "Invalid product ID",
      });
    }

    const result = updateProductSchema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        message: "Invalid product data",
        errors: result.error.issues,
      });
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      result.data,
      {
        new: true,
        runValidators: true,
      },
    );

    if (!product) {
      return res.status(404).json({
        message: "Product not found",
      });
    }

    const safeProduct = product.toObject();
    safeProduct.campaigns = safeProduct.campaigns.filter(
      (ref) => !isIgnoredAccount(ref.accountId),
    );
    return res.status(200).json(safeProduct);
  } catch (error) {
    console.error("Failed to update product:", error);

    return res.status(500).json({
      message: "Failed to update product",
    });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/products/:id/campaigns - which campaigns a product belongs to     */
/* -------------------------------------------------------------------------- */

router.get("/:id/campaigns", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: "Invalid product ID" });
  }

  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    // Deterministic order; schema transform already dedupes by key.
    const refs = (product.campaigns ?? [])
      .filter((ref) => !isIgnoredAccount(ref.accountId))
      .sort((a, b) =>
      a.key.localeCompare(b.key),
    );

    return res.status(200).json({
      product: { _id: product._id.toString(), name: product.name, category: product.category },
      campaigns: refs.map((ref) => ({
        key: ref.key,
        store: ref.store,
        accountId: ref.accountId,
        campaign: ref.campaign,
        accountKey: resolveBusinessAccount(ref.store, ref.accountId) ?? "trendora_other",
      })),
    });
  } catch (error) {
    console.error("Failed to fetch product campaigns:", error);

    return res.status(500).json({
      message: "Failed to fetch product campaigns",
    });
  }
});

router.post("/:id/campaigns", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: "Invalid product ID" });
  }

  const result = campaignLinkSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      message: "Invalid campaign reference",
      errors: result.error.issues,
    });
  }

  const campaignRef = result.data;

  try {
    const updated = await Product.findByIdAndUpdate(
      req.params.id,
      { $addToSet: { campaigns: campaignRef } },
      { new: true, runValidators: true },
    );

    if (!updated) {
      return res.status(404).json({ message: "Product not found" });
    }

    return res.status(200).json({
      product: { _id: updated._id.toString(), name: updated.name, category: updated.category },
      campaigns: [...(updated.campaigns ?? [])].sort((a, b) =>
        a.key.localeCompare(b.key),
      ),
    });
  } catch (error) {
    console.error("Failed to link product campaign:", error);

    return res.status(500).json({
      message: "Failed to link product campaign",
    });
  }
});

router.delete("/:id/campaigns", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: "Invalid product ID" });
  }

  const result = campaignLinkSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({
      message: "Invalid campaign reference",
      errors: result.error.issues,
    });
  }

  try {
    const updated = await Product.findOneAndUpdate(
      { _id: req.params.id, "campaigns.key": result.data.key },
      { $pull: { campaigns: { key: result.data.key } } },
      { new: true, runValidators: true },
    );

    if (!updated) {
      if (await Product.exists({ _id: req.params.id })) {
        return res.status(404).json({ message: "Campaign link not found" });
      }
      return res.status(404).json({ message: "Product not found" });
    }

    return res.status(200).json({
      product: { _id: updated._id.toString(), name: updated.name, category: updated.category },
      campaigns: [...(updated.campaigns ?? [])].sort((a, b) =>
        a.key.localeCompare(b.key),
      ),
    });
  } catch (error) {
    console.error("Failed to unlink product campaign:", error);

    return res.status(500).json({
      message: "Failed to unlink product campaign",
    });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        message: "Invalid product ID",
      });
    }

    const product = await Product.findByIdAndDelete(req.params.id);

    if (!product) {
      return res.status(404).json({
        message: "Product not found",
      });
    }

    return res.status(200).json({
      message: "Product deleted successfully",
    });
  } catch (error) {
    console.error("Failed to delete product:", error);

    return res.status(500).json({
      message: "Failed to delete product",
    });
  }
});

export default router;
