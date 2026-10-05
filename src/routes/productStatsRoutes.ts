import { Router } from "express";
import mongoose from "mongoose";
import type { PipelineStage } from "mongoose";

import Order from "../models/Orders.js";
import Product from "../models/Product.js";
import {
  itemPrologue,
  groupByProductAndOrder,
  rollupByProduct,
} from "../lib/productStats.js";
import { round2 } from "../lib/money.js";
import { BUSINESS_TIMEZONE, DAY_MS } from "../lib/date.js";

const router = Router();

/** Same threshold the Products list uses (productRoutes.ts). */
export const LOW_STOCK_THRESHOLD = 10;

/** How many recent orders the Product Detail page shows. */
const RECENT_ORDERS_LIMIT = 8;

export function toObjectId(value: string) {
  return new mongoose.Types.ObjectId(value);
}

/*
 * One aggregation covering every product on the current page, so the Products
 * table gets real business metrics without an N+1 query.
 */
export function performanceStages(
  productIds: mongoose.Types.ObjectId[],
): PipelineStage[] {
  return [
    { $match: { status: "Delivered", "items.productId": { $in: productIds } } },
    ...itemPrologue(),
    groupByProductAndOrder,
    rollupByProduct,
  ];
}

export type PerformanceRow = {
  _id: mongoose.Types.ObjectId;
  name: string;
  orders: number;
  units: number;
  revenue: number;
  cost: number;
  deliveryCost: number;
  profit: number;
};

export type Performance = {
  unitsSold: number;
  orders: number;
  sales: number;
  cost: number;
  deliveryCost: number;
  profit: number;
  averageSellingPrice: number;
  profitMargin: number;
};

/** Turn an aggregated row into the shape the frontend consumes. */
export function toPerformance(row: PerformanceRow | undefined): Performance {
  const unitsSold = row?.units ?? 0;
  const sales = round2(row?.revenue ?? 0);
  const profit = round2(row?.profit ?? 0);

  return {
    unitsSold,
    orders: row?.orders ?? 0,
    sales,
    cost: round2(row?.cost ?? 0),
    deliveryCost: round2(row?.deliveryCost ?? 0),
    profit,
    averageSellingPrice: unitsSold > 0 ? round2(sales / unitsSold) : 0,
    profitMargin: sales > 0 ? round2((profit / sales) * 100) : 0,
  };
}

/**
 * GET /api/products/:id/stats
 *
 * Everything the Product Detail page needs about one product, computed on the
 * backend so the frontend never re-implements the money math.
 */
