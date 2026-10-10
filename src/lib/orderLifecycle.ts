import type { OrderStatus } from "../models/Orders.js";

/**
 * Pure decision logic for the order status lifecycle and product deletion.
 *
 * Business rules encoded here (authoritative):
 *
 *   Pending   -> Delivered : allowed, stock UNCHANGED (reserved at creation).
 *   Pending   -> Cancelled : allowed, reserved stock is RESTORED.
 *   Delivered -> Cancelled : allowed, stock is RESTORED.
 *   Cancelled -> *         : DISALLOWED.
 *   *         -> Pending   : DISALLOWED.
 *   Delivered -> Pending   : DISALLOWED.
 *   same status            : DISALLOWED (idempotent no-op rejection).
 *
 * DELETE is not handled here: deleting an order is an administrative
 * operation that NEVER touches inventory, whatever the status is.
 */
export type StatusTransitionResult =
  | { allowed: true; next: OrderStatus; releaseStock: boolean }
  | { allowed: false; reason: string };

export function resolveStatusTransition(
  current: OrderStatus,
  requested: OrderStatus,
): StatusTransitionResult {
  if (current === requested) {
    return { allowed: false, reason: "Order already has this status" };
  }

  if (current === "Pending" && requested === "Delivered") {
    return { allowed: true, next: "Delivered", releaseStock: false };
  }

  if (
    (current === "Pending" || current === "Delivered") &&
    requested === "Cancelled"
  ) {
    return { allowed: true, next: "Cancelled", releaseStock: true };
  }

  return {
    allowed: false,
    reason: `Cannot change order status from ${current} to ${requested}`,
  };
}

/** Message returned when a product still backs a Pending stock reservation. */
export const PENDING_ORDER_DELETION_MESSAGE =
  "Cannot delete this product because it is used by one or more pending orders. Cancel or complete those orders first.";

/**
 * A product referenced by any Pending order must not be hard-deleted:
 * the pending order holds a stock reservation against the product document,
 * and a later cancel/edit could no longer release it correctly.
 */
export function productDeletionCheck(hasPendingReferences: boolean):
  | { blocked: false }
  | { blocked: true; message: string } {
  return hasPendingReferences
    ? { blocked: true, message: PENDING_ORDER_DELETION_MESSAGE }
    : { blocked: false };
}
