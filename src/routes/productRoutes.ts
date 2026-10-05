import { Router } from "express";
import Product from "../models/Product.js";
import Order from "../models/Orders.js";
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
