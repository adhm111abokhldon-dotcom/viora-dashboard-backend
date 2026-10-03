import { Router, type Response } from "express";
import mongoose, { type ClientSession, type Types } from "mongoose";

import {
  createOrderSchema,
  updateOrderSchema,
  updateOrderStatusSchema,
} from "../schemas/orderSchemas.js";
import Order, { type IOrderItem } from "../models/Orders.js";
import Product from "../models/Product.js";
import { calcOrder } from "../lib/calcOrder.js";

const router = Router();

// يمنع أخطاء regex لو المستخدم كتب رموز خاصة بالبحث.
const escapeRegex = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type InputItem = {
  productId: string;
  quantity: number;
  unitPrice: number;
};

class OrderError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function fail(res: Response, error: unknown, fallbackMessage: string) {
  if (error instanceof OrderError) {
    return res.status(error.status).json({ message: error.message });
  }

  console.error(fallbackMessage, error);

  return res.status(500).json({ message: fallbackMessage });
}

async function runInTransaction<T>(
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = await mongoose.startSession();

  try {
    let result!: T;

    await session.withTransaction(async () => {
      result = await work(session);
    });

    return result;
  } finally {
    await session.endSession();
  }
}

async function reserveOne(
  productId: string | Types.ObjectId,
  quantity: number,
  session: ClientSession,
) {
  const product = await Product.findOneAndUpdate(
    {
      _id: productId,
      stock: { $gte: quantity },
    },
    {
      $inc: { stock: -quantity },
    },
    {
      new: true,
      session,
    },
  );

  if (product) return product;

  const existing = await Product.findById(productId).session(session);

  throw new OrderError(
    existing
      ? `Not enough stock for ${existing.name}. Available: ${existing.stock}`
      : "Product not found",
  );
}

async function releaseStock(items: IOrderItem[], session: ClientSession) {
  for (const item of items) {
    await Product.updateOne(
      { _id: item.productId },
      { $inc: { stock: item.quantity } },
      { session },
    );
  }
}

async function buildLines(
  items: InputItem[],
  session: ClientSession,
  reserve: boolean,
  previous: IOrderItem[] = [],
): Promise<IOrderItem[]> {
  const previousCost = new Map(
    previous.map((item) => [item.productId.toString(), item.unitCost]),
  );

  const lines: IOrderItem[] = [];

  for (const item of items) {
    let product;

    if (reserve) {
      product = await reserveOne(item.productId, item.quantity, session);
    } else {
      product = await Product.findById(item.productId).session(session);

      if (!product) {
        throw new OrderError("Product not found");
      }
    }

    lines.push({
      productId: product._id,
      name: product.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,

      // إذا المنتج موجود بالأوردر القديم:
      // حافظ على كلفته القديمة.
      // إذا منتج جديد:
      // خذ الكلفة الحالية من Product.
      unitCost: previousCost.get(item.productId) ?? product.cost,
    });
  }

  return lines;
}

function hasInvalidProductId(items: InputItem[]) {
  return items.some((item) => !mongoose.isValidObjectId(item.productId));
}

/* -------------------------------------------------------------------------- */
/* GET /api/orders                                                            */
/* -------------------------------------------------------------------------- */

router.get("/", async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);

    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);

    const skip = (page - 1) * limit;

    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";

    const status =
      typeof req.query.status === "string" ? req.query.status : "all";

    const filter: Record<string, unknown> = {};

    /*
     * Search by:
     * - customer
     * - phone
     * - product name inside order items
     */
    if (search) {
      const escaped = escapeRegex(search);

      filter.$or = [
        { customer: { $regex: escaped, $options: "i" } },
        { phone: { $regex: escaped, $options: "i" } },
        { "items.name": { $regex: escaped, $options: "i" } },
      ];
    }

    /*
     * Status filter
     */
    if (
      status === "Pending" ||
      status === "Delivered" ||
      status === "Cancelled"
    ) {
      filter.status = status;
    }

    const [orders, totalOrders, statsResult] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),

      Order.countDocuments(filter),

      /*
       * Stats are calculated from all matching orders,
       * not only the current page.
       *
       * Cancelled orders are excluded from revenue/profit
       * because they are not completed sales.
       */
      Order.aggregate([
        { $match: filter },

        {
          $group: {
            _id: null,

            totalOrders: { $sum: 1 },

            pendingOrders: {
              $sum: {
                $cond: [{ $eq: ["$status", "Pending"] }, 1, 0],
              },
            },

            deliveredOrders: {
              $sum: {
                $cond: [{ $eq: ["$status", "Delivered"] }, 1, 0],
              },
            },

            revenue: {
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
      ]),
    ]);

    const totalPages = Math.ceil(totalOrders / limit);

    const stats = statsResult[0] ?? {
      totalOrders: 0,
      pendingOrders: 0,
      deliveredOrders: 0,
      revenue: 0,
      profit: 0,
    };

    return res.status(200).json({
      orders,

      pagination: {
        currentPage: page,
        limit,
        totalOrders,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },

      stats: {
        totalOrders: stats.totalOrders,
        pendingOrders: stats.pendingOrders,
        deliveredOrders: stats.deliveredOrders,
        revenue: stats.revenue,
        profit: stats.profit,
      },
    });
  } catch (error) {
    return fail(res, error, "Failed to fetch orders");
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/orders/:id                                                        */
/* -------------------------------------------------------------------------- */

router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        message: "Invalid order ID",
      });
    }

    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        message: "Order not found",
      });
    }

    return res.status(200).json(order);
  } catch (error) {
    return fail(res, error, "Failed to fetch order");
  }
});

/* -------------------------------------------------------------------------- */
/* POST /api/orders                                                           */
/* -------------------------------------------------------------------------- */

