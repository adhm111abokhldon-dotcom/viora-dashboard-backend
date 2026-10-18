/** Pure inventory math for order edits. Nothing here touches the database -
 *  it only computes how much stock each product gains or loses when an order
 *  is changed, so the same logic can be unit tested without MongoDB.
 *
 *  Positive delta = stock must DECREASE (more reserved).
 *  Negative delta = stock must INCREASE (reservation released).
 *
 *  Callers apply deltas per order status:
 *  - Pending:  release every old line, reserve every new line (full swap).
 *  - Delivered: goods already left; only NEW stock is needed (delta > 0),
 *    and it must actually be available. Surplus old stock (delta < 0) is
 *    credited back - it cannot be "un-shipped", but the books stay right.
 *  - Cancelled: nothing moves - stock was already restored when cancelled.
 */
import { type Types } from "mongoose";

export type InventoryAdjustment = {
  productId: string;
  /** new quantity - old quantity. Positive = need more stock. */
  delta: number;
};

export function computeOrderInventoryAdjustments(
  previous: Array<{ productId: string | Types.ObjectId; quantity: number }>,
  next: Array<{ productId: string; quantity: number }>,
): InventoryAdjustment[] {
  const oldQty = new Map<string, number>();
  for (const item of previous) {
    const id = item.productId.toString();
    oldQty.set(id, (oldQty.get(id) ?? 0) + item.quantity);
  }

  const deltas = new Map<string, number>();
  for (const item of next) {
    const id = item.productId;
    const before = oldQty.get(id) ?? 0;
    deltas.set(id, (deltas.get(id) ?? 0) + item.quantity - before);
    oldQty.delete(id);
  }

  /* Anything left in oldQty was removed from the order entirely. */
  for (const [id, before] of oldQty) {
    deltas.set(id, (deltas.get(id) ?? 0) - before);
  }

  return [...deltas.entries()]
    .map(([productId, delta]) => ({ productId, delta }))
    .filter((adjustment) => adjustment.delta !== 0);
}
