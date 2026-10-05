import { round2 } from "./money.js";

/**
 * Central currency handling for advertising spend.
 *
 * The app does all of its financial maths in USD. Windsor's Meta account
 * reports in AED, so Windsor amounts are converted ONCE, at the moment they
 * are written to the database, and the USD value is what every report,
 * insight and total uses from then on.
 *
 * The rate is a fixed business decision (not a live rate), as agreed:
 *
 *     1 USD = 3.67 AED   =>   USD = AED / 3.67
 *
 * The original AED figure is kept on the document (originalAmount /
 * originalCurrency) so the owner can always trace where the number came from.
 */

/** Fixed rate: how many AED make 1 USD. */
export const AED_PER_USD = 3.67;

/** Windsor reports this account in AED. */
export const WINDSOR_SOURCE_CURRENCY = "AED";

/** Manual expenses are entered by the owner in the app's own currency. */
export const APP_CURRENCY = "USD";

/**
 * Convert a Windsor AED amount to USD, rounded to 2 decimals.
 *
 * Rounding goes through the shared round2 so the result is identical to every
 * other money value the API returns.
 */
export function aedToUsd(amount: number): number {
  if (!Number.isFinite(amount)) return 0;

  return round2(amount / AED_PER_USD);
}

/**
 * Format the rate for display, e.g. "3.67 AED / USD".
 * Kept here so the UI never hardcodes the number.
 */
export const AED_PER_USD_LABEL = `${AED_PER_USD} AED / USD`;
