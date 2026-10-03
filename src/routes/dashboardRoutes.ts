import { Router } from "express";
import Order from "../models/Orders.js";
import {
  BUSINESS_TIMEZONE,
  DAY_MS,
  businessDayLabel,
  startOfDayInTimeZone,
} from "../lib/date.js";


const router = Router();

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

    const [allOrders, todayOrders, yesterdayOrders, recentOrders] =
      await Promise.all([
        Order.find().sort({ createdAt: -1 }),
        Order.find({
          createdAt: { $gte: startOfToday },
        }),
        Order.find({
          createdAt: {
            $gte: startOfYesterday,
            $lt: startOfToday,
          },
        }),
        Order.find().sort({ createdAt: -1 }).limit(10),
      ]);

    const activeTodayOrders = todayOrders.filter(
      (order) => order.status !== "Cancelled",
    );

    const activeYesterdayOrders = yesterdayOrders.filter(
      (order) => order.status !== "Cancelled",
    );

    const todaySales = activeTodayOrders.reduce(
      (total, order) => total + order.total,
      0,
    );

    const todayProfit = activeTodayOrders.reduce(
      (total, order) => total + order.profit,
      0,
    );

    const yesterdaySales = activeYesterdayOrders.reduce(
      (total, order) => total + order.total,
      0,
    );

    const yesterdayProfit = activeYesterdayOrders.reduce(
      (total, order) => total + order.profit,
      0,
    );

    const todayOrderCount = activeTodayOrders.length;
    const yesterdayOrderCount = activeYesterdayOrders.length;

    const todayPendingOrders = todayOrders.filter(
      (order) => order.status === "Pending",
    ).length;

    const yesterdayPendingOrders = yesterdayOrders.filter(
      (order) => order.status === "Pending",
    ).length;

    const salesData = [];

    // 7 Beirut business days ending today (each bucket is a real
    // midnight-to-midnight window in Asia/Beirut, not in the host timezone).
    for (let i = 0; i < 7; i++) {
      const date = startOfDayInTimeZone(
        new Date(now.getTime() - (6 - i) * DAY_MS),
        BUSINESS_TIMEZONE,
      );

      const nextDate = startOfDayInTimeZone(
        new Date(now.getTime() - (5 - i) * DAY_MS),
        BUSINESS_TIMEZONE,
      );

      const dayOrders = allOrders.filter(
        (order) =>
          order.createdAt >= date &&
          order.createdAt < nextDate &&
          order.status !== "Cancelled",
      );

      const sales = dayOrders.reduce((total, order) => total + order.total, 0);

      salesData.push({
        date: businessDayLabel(date),
        sales,
      });
    }

    const delivered = allOrders.filter(
      (order) => order.status === "Delivered",
    ).length;

    const pending = allOrders.filter(
      (order) => order.status === "Pending",
    ).length;

    const cancelled = allOrders.filter(
      (order) => order.status === "Cancelled",
    ).length;

    const totalOrders = allOrders.length;

    return res.status(200).json({
      stats: {
        todaySales,
        todayProfit,
        todayOrders: todayOrderCount,
        todayPendingOrders,

        yesterdaySales,
        yesterdayProfit,
        yesterdayOrders: yesterdayOrderCount,
        yesterdayPendingOrders,
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

      recentOrders,
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
