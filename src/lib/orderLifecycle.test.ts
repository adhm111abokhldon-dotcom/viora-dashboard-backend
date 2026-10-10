import assert from "node:assert/strict";
import test from "node:test";

import {
  PENDING_ORDER_DELETION_MESSAGE,
  productDeletionCheck,
  resolveStatusTransition,
} from "./orderLifecycle.js";
import type { OrderStatus } from "../models/Orders.js";

test("order status matrix: every allowed transition and its stock effect", () => {
  // Pending -> Delivered: allowed, stock UNCHANGED.
  assert.deepEqual(resolveStatusTransition("Pending", "Delivered"), {
    allowed: true,
    next: "Delivered",
    releaseStock: false,
  });

  // Pending -> Cancelled: allowed, reserved stock RESTORED.
  assert.deepEqual(resolveStatusTransition("Pending", "Cancelled"), {
    allowed: true,
    next: "Cancelled",
    releaseStock: true,
  });

  // Delivered -> Cancelled: allowed, stock RESTORED.
  assert.deepEqual(resolveStatusTransition("Delivered", "Cancelled"), {
    allowed: true,
    next: "Cancelled",
    releaseStock: true,
  });
});

test("order status matrix: every disallowed transition is rejected", () => {
  const rejected: Array<[OrderStatus, OrderStatus]> = [
    // Cancelled is terminal.
    ["Cancelled", "Pending"],
    ["Cancelled", "Delivered"],
    // Delivered cannot go back to Pending.
    ["Delivered", "Pending"],
  ];

  for (const [current, requested] of rejected) {
    const result = resolveStatusTransition(current, requested);
    assert.equal(result.allowed, false, `${current} -> ${requested}`);

    if (!result.allowed) {
      assert.equal(
        result.reason,
        `Cannot change order status from ${current} to ${requested}`,
      );
    }
  }

  // Same status is an explicit no-op rejection for every status.
  for (const status of ["Pending", "Delivered", "Cancelled"] as const) {
    const result = resolveStatusTransition(status, status);
    assert.equal(result.allowed, false, `${status} -> ${status}`);

    if (!result.allowed) {
      assert.equal(result.reason, "Order already has this status");
    }
  }
});

test("no transition ever releases stock except the two cancellations", () => {
  const statuses: OrderStatus[] = ["Pending", "Delivered", "Cancelled"];

  for (const current of statuses) {
    for (const requested of statuses) {
      const result = resolveStatusTransition(current, requested);
      const releases = result.allowed && result.releaseStock;

      const shouldRelease =
        requested === "Cancelled" &&
        (current === "Pending" || current === "Delivered");

      assert.equal(releases, shouldRelease, `${current} -> ${requested}`);
    }
  }
});

test("product deletion is blocked only while Pending orders reference it", () => {
  assert.deepEqual(productDeletionCheck(false), { blocked: false });
  assert.equal(productDeletionCheck(true).blocked, true);

  const blocked = productDeletionCheck(true);
  if (blocked.blocked) {
    assert.equal(blocked.message, PENDING_ORDER_DELETION_MESSAGE);
    // The message must tell the user exactly what to do next.
    assert.match(blocked.message, /pending orders/i);
    assert.match(blocked.message, /Cancel or complete those orders first\./);
  }
});
