import type { ClientSession } from "mongoose";
import Counter from "../models/Counter.js";
import Order from "../models/Orders.js";

const COUNTER_ID = "orderNumber";

function isDuplicateKeyError(error: unknown): error is { code: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 11000
  );
}

/** Initialize or advance the counter to cover every previously assigned number. */
export async function ensureOrderNumberCounter(): Promise<void> {
  const [highest] = await Order.aggregate<{ value: number }>([
    { $match: { orderNumber: { $type: "number" } } },
    { $group: { _id: null, value: { $max: "$orderNumber" } } },
  ]);

  try {
    const counter = await Counter.findOneAndUpdate(
      { _id: COUNTER_ID },
      { $max: { seq: highest?.value ?? 0 } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    if (!counter) throw new Error("Failed to initialize the order-number counter");
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;

    const counter = await Counter.findOneAndUpdate(
      { _id: COUNTER_ID },
      { $max: { seq: highest?.value ?? 0 } },
      { new: true },
    );

    if (!counter) throw new Error("Failed to initialize the order-number counter");
  }
}

/**
 * Next sequential business order number (1, 2, 3, ...).
 *
 * The number is stored on the order (never derived from _id, sorting or
 * pagination) and is allocated through an atomic `$inc` on a Counter
 * document, so concurrent creations can never collide. Call it INSIDE the
 * order-creation transaction: if the transaction rolls back, the counter
 * increment rolls back with it and no number is wasted.
 *
 * If the counter does not exist yet (fresh database, or a database that was
 * backfilled before this code ran), it is seeded from the highest number
 * already assigned so new orders always continue from the top.
 */
export async function nextOrderNumber(session?: ClientSession): Promise<number> {
  const counter = await Counter.findByIdAndUpdate(
    COUNTER_ID,
    { $inc: { seq: 1 } },
    { new: true, session },
  );

  if (!counter) {
    throw new Error(
      "Order-number counter is missing; initialize it before creating orders",
    );
  }

  return counter.seq;
}
