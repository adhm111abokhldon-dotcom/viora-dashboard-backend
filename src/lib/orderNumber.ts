import type { ClientSession } from "mongoose";
import Counter from "../models/Counter.js";
import Order from "../models/Orders.js";

const COUNTER_ID = "orderNumber";

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
  const existing = await Counter.findById(COUNTER_ID).session(session ?? null);

  if (!existing) {
    const highest = await Order.findOne({ orderNumber: { $ne: null } })
      .sort({ orderNumber: -1 })
      .select("orderNumber")
      .session(session ?? null);

    try {
      await Counter.create(
        [{ _id: COUNTER_ID, seq: highest?.orderNumber ?? 0 }],
        session ? { session } : {},
      );
    } catch {
      // Another transaction seeded it first - the unique _id lost the race
      // harmlessly; the $inc below picks up whichever value won.
    }
  }

  const counter = await Counter.findByIdAndUpdate(
    COUNTER_ID,
    { $inc: { seq: 1 } },
    { new: true, upsert: true, session },
  );

  return counter.seq;
}
