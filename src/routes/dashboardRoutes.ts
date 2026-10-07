import { Router } from "express";
import Order, { type IOrder, type IOrderItem } from "../models/Orders.js";
import Product from "../models/Product.js";
import {
  BUSINESS_TIMEZONE,
  DAY_MS,
  businessDayLabel,
  startOfDayInTimeZone,
} from "../lib/date.js";

const router = Router();
const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

async function addProductImages(orders: IOrder[]) {
  const productIds = [
    ...new Set(
      orders.flatMap((order) =>
        order.items.map((item: IOrderItem) => item.productId.toString()),
      ),
    ),
  ];

  if (productIds.length === 0) {
    return orders;
  }

  const products = await Product.find({
    _id: { $in: productIds },
  }).select("_id imageUrl");

  const imageMap = new Map(
    products.map((product) => [product._id.toString(), product.imageUrl]),
  );

  return orders.map((order) => {
    const orderObject = order.toObject();

    return {
      ...orderObject,
      items: orderObject.items.map((item: IOrderItem) => ({
        ...item,
        imageUrl: imageMap.get(item.productId.toString()),
      })),
    };
  });
}

router.get("/", async (_req, res) => {
  try {
    const now = new Date();

    /*
     * "Today" is a Beirut business day, not a day in the server's timezone.
     * Deriving these boundaries from the Node process clock
     * (new Date().setHours(0, 0, 0, 0)) anchored "today" to the host:
     * on a UTC server the window opened at 03:00 Beirut, so orders placed
     * between midnight and 03:00 were excluded from today's KPIs and counted
     * as yesterday instead — false zeros. Same helper used by /api/reports.
     */
    const startOfToday = startOfDayInTimeZone(now, BUSINESS_TIMEZONE);

    const startOfYesterday = startOfDayInTimeZone(
      new Date(now.getTime() - DAY_MS),
      BUSINESS_TIMEZONE,
    );

    const startOfSalesWindow = startOfDayInTimeZone(
      new Date(now.getTime() - 6 * DAY_MS),
      BUSINESS_TIMEZONE,
    );
    type WindowRow = {
      _id: "Pending" | "Delivered" | "Cancelled";
      orders: number;
      sales: number;
      profit: number;
    };
    type DailyRow = { _id: string; sales: number };
    type StatusRow = { _id: "Pending" | "Delivered" | "Cancelled"; value: number };

    const windowStages = (from: Date, to?: Date) => [
      {
        $match: {
          createdAt: { $gte: from, ...(to ? { $lt: to } : {}) },
        },
      },
      {
        $group: {
          _id: "$status",
          orders: { $sum: 1 },
          sales: {
            $sum: {
              $cond: [{ $ne: ["$status", "Cancelled"] }, "$total", 0],
            },
          },
          profit: {
            $sum: {
              $cond: [{ $ne: ["$status", "Cancelled"] }, "$profit", 0],
            },
          },
        },
      },
    ];

    const [
      todayRows,
      yesterdayRows,
      salesRows,
      statusRows,
      recentOrders,
    ] = await Promise.all([
      Order.aggregate<WindowRow>(windowStages(startOfToday)),
      Order.aggregate<WindowRow>(
        windowStages(startOfYesterday, startOfToday),
      ),
      Order.aggregate<DailyRow>([
        { $match: { createdAt: { $gte: startOfSalesWindow }, status: { $ne: "Cancelled" } } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$createdAt",
                timezone: BUSINESS_TIMEZONE,
              },
            },
            sales: { $sum: "$total" },
          },
        },
      ]),
      Order.aggregate<StatusRow>([
        { $group: { _id: "$status", value: { $sum: 1 } } },
      ]),
      Order.find().sort({ createdAt: -1 }).limit(10),
    ]);

    const summarizeWindow = (rows: WindowRow[]) => {
      const active = rows.filter((row) => row._id !== "Cancelled");
      return {
        sales: active.reduce((sum, row) => sum + row.sales, 0),
        profit: active.reduce((sum, row) => sum + row.profit, 0),
        orders: active.reduce((sum, row) => sum + row.orders, 0),
        pending: rows.find((row) => row._id === "Pending")?.orders ?? 0,
      };
    };
    const today = summarizeWindow(todayRows);
    const yesterday = summarizeWindow(yesterdayRows);
    const salesByDate = new Map(salesRows.map((row) => [row._id, row.sales]));
    const salesData = [];

    for (let i = 0; i < 7; i++) {
      const date = startOfDayInTimeZone(
        new Date(now.getTime() - (6 - i) * DAY_MS),
        BUSINESS_TIMEZONE,
      );
      salesData.push({
        date: businessDayLabel(date),
        sales: salesByDate.get(dayKeyFormatter.format(date)) ?? 0,
      });
    }

    const statusCounts = new Map(
      statusRows.map((row) => [row._id, row.value]),
    );
    const delivered = statusCounts.get("Delivered") ?? 0;
    const pending = statusCounts.get("Pending") ?? 0;
    const cancelled = statusCounts.get("Cancelled") ?? 0;
    const totalOrders = delivered + pending + cancelled;

    const recentOrdersWithImages = await addProductImages(recentOrders);

    return res.status(200).json({
      stats: {
        todaySales: today.sales,
        todayProfit: today.profit,
        todayOrders: today.orders,
        todayPendingOrders: today.pending,

        yesterdaySales: yesterday.sales,
        yesterdayProfit: yesterday.profit,
        yesterdayOrders: yesterday.orders,
        yesterdayPendingOrders: yesterday.pending,
      },

      salesData,

      orderStatus: [
        {
          label: "Delivered",
          value: delivered,
        },
        {
          label: "Pending",
          value: pending,
        },
        {
          label: "Cancelled",
          value: cancelled,
        },
      ],

      recentOrders: recentOrdersWithImages,
      totalOrders,
    });
  } catch (error) {
    console.error("Failed to fetch dashboard data:", error);

    return res.status(500).json({
      message: "Failed to fetch dashboard data",
    });
  }
});

export default router;
