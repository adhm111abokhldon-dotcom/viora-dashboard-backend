import { round2 } from "./money.js";

/**
 * THE Viora advertising expense total.
 *
 * Exactly two components, each counted ONCE:
 *
 *   - windsorSpend: stored Windsor campaign-day rows (active, paused,
 *     historical and deleted-but-stored campaigns alike);
 *   - manualSpend: user-entered manual advertising expenses.
 *
 * Manual expenses are never campaigns, so they never appear inside
 * windsorSpend. This function is the single aggregation point where the two
 * meet - callers must not add either component again anywhere else.
 */
export function grandAdvertisingTotal(
  windsorSpend: number,
  manualSpend: number,
): number {
  return round2(round2(windsorSpend) + round2(manualSpend));
}
