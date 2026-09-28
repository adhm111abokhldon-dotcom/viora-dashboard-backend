import { Router } from "express";
import Order from "../models/Orders.js";


const router = Router();

router.get("/", async (_req, res) => {
  try {
    const now = new Date();

    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const startOfYesterday = new Date(startOfToday);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);

    const startOfSevenDaysAgo = new Date(startOfToday);
    startOfSevenDaysAgo.setDate(startOfSevenDaysAgo.getDate() - 6);

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

    for (let i = 0; i < 7; i++) {
      const date = new Date(startOfSevenDaysAgo);
      date.setDate(startOfSevenDaysAgo.getDate() + i);

      const nextDate = new Date(date);
      nextDate.setDate(date.getDate() + 1);

      const dayOrders = allOrders.filter(
        (order) =>
          order.createdAt >= date &&
          order.createdAt < nextDate &&
          order.status !== "Cancelled",
      );

      const sales = dayOrders.reduce((total, order) => total + order.total, 0);

      salesData.push({
        date: date.toLocaleDateString("en-US", {
          weekday: "short",
        }),
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
