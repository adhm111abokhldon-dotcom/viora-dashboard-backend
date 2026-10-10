import { round2 } from "./money.js";

/**
 * Advertising cost allocation: a campaign's total spend is divided EQUALLY
 * between its linked products.
 *
 *   Product Campaign Share = Campaign Total Spend / Number of Linked Products
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

/**
 * This product's share of one campaign's spend.
 *
 * `index` is the product's position in the campaign's SORTED linked-product
 * list - every endpoint sorts by product id ascending first, so the
 * product-facing number and the campaign-facing table always agree.
 */
export function allocatedShareAt(
  total: number,
  count: number,
  index: number,
): number {
  if (index < 0 || index >= count) return 0;

  return allocateEvenly(total, count)[index] ?? 0;
}

export type AllocationProduct = {
  productId: string;
  productName: string;
  amount: number;
  shareIndex: number;
  shareCount: number;
};

export type CampaignAllocationSnapshot = {
  campaignSpend: number;
  allocatedSpend: number;
  unallocatedSpend: number;
  capturedAt: Date;
  products: AllocationProduct[];
};

export function createCampaignAllocationSnapshot(
  campaignSpend: number,
  products: Array<{ productId: string; productName: string }>,
  capturedAt = new Date(),
): CampaignAllocationSnapshot {
  const ordered = [...products].sort((left, right) =>
    left.productId.localeCompare(right.productId),
  );
  const amounts = allocateEvenly(campaignSpend, ordered.length);
  const allocatedSpend = round2(
    amounts.reduce((sum, amount) => sum + amount, 0),
  );

  return {
    campaignSpend: round2(campaignSpend),
    allocatedSpend,
    unallocatedSpend:
      ordered.length === 0 ? round2(campaignSpend) : 0,
    capturedAt,
    products: ordered.map((product, index) => ({
      ...product,
      amount: amounts[index] ?? 0,
      shareIndex: index,
      shareCount: ordered.length,
    })),
  };
}

/** Revalue provider-corrected spend without changing the captured product set. */
export function revalueCampaignAllocationSnapshot(
  campaignSpend: number,
  snapshot: CampaignAllocationSnapshot,
): CampaignAllocationSnapshot {
  const amounts = allocateEvenly(campaignSpend, snapshot.products.length);
  const products = snapshot.products.map((product, index) => ({
    productId: product.productId,
    productName: product.productName,
    amount: amounts[index] ?? 0,
    shareIndex: index,
    shareCount: snapshot.products.length,
  }));
  const allocatedSpend = round2(
    products.reduce((sum, product) => sum + product.amount, 0),
  );

  return {
    campaignSpend: round2(campaignSpend),
    allocatedSpend,
    unallocatedSpend:
      products.length === 0 ? round2(campaignSpend) : 0,
    capturedAt: snapshot.capturedAt,
    products,
  };
}
