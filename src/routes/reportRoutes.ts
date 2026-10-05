import { Router } from "express";
import Order from "../models/Orders.js";
import {
  BUSINESS_TIMEZONE as TIMEZONE,
  DAY_MS,
  startOfDayInTimeZone,
} from "../lib/date.js";

const router = Router();

/*
 * The business runs on Beirut time. The day-boundary helpers come from
 * ../lib/date.js so the dashboard and reports endpoints always agree on what
 * "today" means.
 */

const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dayLabelFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  weekday: "short",
});

function dayKey(date: Date) {
  return dayKeyFormatter.format(date);
}

router.get("/", async (req, res) => {
  try {
    const range = req.query.range === "30" ? 30 : 7;

    // Beirut midnight "today", expressed as a real UTC instant.
    const startOfToday = startOfDayInTimeZone(new Date(), TIMEZONE);

    // First day of the window (range - 1 days ago, inclusive).
    const startOfWindow = new Date(startOfToday.getTime() - (range - 1) * DAY_MS);

    const activeOrders = { $match: { status: { $ne: "Cancelled" } } };

    const [summaryResult, statusResult, salesResult, topProducts] =
      await Promise.all([
        /*
         * Whole-order totals over every non-cancelled order.
         * Delivery values stay separate from product revenue.
         */
        Order.aggregate([
          activeOrders,
          {
            $group: {
              _id: null,
              totalSales: { $sum: "$total" },
              totalProfit: { $sum: "$profit" },
              deliveryRevenue: { $sum: "$deliveryCharged" },
              deliveryCost: { $sum: "$deliveryCost" },
              activeOrders: { $sum: 1 },
            },
          },
        ]),

        // Status distribution over every order.
        Order.aggregate([{ $group: { _id: "$status", value: { $sum: 1 } } }]),

        /*
         * Daily sales/profit for the selected window, grouped by the
         * Beirut calendar day.
         */
        Order.aggregate([
          {
            $match: {
              status: { $ne: "Cancelled" },
              createdAt: { $gte: startOfWindow },
            },
          },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$createdAt",
                  timezone: TIMEZONE,
                },
              },
              sales: { $sum: "$total" },
              profit: { $sum: "$profit" },
            },
          },
          { $sort: { _id: 1 } },
        ]),

        /*
         * Top products by revenue, using each item's historical
         * unitPrice/unitCost snapshot.
         *
         * Profit here is delivery-INCLUSIVE so it reconciles with the
         * Summary's totalProfit (which sums order.profit =
         * total - itemsCost - deliveryCost).
         *
         * An order's net delivery (deliveryCharged - deliveryCost) is not
         * attributable to any single product, so it is split across the
         * order's items proportionally to each item's revenue:
         *   share      = itemRevenue / itemsTotal
         *                  (or 1 / itemCount when itemsTotal = 0)
         *   itemProfit = qty * (unitPrice - unitCost) + netDelivery * share
         *
         * Summing itemProfit over an order therefore yields exactly the
         * stored order.profit. itemsTotal / itemCount / netDelivery are
         * computed at the ORDER level before $unwind, because after $unwind
         * they no longer exist.
         */
        Order.aggregate([
          activeOrders,
          {
            $set: {
              __itemsTotal: {
                $sum: {
                  $map: {
                    input: { $ifNull: ["$items", []] },
                    as: "line",
                    in: {
                      $multiply: ["$$line.quantity", "$$line.unitPrice"],
                    },
                  },
                },
              },
              __itemsCount: {
                $size: { $ifNull: ["$items", []] },
              },
              __netDelivery: {
                $subtract: [
                  { $ifNull: ["$deliveryCharged", 0] },
                  { $ifNull: ["$deliveryCost", 0] },
                ],
              },
            },
          },
          { $unwind: "$items" },
          {
            $set: {
              __itemRevenue: {
                $multiply: ["$items.quantity", "$items.unitPrice"],
              },
            },
          },
          {
            $set: {
              __share: {
                $cond: [
                  { $gt: ["$__itemsTotal", 0] },
                  { $divide: ["$__itemRevenue", "$__itemsTotal"] },
                  {
                    $cond: [
                      { $gt: ["$__itemsCount", 0] },
                      { $divide: [1, "$__itemsCount"] },
                      0,
                    ],
                  },
                ],
              },
            },
          },
          {
            $group: {
              _id: "$items.productId",
              name: { $first: "$items.name" },
              units: { $sum: "$items.quantity" },
              orders: { $sum: 1 },
              revenue: { $sum: "$__itemRevenue" },
              profit: {
                $sum: {
                  $add: [
                    {
                      $multiply: [
                        "$items.quantity",
                        { $subtract: ["$items.unitPrice", "$items.unitCost"] },
                      ],
                    },
                    { $multiply: ["$__netDelivery", "$__share"] },
                  ],
                },
              },
            },
          },
          { $sort: { revenue: -1 } },
          { $limit: 5 },
          {
            $project: {
              _id: 0,
              name: 1,
              units: 1,
              orders: 1,
              revenue: 1,
              profit: { $round: ["$profit", 2] },
            },
          },
        ]),
      ]);

      const summary = summaryResult[0] ?? {
        totalSales: 0,
        totalProfit: 0,
        deliveryRevenue: 0,
        deliveryCost: 0,
        activeOrders: 0,
      };

      const statusMap = new Map<string, number>(
        statusResult.map((item) => [item._id, item.value]),
      );

      const pendingOrders = statusMap.get("Pending") ?? 0;
      const deliveredOrders = statusMap.get("Delivered") ?? 0;
      const cancelledOrders = statusMap.get("Cancelled") ?? 0;

      const totalOrders = pendingOrders + deliveredOrders + cancelledOrders;

      const averageOrderValue =
        summary.activeOrders > 0 ? summary.totalSales / summary.activeOrders : 0;

      const profitMargin =
        summary.totalSales > 0
          ? (summary.totalProfit / summary.totalSales) * 100
          : 0;

      const deliveryRate =
        totalOrders > 0 ? (deliveredOrders / totalOrders) * 100 : 0;

      const salesByDay = new Map<string, { sales: number; profit: number }>(
        salesResult.map((item) => [
          item._id,
          { sales: item.sales, profit: item.profit },
        ]),
      );

      /*
       * Build the bucket list in the business timezone so the earliest day
       * is fully included and empty days still appear on the chart.
       */
      const salesData = [];

      for (let i = range - 1; i >= 0; i--) {
        const date = new Date(startOfToday.getTime() - i * DAY_MS);
        const key = dayKey(date);
        const data = salesByDay.get(key);

        salesData.push({
          date: key,
          day: dayLabelFormatter.format(date),
          sales: data?.sales ?? 0,
          profit: data?.profit ?? 0,
        });
      }

      return res.status(200).json({
        range,

        summary: {
          totalSales: summary.totalSales,
          totalProfit: summary.totalProfit,
          totalOrders,
          activeOrders: summary.activeOrders,
          averageOrderValue,
          pendingOrders,
          deliveredOrders,
          cancelledOrders,
          deliveryRevenue: summary.deliveryRevenue,
          deliveryCost: summary.deliveryCost,
          profitMargin,
          deliveryRate,
        },

        salesData,

        topProducts,

        orderStatus: [
          { name: "Delivered", value: deliveredOrders },
          { name: "Pending", value: pendingOrders },
          { name: "Cancelled", value: cancelledOrders },
        ],
      });
  } catch (error) {
    console.error("Failed to fetch reports:", error);

    return res.status(500).json({
      message: "Failed to fetch reports",
    });
  }
});

export default router;
