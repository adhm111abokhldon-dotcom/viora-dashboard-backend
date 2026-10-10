import assert from "node:assert/strict";
import test from "node:test";

import { grandAdvertisingTotal } from "./advertisingTotals.js";
import { createAdvertisingExpenseSchema } from "../schemas/advertisingSchemas.js";

test("total advertising expense adds Windsor spend and manual expenses exactly once", () => {
  // Phase 16 example: campaign spend $300 + manual $50 = $350 total.
  assert.equal(grandAdvertisingTotal(300, 50), 350);
  assert.equal(grandAdvertisingTotal(300, 0), 300);
  assert.equal(grandAdvertisingTotal(0, 50), 50);
  assert.equal(grandAdvertisingTotal(0, 0), 0);
});

test("total advertising expense rounds floating point accumulation once", () => {
  assert.equal(grandAdvertisingTotal(0.1, 0.2), 0.3);
  assert.equal(grandAdvertisingTotal(178.8, 0), 178.8);
  assert.equal(grandAdvertisingTotal(80.99, 12.34), 93.33);
  // Components arrive already rounded; the helper must not shift the sum.
  assert.equal(grandAdvertisingTotal(33.34, 33.33), 66.67);
  // Defensive component rounding happens before the addition.
  assert.equal(grandAdvertisingTotal(33.335, 33.335), 66.68);
});

test("manual expense schema never derives campaign identity fields", () => {
  const parsed = createAdvertisingExpenseSchema.parse({
    date: "2026-10-01",
    amount: 12.34,
    platform: "Meta",
    note: "Boosted post",
  });

  // Manual expenses are not campaigns: no store, no account id, no derived
  // campaign key and no allocation snapshot can come out of the schema.
  assert.equal("key" in parsed, false);
  assert.equal("accountId" in parsed, false);
  assert.equal("store" in parsed, false);
  assert.equal("allocationSnapshot" in parsed, false);
  assert.equal("source" in parsed, false);
  assert.equal(parsed.amount, 12.34);
});

test("manual expense schema rejects invalid amounts and dates", () => {
  assert.equal(
    createAdvertisingExpenseSchema.safeParse({
      date: "2026-10-01",
      amount: -5,
      platform: "Meta",
    }).success,
    false,
  );
  assert.equal(
    createAdvertisingExpenseSchema.safeParse({
      date: "not-a-date",
      amount: 5,
      platform: "Meta",
    }).success,
    false,
  );
  assert.equal(
    createAdvertisingExpenseSchema.safeParse({
      date: "2026-10-01",
      amount: 5,
      platform: "",
    }).success,
    false,
  );
});
