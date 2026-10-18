import assert from "node:assert/strict";
import test from "node:test";
import {
  calcOrder,
  calcOrderFinancials,
  type OrderFinancials,
} from "./calcOrder.js";

test("calcOrderFinancials computes product revenue, cost, delivery and net profit", () => {
  const items = [
    { quantity: 2, unitPrice: 100, unitCost: 40 },
    { quantity: 1, unitPrice: 0, unitCost: 50 }, // free gift: revenue 0, still counts cost
  ];

  const result = calcOrderFinancials(items, 30, 20);

  const expected: OrderFinancials = {
    productRevenue: 200, // 2*100 + 1*0 (gift contributes no revenue)
    productCost: 130, // 2*40 + 1*50 (gift still counts at cost)
    deliveryCharged: 30,
    deliveryCost: 20,
    grossContribution: 80, // 200 + 30 - 130 - 20
    netProfit: 80,
  };

  assert.deepEqual(result, expected);
});

test("calcOrderFinancials rounds inputs to cents once at the boundary", () => {
  const result = calcOrderFinancials(
    [{ quantity: 1, unitPrice: 10.005, unitCost: 3.333 }],
    1.005,
    2.005,
  );

  assert.equal(result.productRevenue, 10.01);
  assert.equal(result.productCost, 3.33);
  assert.equal(result.deliveryCharged, 1.01);
  assert.equal(result.deliveryCost, 2.01);
  assert.equal(result.grossContribution, 5.68); // 10.01 + 1.01 - 3.33 - 2.01
  assert.equal(result.netProfit, result.grossContribution);
});

test("calcOrder (legacy snapshot) matches calcOrderFinancials totals", () => {
  const items = [{ quantity: 3, unitPrice: 20, unitCost: 7 }];
  const { total, profit } = calcOrder(items, 10, 5);
  const financials = calcOrderFinancials(items, 10, 5);

  assert.equal(total, financials.productRevenue + financials.deliveryCharged);
  assert.equal(profit, financials.netProfit);
});
