/**
 * Backfill stable business numbers for legacy orders.
 *
 * Run during a short order-write maintenance window. The migration is
 * idempotent, orders are processed in creation order, and assigned numbers
 * are never changed.
 *
 *   npm run backfill:orders
 *   npm run verify:orders
 */
import "dotenv/config";
import mongoose from "mongoose";
import Order from "../models/Orders.js";
import {
  ensureOrderNumberCounter,
  nextOrderNumber,
} from "../lib/orderNumber.js";

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not defined");

  await mongoose.connect(uri);

  try {
    if (process.argv[2] === "verify") {
      const [totalOrders, numberedOrders, counter] = await Promise.all([
        Order.countDocuments(),
        Order.aggregate<{ count: number }>([
          { $match: { orderNumber: { $type: "number" } } },
          { $count: "count" },
        ]).then((rows) => rows[0]?.count ?? 0),
        mongoose.connection
          .collection<{ _id: string; seq: number }>("counters")
          .findOne({ _id: "orderNumber" }),
      ]);

      console.log({
        totalOrders,
        numberedOrders,
        missingOrderNumbers: totalOrders - numberedOrders,
        counterSequence: counter?.seq ?? null,
      });
      return;
    }

    if (process.argv[2] !== "backfill") {
      throw new Error("Usage: backfillOrderNumbers.ts [backfill|verify]");
    }

    await ensureOrderNumberCounter();

    let processed = 0;
    while (true) {
      const orders = await Order.find({ orderNumber: null })
        .sort("createdAt _id")
        .limit(500)
        .select("_id")
        .lean();

      if (orders.length === 0) break;

      for (const order of orders) {
        const orderNumber = await nextOrderNumber();
        const result = await Order.updateOne(
          { _id: order._id, orderNumber: null },
          { $set: { orderNumber } },
        );

        if (result.modifiedCount === 1) processed += 1;
      }

      console.log(`Assigned ${processed} legacy order numbers`);
    }

    console.log(`Backfill complete. Assigned ${processed} order numbers.`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error("Order-number migration failed:", error);
  process.exitCode = 1;
});
