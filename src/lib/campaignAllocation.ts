import { round2 } from "./money.js";

/**
 * CURRENT-STATE campaign/product advertising attribution.
 *
 * A campaign's spend for the selected reporting period is divided EQUALLY
 * between the products that are CURRENTLY linked to it:
 *
 *     Product Campaign Share = Campaign Spend / Number of Currently Linked Products
 *
 * The relationship is a pure many-to-many "linked = included, unlinked =
 * excluded" rule. The amount a product receives does NOT depend on when it
 * was linked or unlinked, on any link timestamp, or on any stored snapshot:
 * linking a product today gives it its full share of the campaign's spend
 * for the requested period immediately, even spend that occurred before the
 * link existed.
 *
 * Allocation is ANALYTICAL ONLY - it never changes the campaign's own spend.
 * A $100 campaign with two products still spent $100 on the Advertising page;
 * each product is simply charged $50 for profitability purposes.
 *
 * Rounding: money is split in CENTS so the shares always reconcile EXACTLY
 * to the campaign spend - no cent is ever lost or created. The remainder
 * cents go to the FIRST entries of the sorted list (deterministic, and the
 * same order every caller uses: sorted product ids).
 *
 *   $100 over 3 -> [33.34, 33.33, 33.33]  (sum = 100.00 exactly)
 *   $0.01 over 3 -> [0.01, 0.00, 0.00]    (sum = 0.01 exactly)
 */

/**
 * Split `total` into `count` equal shares that sum EXACTLY to `total`.
 *
 * Returns [] for count <= 0 (a campaign with no linked products has no
 * allocation - never divides by zero).
 */
export function allocateEvenly(total: number, count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [round2(total)];

  const totalCents = Math.round(total * 100);
  const baseCents = Math.floor(totalCents / count);
  const remainder = totalCents - baseCents * count;

  return Array.from({ length: count }, (_, index) => {
    // The first `remainder` entries each carry one extra cent.
    const cents = index < remainder ? baseCents + 1 : baseCents;

    return cents / 100;
  });
}

export type CurrentStateAllocation = {
  campaignSpend: number;
  /** Spend assigned to products (equals campaignSpend when >= 1 product). */
  allocatedSpend: number;
  /** Spend with no currently-linked product (equals campaignSpend when 0). */
  unallocatedSpend: number;
  /** Product id -> its exact-cent share of the campaign spend. */
  allocationByProductId: Map<string, number>;
  /** The de-duplicated, id-sorted list of products that received a share. */
  linkedProductIds: string[];
};

/**
 * THE single authoritative campaign -> current-products attribution.
 *
 * Given the campaign's spend for the selected reporting period and the ids of
 * the products CURRENTLY linked to it, distribute the spend equally and
 * exactly. This is the ONLY place campaign spend is turned into per-product
 * allocation; every endpoint (catalog, campaign detail, insights, product
 * performance) routes through it so the numbers can never disagree.
 */
export function currentStateAllocation(
  campaignSpend: number,
  linkedProductIds: readonly string[],
): CurrentStateAllocation {
  const spend = round2(campaignSpend);
  // De-duplicate and sort by id so the exact-cent remainder lands on the same
  // products no matter which caller (or product) is asking.
  const ordered = [...new Set(linkedProductIds)].sort((left, right) =>
    left.localeCompare(right),
  );
  const amounts = allocateEvenly(spend, ordered.length);
  const allocationByProductId = new Map<string, number>();
  ordered.forEach((productId, index) => {
    allocationByProductId.set(productId, amounts[index] ?? 0);
  });
  const allocatedSpend = ordered.length > 0 ? spend : 0;

  return {
    campaignSpend: spend,
    allocatedSpend,
    unallocatedSpend: round2(spend - allocatedSpend),
    allocationByProductId,
    linkedProductIds: ordered,
  };
}
