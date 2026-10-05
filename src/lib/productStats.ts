import type { PipelineStage } from "mongoose";

/**
 * Single source of truth for PRODUCT-level business calculations.
 *
 * Business rules implemented here:
 *
 *  - Only Delivered orders count as completed sales. Pending and Cancelled
 *    orders never contribute to product revenue, cost or profit.
 *
 *  - productRevenue = quantity * unitPrice
 *    `deliveryCharged` is money collected for delivery, NOT product revenue,
 *    so it is never added to a product's sales.
 *
 *  - Historical numbers always come from the OrderItem snapshots
 *    (unitPrice / unitCost / name), never from the current Product document.
 *
 *  - An order's deliveryCost belongs to the whole order, so it is allocated
 *    across the order's items proportionally to each item's revenue:
 *        deliveryShare          = itemRevenue / itemsTotal
 *                                 (or 1 / itemCount when itemsTotal = 0)
 *        allocatedDeliveryCost  = order.deliveryCost * deliveryShare
 *        itemProfit             = itemRevenue - itemCost - allocatedDeliveryCost
 *
 *    `deliveryCharged` is deliberately NOT allocated as a cost.
 *
 * Everything the frontend shows (product detail, products table, top
 * products, financial summary) comes from these stages so the numbers can
 * never drift between screens.
 */

/** Match stage selecting completed sales only. */
export const DELIVERED_MATCH: PipelineStage.Match["$match"] = {
  status: "Delivered",
};

/** Match stage selecting every order that still holds reserved stock. */
export const PENDING_MATCH: PipelineStage.Match["$match"] = { status: "Pending" };

/**
 * Order-level values. MUST run before `$unwind`, otherwise the sibling items
 * needed for `itemsTotal` are no longer reachable.
 */
export const orderAllocationStage: PipelineStage.Set = {
  $set: {
    // Total product revenue of the whole order (no delivery involved).
    __itemsTotal: {
      $sum: {
        $map: {
          input: { $ifNull: ["$items", []] },
          as: "line",
          in: { $multiply: ["$$line.quantity", "$$line.unitPrice"] },
        },
      },
    },
    __itemsCount: { $size: { $ifNull: ["$items", []] } },
    __orderDeliveryCost: { $ifNull: ["$deliveryCost", 0] },
    __orderDeliveryCharged: { $ifNull: ["$deliveryCharged", 0] },
  },
};

/**
 * Per-item raw money. Must run after `$unwind "$items"`.
 *
 * NOTE: this stage is kept separate from `itemShareStage` on purpose. A field
 * inside a `$set` cannot reference another field defined in the SAME `$set` -
 * MongoDB resolves such references against the input document, where the
 * sibling does not exist yet, and the result is `null` instead of a number.
 */
export const itemMoneyStage: PipelineStage.Set = {
  $set: {
    __itemRevenue: { $multiply: ["$items.quantity", "$items.unitPrice"] },
    __itemCost: { $multiply: ["$items.quantity", "$items.unitCost"] },
  },
};

/**
 * Per-item share of the order's delivery cost. Must run AFTER `itemMoneyStage`,
 * because it divides `__itemRevenue` by `__itemsTotal`.
 */
export const itemShareStage: PipelineStage.Set = {
  $set: {
    __deliveryShare: {
      $cond: [
        { $gt: ["$__itemsTotal", 0] },
        { $divide: ["$__itemRevenue", "$__itemsTotal"] },
        {
          $cond: [
            { $gt: ["$__itemsCount", 0] },
            { $divide: [1, "$__itemsCount"] },
            0,
          ],
        },
      ],
    },
  },
};

/** Allocated delivery cost per item. Runs after `itemShareStage`. */
export const itemDeliveryStage: PipelineStage.Set = {
  $set: {
    __itemDeliveryCost: {
      $multiply: ["$__orderDeliveryCost", "$__deliveryShare"],
    },
  },
};

/**
 * Final per-item profit. Runs after `itemDeliveryStage` because it references
 * `__itemDeliveryCost` (same-stage references resolve to null - see above).
 */
export const itemProfitStage: PipelineStage.Set = {
  $set: {
    __itemProfit: {
      $subtract: [
        "$__itemRevenue",
        { $add: ["$__itemCost", "$__itemDeliveryCost"] },
      ],
    },
  },
};

/** Standard `match -> order level -> unwind -> item level` prologue. */
export function itemPrologue(match?: PipelineStage.Match["$match"]): PipelineStage[] {
  return [
    ...(match ? [match as PipelineStage.Match] : []),
    orderAllocationStage,
    { $unwind: "$items" } as PipelineStage.Unwind,
    itemMoneyStage,
    itemShareStage,
    itemDeliveryStage,
    itemProfitStage,
  ];
}

/**
 * Group by (product, order) so an order that lists the same product twice is
 * still counted as ONE order, and so delivery allocated across duplicated
 * lines sums back to the order's total.
 */
export const groupByProductAndOrder: PipelineStage.Group = {
  $group: {
    _id: { productId: "$items.productId", orderId: "$_id" },
    name: { $first: "$items.name" },
    units: { $sum: "$items.quantity" },
    revenue: { $sum: "$__itemRevenue" },
    cost: { $sum: "$__itemCost" },
    deliveryCost: { $sum: "$__itemDeliveryCost" },
    profit: { $sum: "$__itemProfit" },
  },
};

/** Roll the per-order rows up into one row per product. */
export const rollupByProduct: PipelineStage.Group = {
  $group: {
    _id: "$_id.productId",
    name: { $first: "$name" },
    orders: { $sum: 1 },
    units: { $sum: "$units" },
    revenue: { $sum: "$revenue" },
    cost: { $sum: "$cost" },
    deliveryCost: { $sum: "$deliveryCost" },
    profit: { $sum: "$profit" },
  },
};
