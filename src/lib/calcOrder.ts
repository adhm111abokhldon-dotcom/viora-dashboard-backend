import { round2 } from "./money.js";

type Line = { quantity: number; unitPrice: number; unitCost: number };

export function calcOrder(
  items: Line[],
  deliveryCharged: number,
  deliveryCost: number,
) {
  const itemsTotal = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
  const itemsCost = items.reduce((s, i) => s + i.quantity * i.unitCost, 0);
  const total = itemsTotal + deliveryCharged;
  return { total, profit: total - itemsCost - deliveryCost };
}

/** The single authoritative financial model for one order. Every screen and
 *  report that shows order money must compute from this (or from its stored
 *  `total`/`profit` snapshots for legacy rows) so the numbers never drift.
 *
 *  - Free gifts are lines with `unitPrice: 0`; they still count their
 *    `unitCost` against profit at the time the order was placed.
 *  - All inputs are rounded once at the boundary; nothing downstream rounds
 *    again.
 */
export type OrderFinancials = {
  /** sum(quantity * unitPrice) across every line - gifts included at 0. */
  productRevenue: number;
  /** sum(quantity * unitCost) across every line - gifts counted at cost. */
  productCost: number;
  /** Delivery collected from the customer. */
  deliveryCharged: number;
  /** Delivery paid to the courier. */
  deliveryCost: number;
  /** productRevenue + deliveryCharged - productCost - deliveryCost. */
  grossContribution: number;
  /** Same as grossContribution at order level (no other order-level expense). */
  netProfit: number;
};

export function calcOrderFinancials(
  items: Line[],
  deliveryCharged: number,
  deliveryCost: number,
): OrderFinancials {
  const productRevenue = round2(
    items.reduce((s, i) => s + i.quantity * i.unitPrice, 0),
  );
  const productCost = round2(
    items.reduce((s, i) => s + i.quantity * i.unitCost, 0),
  );
  const dc = round2(deliveryCharged);
  const dlc = round2(deliveryCost);
  const grossContribution = round2(productRevenue + dc - productCost - dlc);

  return {
    productRevenue,
    productCost,
    deliveryCharged: dc,
    deliveryCost: dlc,
    grossContribution,
    netProfit: grossContribution,
  };
}
