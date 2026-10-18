import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import {
  computeOrderInventoryAdjustments,
  type InventoryAdjustment,
} from "./orderInventory.js";

function sortByProduct(adjustments: InventoryAdjustment[]) {
  return [...adjustments].sort((a, b) =>
    a.productId.localeCompare(b.productId),
  );
}

test("computes positive delta for added quantity and negative for removed", () => {
  const previous = [
    { productId: "p1", quantity: 2 },
    { productId: "p2", quantity: 1 },
  ];
  const next = [
    { productId: "p1", quantity: 5 },
    { productId: "p3", quantity: 3 },
  ];

  assert.deepEqual(sortByProduct(computeOrderInventoryAdjustments(previous, next)), [
    { productId: "p1", delta: 3 }, // need 3 more
    { productId: "p2", delta: -1 }, // release 1
    { productId: "p3", delta: 3 }, // reserve 3 new
  ]);
});

test("returns empty array when nothing changed", () => {
  const items = [{ productId: "p1", quantity: 2 }];
  assert.deepEqual(computeOrderInventoryAdjustments(items, items), []);
});

test("aggregates quantities per product across multiple lines", () => {
  const previous = [{ productId: "p1", quantity: 1 }, { productId: "p1", quantity: 2 }];
  const next = [{ productId: "p1", quantity: 4 }];

  assert.deepEqual(computeOrderInventoryAdjustments(previous, next), [
    { productId: "p1", delta: 1 }, // 4 - (1 + 2)
  ]);
});

test("accepts mongoose ObjectId productIds and compares by string", () => {
  const id = new Types.ObjectId();
  const previous = [{ productId: id, quantity: 2 }];
  const next = [{ productId: id.toString(), quantity: 5 }];

  assert.deepEqual(computeOrderInventoryAdjustments(previous, next), [
    { productId: id.toString(), delta: 3 },
  ]);
});
