/**
 * Money helpers.
 *
 * All monetary values are plain JS numbers. Aggregations produce values like
 * 493.90000000000003 through floating point accumulation, so anything that
 * leaves the API as money is rounded once, here, at the boundary.
 */

/** Round to 2 decimals, avoiding -0 and NaN leaking into JSON responses. */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;

  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;

  // Math.round can return -0 for small negatives; normalise it to 0.
  return rounded === 0 ? 0 : rounded;
}

/** Sum an array of numbers and round the result once. */
export function round2Sum(values: number[]): number {
  return round2(values.reduce((sum, value) => sum + (Number(value) || 0), 0));
}
