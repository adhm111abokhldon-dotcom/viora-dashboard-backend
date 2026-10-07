import { Router } from "express";
import Product from "../models/Product.js";
import Order from "../models/Orders.js";
import AdvertisingExpense from "../models/AdvertisingExpense.js";
import mongoose from "mongoose";
import {
  createProductSchema,
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
} from "../lib/adAccounts.js";
import { allocateEvenly } from "../lib/campaignAllocation.js";
import { round2 } from "../lib/money.js";

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

    return res.status(200).json(product);
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

  const productId = new mongoose.Types.ObjectId(req.params.id);

  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);
  const skip = (page - 1) * limit;

  const rawStatus =
    typeof req.query.status === "string" ? req.query.status : "Delivered";
  const statusFilter =
    rawStatus === "all" ||
    rawStatus === "Pending" ||
    rawStatus === "Cancelled" ||
    rawStatus === "Delivered"
      ? rawStatus
      : "Delivered";

  try {
    const campaignRefs = [...(product.campaigns ?? [])]
      .sort((a, b) => a.key.localeCompare(b.key))
      .filter((ref) => !isIgnoredAccount(ref.accountId));

    const refKeys = campaignRefs.map((ref) => ref.key);
    const linkedIdsByKey = new Map<string, string[]>();
    if (refKeys.length > 0) {
      const linked = await Product.find({
        "campaigns.key": { $in: refKeys },
      })
        .select("_id campaigns.key")
        .lean();

      for (const row of linked as Array<{
        _id: mongoose.Types.ObjectId;
        campaigns: { key: string }[];
      }>) {
        for (const ref of row.campaigns) {
          const key = ref.key;
          if (!linkedIdsByKey.has(key)) linkedIdsByKey.set(key, []);
          const ids = linkedIdsByKey.get(key) ?? [];
          ids.push(row._id.toString());
        }
      }

      for (const ids of linkedIdsByKey.values()) {
        ids.sort();
      }
    }

    const totalAllocated = round2(
      campaigns.reduce((sum, campaign) => sum + campaign.allocation, 0),
    );

    /* Profit waterfall - every line traceable to a source section above. */
    const beforeAdsProfit = round2(revenue - soldCost - allocatedDeliveryCost);
    const netProfit = round2(beforeAdsProfit - totalAllocated);
    const marginPercent = revenue > 0 ? round2((netProfit / revenue) * 100) : 0;

    const state: "noSales" | "profitable" | "loss" | "breakEven" =
      deliveredOrders === 0 && totalAllocated === 0
        ? "noSales"
        : netProfit > 0
          ? "profitable"
          : netProfit < 0
            ? "loss"
            : "breakEven";

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
        unitsSold,
        outOfStock: product.stock === 0,
        lowStock: product.stock > 0 && product.stock <= LOW_STOCK_THRESHOLD,
      },

      sales: {
        deliveredOrders,
        unitsSold,
        revenue,
        productCost: soldCost,
        deliveryCost: allocatedDeliveryCost,
        averageSellingPrice: unitsSold > 0 ? round2(revenue / unitsSold) : 0,
        pendingOrders: pending.orderCount ?? 0,
        pendingUnits: pending.units ?? 0,
        cancelledOrders: cancelled.orderCount ?? 0,
        cancelledUnits: cancelled.units ?? 0,
      },

      inventory: {
        currentStock: product.stock,
        costPerUnit: round2(product.cost),
        inventoryValue: round2(product.stock * product.cost),
      },

      campaigns,
      advertising: { totalAllocated },

      profit: {
        revenue,
        productCost: soldCost,
        deliveryCost: allocatedDeliveryCost,
        advertisingCost: totalAllocated,
        beforeAdsProfit,
        netProfit,
        marginPercent,
        state,
      },

      orders: {
        status: statusFilter,
        rows: (
          orderRows as Array<{
            _id: mongoose.Types.ObjectId;
            orderNumber?: number;
            createdAt: Date;
            status: string;
            quantity: number;
            revenue: number;
            cost: number;
          }> | undefined
        ).map((row) => ({
          orderNumber: row.orderNumber ?? null,
          orderId: row._id.toString(),
          createdAt: row.createdAt,
          status: row.status,
          quantity: row.quantity,
          revenue: round2(row.revenue),
          cost: round2(row.cost),
          /* Effective historical price for this order (snapshots). */
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

    return res.status(500).json({
      message: "Failed to fetch product performance",
    });
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

    return res.status(200).json(product);
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
    const refs = [...(product.campaigns ?? [])].sort((a, b) =>
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

  const result = createProductSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      message: "Invalid product data",
      errors: result.error.issues,
    });
  }

  const { store, accountId, campaign } = result.data;

  // Server-side derivation protects the relationship from tampered or
  // stale keys - the only canonical identity is key = store|account|campaign.
  const key = campaignKeyFor(store, accountId, campaign);

  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    // Remove stale links (wrong account/campaign) and keep the new one.
    const updated = await Product.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          campaigns: [
            ...new Map(
              [
                ...product.campaigns.filter(
                  (ref) =>
                    !(ref.store === store && ref.accountId === accountId),
                ),
                { key, store, accountId, campaign },
              ].map((ref) => [ref.key, ref]),
            ).values(),
          ],
        },
      },
      { new: true, runValidators: true },
    );

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

  const { store, accountId, campaign } = req.body ?? {};

  if (typeof store !== "string" || typeof accountId !== "string" || typeof campaign !== "string") {
    return res.status(400).json({ message: "store, accountId and campaign are required" });
  }

  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const filtered = (product.campaigns ?? []).filter(
      (ref) =>
        !(ref.store === store && ref.accountId === accountId && ref.campaign === campaign),
    );

    if (filtered.length === (product.campaigns?.length ?? 0)) {
      return res.status(404).json({ message: "Campaign link not found" });
    }

    const updated = await Product.findByIdAndUpdate(
      req.params.id,
      { $set: { campaigns: filtered } },
      { new: true, runValidators: true },
    );

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