router.post("/", async (req, res) => {
  const result = createOrderSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      message: "Invalid order data",
      errors: result.error.issues,
    });
  }

  const { customer, phone, items, deliveryCharged, deliveryCost } = result.data;

  if (hasInvalidProductId(items)) {
    return res.status(400).json({
      message: "Invalid product ID",
    });
  }

  try {
    const order = await runInTransaction(async (session) => {
      // حجز المخزون يتم داخل transaction
      const lines = await buildLines(items, session, true);

      const { total, profit } = calcOrder(lines, deliveryCharged, deliveryCost);

      const [created] = await Order.create(
        [
          {
            customer,
            phone,
            items: lines,
            deliveryCharged,
            deliveryCost,
            total,
            profit,
            status: "Pending",
          },
        ],
        { session },
      );

      return created;
    });

    return res.status(201).json(order);
  } catch (error) {
    return fail(res, error, "Failed to create order");
  }
});

/* -------------------------------------------------------------------------- */
/* PUT /api/orders/:id                                                        */
/* -------------------------------------------------------------------------- */

router.put("/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({
      message: "Invalid order ID",
    });
  }

  const result = updateOrderSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      message: "Invalid order data",
      errors: result.error.issues,
    });
  }

  const { customer, phone, items, deliveryCharged, deliveryCost } = result.data;

  if (hasInvalidProductId(items)) {
    return res.status(400).json({
      message: "Invalid product ID",
    });
  }

  try {
    const updated = await runInTransaction(async (session) => {
      const order = await Order.findById(req.params.id).session(session);

      if (!order) {
        throw new OrderError("Order not found", 404);
      }

      // Only pending orders can be edited.
      // Delivered and cancelled orders are historical and must not change.
      if (order.status !== "Pending") {
        throw new OrderError(
          `Only pending orders can be edited. This order is ${order.status}.`,
        );
      }

      // Pending orders always have their stock reserved.
      const isActive = true;

      /*
       * Pending:
       * المخزون الحالي ناقص منه مخزون هذا الأوردر.
       *
       * لذلك:
       * 1. نرجع القديم
       * 2. نحجز الجديد
       *
       * كل هذا داخل transaction.
       *
       * إذا الحجز الجديد فشل، transaction كاملة تنعمل rollback.
       */
      if (isActive) {
        await releaseStock(order.items, session);
      }

      const lines = await buildLines(items, session, isActive, order.items);

      const { total, profit } = calcOrder(lines, deliveryCharged, deliveryCost);

      order.set({
        customer,
        phone,
        items: lines,
        deliveryCharged,
        deliveryCost,
        total,
        profit,
      });

      await order.save({ session });

      return order;
    });

    return res.status(200).json(updated);
  } catch (error) {
    return fail(res, error, "Failed to update order");
  }
});

/* -------------------------------------------------------------------------- */
/* DELETE /api/orders/:id                                                     */
/* -------------------------------------------------------------------------- */

router.delete("/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({
      message: "Invalid order ID",
    });
  }

  try {
    await runInTransaction(async (session) => {
      const order = await Order.findById(req.params.id).session(session);

      if (!order) {
        throw new OrderError("Order not found", 404);
      }

      /*
       * Pending:
       * المخزون لسا محجوز → رجّعه.
       *
       * Delivered:
       * البضاعة طلعت → لا ترجع stock.
       *
       * Cancelled:
       * المخزون رجع وقت الإلغاء → لا ترجعه مرة ثانية.
       */
      if (order.status === "Pending") {
        await releaseStock(order.items, session);
      }

      await Order.deleteOne({ _id: order._id }, { session });
    });

    return res.status(200).json({
      message: "Order deleted successfully",
    });
  } catch (error) {
    return fail(res, error, "Failed to delete order");
  }
});

/* -------------------------------------------------------------------------- */
/* PATCH /api/orders/:id/status                                               */
/* -------------------------------------------------------------------------- */

router.patch("/:id/status", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({
      message: "Invalid order ID",
    });
  }

  const result = updateOrderStatusSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      message: "Invalid order status",
      errors: result.error.issues,
    });
  }

  const newStatus = result.data.status;

  try {
    const updated = await runInTransaction(async (session) => {
      const order = await Order.findById(req.params.id).session(session);

      if (!order) {
        throw new OrderError("Order not found", 404);
      }

      if (order.status === newStatus) {
        throw new OrderError("Order already has this status");
      }

      /*
       * Allowed transitions:
       *
       * Pending   → Delivered
       * Pending   → Cancelled
       * Delivered → Cancelled
       *
       * Not allowed:
       *
       * Delivered → Pending
       * Cancelled → Pending
       * Cancelled → Delivered
       */

      // Pending → Delivered
      // الطلب تسلّم لشركة الدليفري.
      // المخزون لا يتغير.
      if (order.status === "Pending" && newStatus === "Delivered") {
        order.status = "Delivered";
      }

      // Pending → Cancelled
      // الطلب انلغى قبل تسليمه للدليفري.
      // رجّع المخزون.
      else if (order.status === "Pending" && newStatus === "Cancelled") {
        await releaseStock(order.items, session);

        order.status = "Cancelled";
      }

      // Delivered → Cancelled
      // الطلب كان مسلّم للدليفري لكن صار فيه مشكلة.
      // لا نرجّع المخزون لأنه خرج من عندنا.
      else if (order.status === "Delivered" && newStatus === "Cancelled") {
        order.status = "Cancelled";
      }

      // أي انتقال آخر غير مسموح.
      else {
        throw new OrderError(
          `Cannot change order status from ${order.status} to ${newStatus}`,
        );
      }

      await order.save({ session });

      return order;
    });

    return res.status(200).json(updated);
  } catch (error) {
    return fail(res, error, "Failed to update order status");
  }
});

export default router;
