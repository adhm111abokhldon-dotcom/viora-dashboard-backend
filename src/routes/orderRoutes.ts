import { Router } from "express";
import mongoose from "mongoose";

import {
  createOrderSchema,
  updateOrderSchema,
  updateOrderStatusSchema,
} from "../schemas/orderSchemas.js";
import Order from "../models/Orders.js";
import Product from "../models/Product.js";

const router = Router();

/**
 * GET /api/orders
 * Get all orders with pagination
 */
router.get("/", async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);

    const skip = (page - 1) * limit;

    const [orders, totalOrders] = await Promise.all([
      Order.find().sort({ createdAt: -1 }).skip(skip).limit(limit),

      Order.countDocuments(),
    ]);

    const totalPages = Math.ceil(totalOrders / limit);

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
    });
  } catch (error) {
    console.error("Failed to fetch orders:", error);

    return res.status(500).json({
      message: "Failed to fetch orders",
    });
  }
});

/**
 * GET /api/orders/:id
 * Get one order
 */
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
    console.error("Failed to fetch order:", error);

    return res.status(500).json({
      message: "Failed to fetch order",
    });
  }
});

/**
 * POST /api/orders
 * Create a new order
 */
router.post("/", async (req, res) => {
  try {
    const result = createOrderSchema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        message: "Invalid order data",
        errors: result.error.issues,
      });
    }

    const { customer, phone, productId, quantity, price } = result.data;

    if (!mongoose.isValidObjectId(productId)) {
      return res.status(400).json({
        message: "Invalid product ID",
      });
    }

    const product = await Product.findById(productId);

    if (!product) {
      return res.status(404).json({
        message: "Product not found",
      });
    }

    if (product.stock < quantity) {
      return res.status(400).json({
        message: `Not enough stock. Available stock: ${product.stock}`,
      });
    }

    const total = price * quantity;

    const profit = (price - product.cost) * quantity;

    product.stock -= quantity;

    await product.save();

    const order = await Order.create({
      customer,
      phone,
      productId: product._id,
      product: product.name,
      quantity,
      price,
      total,
      profit,
      status: "Pending",
    });

    return res.status(201).json(order);
  } catch (error) {
    console.error("Failed to create order:", error);

    return res.status(500).json({
      message: "Failed to create order",
    });
  }
});

router.put("/:id", async (req, res) => {
  try {
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

    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        message: "Order not found",
      });
    }

    const { customer, phone, productId, quantity, price } = result.data;

    if (!mongoose.isValidObjectId(productId)) {
      return res.status(400).json({
        message: "Invalid product ID",
      });
    }

    const newProduct = await Product.findById(productId);

    if (!newProduct) {
      return res.status(404).json({
        message: "Product not found",
      });
    }

    const orderIsActive = order.status !== "Cancelled";

    const productChanged = order.productId.toString() !== productId;

    const quantityChanged = order.quantity !== quantity;

    const stockNeedsUpdate =
      orderIsActive && (productChanged || quantityChanged);

    if (stockNeedsUpdate) {
      const oldProduct = await Product.findById(order.productId);

      if (!oldProduct) {
        return res.status(404).json({
          message: "Original product not found",
        });
      }

      if (productChanged) {
        if (newProduct.stock < quantity) {
          return res.status(400).json({
            message: `Not enough stock. Available stock: ${newProduct.stock}`,
          });
        }

        oldProduct.stock += order.quantity;
        newProduct.stock -= quantity;

        await oldProduct.save();
        await newProduct.save();
      } else {
        const stockDifference = quantity - order.quantity;

        if (stockDifference > 0 && newProduct.stock < stockDifference) {
          return res.status(400).json({
            message: `Not enough stock. Available stock: ${newProduct.stock}`,
          });
        }

        newProduct.stock -= stockDifference;

        await newProduct.save();
      }
    }

    order.customer = customer;
    order.phone = phone;
    order.productId = newProduct._id;
    order.product = newProduct.name;
    order.quantity = quantity;
    order.price = price;
    order.total = price * quantity;
    order.profit = (price - newProduct.cost) * quantity;

    await order.save();

    return res.status(200).json(order);
  } catch (error) {
    console.error("Failed to update order:", error);

    return res.status(500).json({
      message: "Failed to update order",
    });
  }
});

router.delete("/:id", async (req, res) => {
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

    // Restore stock if the order is still active.
    if (order.status !== "Cancelled") {
      const product = await Product.findById(order.productId);

      if (product) {
        product.stock += order.quantity;
        await product.save();
      }
    }

    await Order.deleteOne({
      _id: order._id,
    });

    return res.status(200).json({
      message: "Order deleted successfully",
    });
  } catch (error) {
    console.error("Failed to delete order:", error);

    return res.status(500).json({
      message: "Failed to delete order",
    });
  }
});

/**
 * PATCH /api/orders/:id/status
 * Update order status
 */
router.patch("/:id/status", async (req, res) => {
  try {
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

    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        message: "Order not found",
      });
    }

    const newStatus = result.data.status;

    if (order.status === newStatus) {
      return res.status(400).json({
        message: "Order already has this status",
      });
    }

    const wasCancelled = order.status === "Cancelled";
    const willBeCancelled = newStatus === "Cancelled";

    // Active → Cancelled
    // Return the reserved quantity to stock.
    if (!wasCancelled && willBeCancelled) {
      const product = await Product.findById(order.productId);

      if (!product) {
        return res.status(404).json({
          message: "Product not found",
        });
      }

      product.stock += order.quantity;

      await product.save();
    }

    // Cancelled → Active
    // Reserve the quantity again.
    if (wasCancelled && !willBeCancelled) {
      const product = await Product.findById(order.productId);

      if (!product) {
        return res.status(404).json({
          message: "Product not found",
        });
      }

      if (product.stock < order.quantity) {
        return res.status(400).json({
          message: `Not enough stock. Available stock: ${product.stock}`,
        });
      }

      product.stock -= order.quantity;

      await product.save();
    }

    order.status = newStatus;

    await order.save();

    return res.status(200).json(order);
  } catch (error) {
    console.error("Failed to update order status:", error);

    return res.status(500).json({
      message: "Failed to update order status",
    });
  }
});

export default router;