router.get("/:id/stats", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: "Invalid product ID" });
  }

  const productId = toObjectId(req.params.id);

  try {
    const product = await Product.findById(productId).lean();

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    /* Optional window (in days) so the page can show a real sales trend. */
    const daysParam = Number(req.query.days);
    const days = [7, 30, 90].includes(daysParam) ? daysParam : 30;
    const from = new Date(Date.now() - (days - 1) * DAY_MS);

    const [totalsRows, trendRows, pendingRows, recentRows, otherLowStock] =
      await Promise.all([
        /* Lifetime performance over delivered orders only. */
        Order.aggregate([
          { $match: { status: "Delivered", "items.productId": productId } },
          ...itemPrologue(),
          groupByProductAndOrder,
          {
            $group: {
              _id: null,
              units: { $sum: "$units" },
              orders: { $sum: 1 },
              sales: { $sum: "$revenue" },
              cost: { $sum: "$cost" },
              deliveryCost: { $sum: "$deliveryCost" },
              profit: { $sum: "$profit" },
              deliveryCharged: { $sum: "$__orderDeliveryCharged" },
            },
          },
        ]),

        /* Daily delivered units inside the window, for the trend. */
        Order.aggregate([
          { $match: { status: "Delivered", createdAt: { $gte: from } } },
          { $unwind: "$items" },
          { $match: { "items.productId": productId } },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$createdAt",
                  timezone: BUSINESS_TIMEZONE,
                },
              },
              units: { $sum: "$items.quantity" },
              sales: { $sum: { $multiply: ["$items.quantity", "$items.unitPrice"] } },
            },
          },
          { $sort: { _id: 1 } },
        ]),

        /* Pending is operational only - never counted as completed sales. */
        Order.aggregate([
          { $match: { status: "Pending", "items.productId": productId } },
          { $unwind: "$items" },
          { $match: { "items.productId": productId } },
          {
            $group: {
              _id: null,
              orders: { $sum: 1 },
              units: { $sum: "$items.quantity" },
            },
          },
        ]),

        /* Most recent delivered orders containing this product. */
        Order.aggregate([
          { $match: { status: "Delivered", "items.productId": productId } },
          { $unwind: "$items" },
          { $match: { "items.productId": productId } },
          {
            $project: {
              _id: 1,
              customer: 1,
              createdAt: 1,
              itemName: "$items.name",
              quantity: "$items.quantity",
              unitPrice: "$items.unitPrice",
              unitCost: "$items.unitCost",
              orderTotal: "$total",
              orderDeliveryCost: "$deliveryCost",
            },
          },
          { $sort: { createdAt: -1 } },
          { $limit: RECENT_ORDERS_LIMIT },
        ]),

        /* Products that would still need restocking if this one sold out. */
        Product.find({ _id: { $ne: productId }, stock: { $lte: LOW_STOCK_THRESHOLD } })
          .select("name stock")
          .sort({ stock: 1 })
          .limit(5)
          .lean(),
      ]);

    const totals = totalsRows[0] ?? {};
    const pending = pendingRows[0] ?? { orders: 0, units: 0 };

    const unitsSold = totals.units ?? 0;
    const sales = round2(totals.sales ?? 0);
    const productCost = round2(totals.cost ?? 0);
    const deliveryCost = round2(totals.deliveryCost ?? 0);
    const profit = round2(totals.profit ?? 0);

    const averageSellingPrice = unitsSold > 0 ? round2(sales / unitsSold) : 0;
    const profitMargin = sales > 0 ? round2((profit / sales) * 100) : 0;

    /* Default vs actual selling price: customers negotiate, so the order
       snapshot is the real price and the gap is worth showing. */
    const priceDifference = round2(averageSellingPrice - product.price);
    const priceDifferencePercent =
      product.price > 0 ? round2((priceDifference / product.price) * 100) : 0;

    /* Build a dense daily series so gaps render as zero instead of vanishing. */
    const trendMap = new Map(
      trendRows.map((row: { _id: string; units: number; sales: number }) => [
        row._id,
        { units: row.units, sales: round2(row.sales) },
      ]),
    );

    const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: BUSINESS_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    const salesTrend: Array<{ date: string; units: number; sales: number }> = [];

    for (let i = days - 1; i >= 0; i--) {
      const key = dayKeyFormatter.format(new Date(Date.now() - i * DAY_MS));
      const day = trendMap.get(key);

      salesTrend.push({ date: key, units: day?.units ?? 0, sales: day?.sales ?? 0 });
    }

    const averageDailyUnits = unitsSold / salesTrend.length;

    return res.status(200).json({
      product: {
        _id: product._id.toString(),
        name: product.name,
        category: product.category,
        imageUrl: product.imageUrl,
        price: product.price,
        cost: product.cost,
        stock: product.stock,
      },

      performance: {
        unitsSold,
        orders: totals.orders ?? 0,
        sales,
        cost: productCost,
        deliveryCost,
        profit,
        averageSellingPrice,
        profitMargin,

        /* Capital consumed per sold unit. */
        averageCost: unitsSold > 0 ? round2(productCost / unitsSold) : 0,

        /* Delivery cost consumed per sold unit. */
        deliveryCostPerUnit: unitsSold > 0 ? round2(deliveryCost / unitsSold) : 0,

        /* Money collected for delivery - shown for transparency only.
           It is never part of product sales. */
        deliveryCollected: round2(totals.deliveryCharged ?? 0),
      },

      pricing: {
        defaultPrice: product.price,
        defaultCost: product.cost,
        averageSellingPrice,
        difference: priceDifference,
        differencePercent: priceDifferencePercent,
        /* True when the real average is below the list price (discounting). */
        soldBelowDefault: priceDifference < 0,
      },

      inventory: {
        currentStock: product.stock,
        lowStockThreshold: LOW_STOCK_THRESHOLD,
        outOfStock: product.stock === 0,
        lowStock: product.stock > 0 && product.stock <= LOW_STOCK_THRESHOLD,
        /* Straight-line cover: stock divided by the average daily sales rate
           inside the trend window. Only meaningful with real history. */
        daysOfStockLeft:
          averageDailyUnits > 0
            ? Math.round((product.stock / averageDailyUnits) * 10) / 10
            : null,
      },

      pending: {
        orders: pending.orders ?? 0,
        units: pending.units ?? 0,
      },

      trendDays: days,
      salesTrend,
      recentOrders: recentRows,

      /* Only verifiable facts, never invented recommendations. */
      attention: {
        outOfStock: product.stock === 0,
        lowStock: product.stock > 0 && product.stock <= LOW_STOCK_THRESHOLD,
        neverSold: unitsSold === 0,
        soldBelowDefaultPrice: priceDifference < 0,
        profitNegative: profit < 0,
        otherProductsNeedingRestock: otherLowStock.map((item) => ({
          _id: item._id.toString(),
          name: item.name,
          stock: item.stock,
        })),
      },
    });
  } catch (error) {
    console.error("Failed to fetch product stats:", error);

    return res.status(500).json({ message: "Failed to fetch product stats" });
  }
});

export default router;
