/**
 * Backfill migration: assign orderNumber to every order that predates the
 * order-number feature (still null).
 *
 * Running it twice is safe: the second run finds no new rows because the
 * unique sparse index already gives every document a number.
 *
 * 1. Seed the Counter (fresh DBs need it):
 *      npx tsx src/scripts/backfillOrderNumbers.ts seed
 * 2. Assign numbers:
 *      npx tsx src/scripts/backfillOrderNumbers.ts assign
 * 3. Verify (count of orders still without a number should be 0):
 *      npx tsx src/scripts/backfillOrderNumbers.ts verify
 *
 * Run from the repo root.
 */
import "dotenv/config";
import mongoose from "mongoose";
import Counter from "../models/Counter.js";
import Order from "../models/Orders.js";

const URI =
  process.env.MONGO_URI ?? process.env.MONGODB_URI ?? "mongodb://localhost:27017/viora";
const DB_NAME = process.env.MONGO_DB ?? "viora";

async function main() {
  await mongoose.connect(URI, { dbName: DB_NAME });

  const hasCounter = await Counter.exists({ _id: "orderNumber" });
  const hasNumbers = await Order.countDocuments({ orderNumber: { $ne: null } });
  const stillNull = await Order.countDocuments({ orderNumber: null });

  if (process.argv[2] === "seed") {
    if (hasCounter) {
      console.log("Counter already exists - nothing to seed.");
      return;
    }
    const highest = await Order.findOne({ orderNumber: { $ne: null } })
      .sort({ orderNumber: -1 })
      .select("orderNumber");
    const initialSeq = highest?.orderNumber ?? 0;
    await Counter.create({ _id: "orderNumber", seq: initialSeq });
    console.log(`Counter seeded with seq=${initialSeq}`);
    return;
  }

  if (process.argv[2] === "assign") {
    if (!hasCounter) {
      console.error(
        "No Counter document found. Run: npx tsx src/scripts/backfillOrderNumbers.ts seed",
      );
      process.exit(1);
    }

    if (stillNull === 0) {
      console.log("All orders already have numbers - nothing to backfill.");
      return;
    }

    // $inc is atomic: two concurrent runs can never collide.
    const counter = await Counter.findByIdAndUpdate(
      "orderNumber",
      { $inc: { seq: stillNull } },
      { new: true },
    );

    const batch = 500;
    let processed = 0;

    while (processed < stillNull) {
      const orders = await Order.find({ orderNumber: null })
        .sort({ createdAt: 1, _id: 1 })
        .limit(batch);

      const ops = orders.map((order) =>
        Order.updateOne(
          { _id: order._id },
          { $set: { orderNumber: counter.seq + processed } },
        ),
      );
      await Promise.all(ops);

      processed += ops.length;
      console.log(`Assigned ${processed}/${stillNull}`);
    }

    console.log(`Backfill complete. Counter seq is now ${counter.seq}`);
    return;
  }

  if (process.argv[2] === "verify") {
    console.log({ hasCounter, hasNumbers, stillNull });
    return;
  }

  console.error("Usage: backfillOrderNumbers.ts [seed|assign|verify]");
  process.exit(1);
}

main().catch((error) => {
  console.error("Backfill failed:", error);
  process.exit(1);
});
