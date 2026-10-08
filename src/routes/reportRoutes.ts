import { Router } from "express";
import Order from "../models/Orders.js";
import AdvertisingExpense from "../models/AdvertisingExpense.js";
import {
  BUSINESS_TIMEZONE as TIMEZONE,
  DAY_MS,
  startOfDayInTimeZone,
} from "../lib/date.js";
import {
  itemPrologue,
  groupByProductAndOrder,
  rollupByProduct,
} from "../lib/productStats.js";
import {
  getProductTotalsFrom,
  startOfWindowForRange,
} from "../lib/orderTotals.js";
import { round2 } from "../lib/money.js";
import { excludeUnmappedWindsorAccountsFilter } from "../lib/adAccounts.js";

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
    const range: "all" | 7 | 30 =
      req.query.range === "7" ? 7 : req.query.range === "30" ? 30 : "all";

    // Beirut midnight "today", expressed as a real UTC instant.
    const startOfToday = startOfDayInTimeZone(new Date(), TIMEZONE);

    // First day of the window (range - 1 days ago, inclusive).
    // Shared with /api/advertising/insights so both pick the same days.
    const startOfWindow =
      range === "all" ? undefined : startOfWindowForRange(range);

    /*
     * Business rule: only Delivered orders are completed sales. Pending and
     * Cancelled never contribute to revenue, cost or profit.
     */

    /* The default is all historical data; optional windows are user selected. */
    const inWindow = {
      $match: {
        status: "Delivered",
        ...(startOfWindow ? { createdAt: { $gte: startOfWindow } } : {}),
      },
    };

    const [
      summaryResult,
      statusResult,
      deliveryResult,
      salesResult,
      topProducts,
      adsResult,
    ] =
      await Promise.all([
        /*
         * Product-level totals over delivered orders in the window.
         * Product revenue excludes deliveryCharged, which is reported
         * separately as deliveryRevenue. Shared with /advertising/insights.
         */
        getProductTotalsFrom(startOfWindow),

        // Status distribution over every order (operational view, all time).
        Order.aggregate([{ $group: { _id: "$status", value: { $sum: 1 } } }]),

        /* Delivery money collected vs. paid, in the window. */
        Order.aggregate([
          inWindow,
          {
            $group: {
              _id: null,
              deliveryRevenue: { $sum: "$deliveryCharged" },
            },
          },
        ]),

        /*
         * Daily sales/profit for the selected window, grouped by the
         * Beirut calendar day.
         */
        Order.aggregate([
          inWindow,
          ...itemPrologue(),
          groupByProductAndOrder,
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$createdAt",
                  timezone: TIMEZONE,
                },
              },
              sales: { $sum: "$revenue" },
              profit: { $sum: "$profit" },
            },
          },
          { $sort: { _id: 1 } },
        ]),

        /*
         * Top products by product revenue, using each item's historical
         * unitPrice/unitCost snapshot. Delivery cost is allocated across the
         * order's items (see lib/productStats.ts).
         */
        Order.aggregate([
          inWindow,
          ...itemPrologue(),
          groupByProductAndOrder,
          rollupByProduct,
          { $sort: { revenue: -1 } },
          { $limit: 5 },
          {
            $project: {
              _id: 0,
              name: 1,
              units: 1,
              orders: 1,
              revenue: { $round: ["$revenue", 2] },
              profit: { $round: ["$profit", 2] },
            },
          },
        ]),

        /* Advertising spend inside the same window. */
        AdvertisingExpense.aggregate([
          {
            $match: {
              ...(startOfWindow ? { date: { $gte: startOfWindow } } : {}),
              ...excludeUnmappedWindsorAccountsFilter(),
            },
          },
          { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
        ]),
      ]);

    // summaryResult is already the totals object (see lib/orderTotals.ts).
    const totals = summaryResult;
    const delivery = deliveryResult[0] ?? {};
    const ads = adsResult[0] ?? {};

    const productSales = round2(totals.productSales);
    const productCost = round2(totals.productCost);
    const deliveryCost = round2(totals.deliveryCost);
    const productProfit = round2(totals.productProfit);

    // Manual and Windsor rows are both plain expenses, so a synced row is
    // counted once, in the same total, with no extra filter.
    const advertisingSpend = round2(ads.total ?? 0);

      const statusMap = new Map<string, number>(
        statusResult.map((item: { _id: string; value: number }) => [
          item._id,
          item.value,
        ]),
      );

      const pendingOrders = statusMap.get("Pending") ?? 0;
      const deliveredOrders = statusMap.get("Delivered") ?? 0;
      const cancelledOrders = statusMap.get("Cancelled") ?? 0;

      const totalOrders = pendingOrders + deliveredOrders + cancelledOrders;

      const deliveredInWindow = totals.deliveredOrders ?? 0;

      const averageOrderValue =
        deliveredInWindow > 0 ? productSales / deliveredInWindow : 0;

      const profitMargin = productSales > 0 ? (productProfit / productSales) * 100 : 0;

      const deliveryRate =
        totalOrders > 0 ? (deliveredOrders / totalOrders) * 100 : 0;

      const deliveryCollected = round2(delivery.deliveryRevenue ?? 0);

      /*
       * The money view, in the order the business actually spends it:
       *   Product Sales
       *   - Product Cost
       *   - Delivery Cost
       *   = Product Profit
       *   - Advertising Spend
       *   = Net Profit After Ads
       *
       * deliveryCharged is reported separately as "delivery collected" and is
       * deliberately excluded from Product Sales.
       */
      const netProfitAfterAds = round2(productProfit - advertisingSpend);

      const salesByDay = new Map<string, { sales: number; profit: number }>(
        salesResult.map((item: { _id: string; sales: number; profit: number }) => [
          item._id,
          { sales: round2(item.sales), profit: round2(item.profit) },
        ]),
      );

      /*
       * Build the bucket list in the business timezone so the earliest day
       * is fully included and empty days still appear on the chart.
       */
      const salesData = [];

      if (range === "all") {
        for (const [key, data] of [...salesByDay.entries()].sort(([a], [b]) =>
          a.localeCompare(b),
        )) {
          const date = new Date(`${key}T12:00:00Z`);
          salesData.push({
            date: key,
            day: dayLabelFormatter.format(date),
            sales: data.sales,
            profit: data.profit,
          });
        }
      } else {
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
      }

      return res.status(200).json({
        range,

        /*
         * All figures below describe COMPLETED sales (Delivered orders) inside
         * the selected window. Order Status stays an all-time operational view.
         */
        summary: {
          productSales,
          productCost,
          deliveryCost,
          productProfit,
          unitsSold: totals.units,

          /* Delivered orders INSIDE the window - the completed sales figure. */
          deliveredOrdersInRange: deliveredInWindow,
          averageOrderValue: round2(averageOrderValue),
          profitMargin,
          advertisingSpend,

          /* Operational view: every order ever, regardless of window. */
          totalOrders,
          pendingOrders,
          deliveredOrders,
          cancelledOrders,

          deliveryCollected,
          deliveryNet: round2(deliveryCollected - deliveryCost),
          deliveryRate,
        },

        /*
         * Where the money goes. Advertising lives here only - it is never mixed
         * into historical order or product calculations.
         */
        financials: {
          productSales,
          productCost,
          deliveryCost,
          productProfit,
          deliveryCollected,
          advertisingSpend,
          advertisingCount: ads.count ?? 0,
          netProfitAfterAds,
          netMargin: productSales > 0
            ? round2((netProfitAfterAds / productSales) * 100)
            : 0,
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
