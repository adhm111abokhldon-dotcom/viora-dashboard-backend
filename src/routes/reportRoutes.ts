import { Router } from "express";
import Order from "../models/Orders.js";


const router = Router();

router.get("/", async (_req, res) => {
  try {
    const activeOrders = {
      $match: {
        status: {
          $ne: "Cancelled",
        },
      },
    };

    const [
      summaryResult,
      topProducts,
      orderStatus,
      salesData,
      deliveredResult,
    ] = await Promise.all([
      Order.aggregate([
        activeOrders,
        {
          $group: {
            _id: null,
            totalSales: { $sum: "$total" },
            totalProfit: { $sum: "$profit" },
            totalOrders: { $sum: 1 },
          },
        },
      ]),

      Order.aggregate([
        activeOrders,
        {
          $group: {
            _id: "$productId",
            name: { $first: "$product" },
            orders: { $sum: 1 },
            revenue: { $sum: "$total" },
            profit: { $sum: "$profit" },
          },
        },
        {
          $sort: {
            revenue: -1,
          },
        },
        {
          $limit: 5,
        },
        {
          $project: {
            _id: 0,
            name: 1,
            orders: 1,
            revenue: 1,
            profit: 1,
          },
        },
      ]),

      Order.aggregate([
        {
          $group: {
            _id: "$status",
            value: { $sum: 1 },
          },
        },
        {
          $project: {
            _id: 0,
            name: "$_id",
            value: 1,
          },
        },
      ]),

      Order.aggregate([
        {
          $match: {
            status: {
              $ne: "Cancelled",
            },
            createdAt: {
              $gte: new Date(
                Date.now() - 7 * 24 * 60 * 60 * 1000,
              ),
            },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$createdAt",
              },
            },
            sales: {
              $sum: "$total",
            },
            profit: {
              $sum: "$profit",
            },
          },
        },
        {
          $sort: {
            _id: 1,
          },
        },
      ]),

      Order.aggregate([
        {
          $match: {
            status: "Delivered",
          },
        },
        {
          $count: "count",
        },
      ]),
    ]);

    const summary = summaryResult[0] ?? {
      totalSales: 0,
      totalProfit: 0,
      totalOrders: 0,
    };

    const deliveredOrders = deliveredResult[0]?.count ?? 0;

    const averageOrderValue =
      summary.totalOrders > 0
        ? summary.totalSales / summary.totalOrders
        : 0;

    const deliveryRate =
      summary.totalOrders > 0
        ? (deliveredOrders / summary.totalOrders) * 100
        : 0;

    const profitMargin =
      summary.totalSales > 0
        ? (summary.totalProfit / summary.totalSales) * 100
        : 0;

    const dayNames = [
      "Sun",
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
    ];

    const salesByDate = new Map(
      salesData.map((item) => [
        item._id,
        {
          sales: item.sales,
          profit: item.profit,
        },
      ]),
    );

    const formattedSalesData = [];

    for (let i = 6; i >= 0; i--) {
      const date = new Date();

      date.setDate(date.getDate() - i);

      const dateKey = date.toISOString().split("T")[0];

      const data = salesByDate.get(dateKey);

      formattedSalesData.push({
        day: dayNames[date.getDay()],
        sales: data?.sales ?? 0,
        profit: data?.profit ?? 0,
      });
    }

    const statusOrder = [
      "Delivered",
      "Pending",
      "Cancelled",
    ];

    const statusMap = new Map(
      orderStatus.map((item) => [
        item.name,
        item.value,
      ]),
    );

    const formattedOrderStatus = statusOrder.map(
      (status) => ({
        name: status,
        value: statusMap.get(status) ?? 0,
      }),
    );

    return res.status(200).json({
      summary: {
        totalSales: summary.totalSales,
        totalProfit: summary.totalProfit,
        totalOrders: summary.totalOrders,
        averageOrderValue,
      },

      salesData: formattedSalesData,

      topProducts,

      orderStatus: formattedOrderStatus,

      snapshot: {
        deliveredOrders,
        deliveryRate,
        profitMargin,
      },
    });
  } catch (error) {
    console.error("Failed to fetch reports:", error);

    return res.status(500).json({
      message: "Failed to fetch reports",
    });
  }
});

export default router;