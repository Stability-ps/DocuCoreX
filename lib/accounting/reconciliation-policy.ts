/**
 * When a statement counts as reconciled. Decided in integer minor units, never
 * by comparing floats.
 *
 * - difference 0                  → reconciled
 * - 1 to 5 minor units (R0.01–R0.05) → needs review: probably rounding, but a
 *   person confirms it; it never reads as reconciled
 * - more than 5 minor units       → failed
 *
 * No server imports — the browser and the tests both use this.
 */

export type ReconciliationStatus = "reconciled" | "needs_review" | "failed";

/** Differences up to this many minor units (R0.05 for ZAR) need review rather than failing. */
export const REVIEW_BAND_MINOR_UNITS = 5;

// ISO 4217 minor units for currencies that do not use two decimals.
const MINOR_UNIT_EXCEPTIONS: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

export function currencyMinorUnits(currency: string = "ZAR"): number {
  return MINOR_UNIT_EXCEPTIONS[currency.trim().toUpperCase()] ?? 2;
}

/**
 * An amount in integer minor units. Amounts are expected at the currency's own
 * precision (as stored in `numeric` columns), so scaling lands within a hair of
 * an integer and rounding recovers it exactly. Rounds half away from zero, so a
 * refund and its charge round to the same magnitude.
 */
export function toMinorUnits(amount: number, currency: string = "ZAR"): number {
  const scaled = Math.abs(amount) * 10 ** currencyMinorUnits(currency);
  const minor = Math.round(scaled);
  return amount < 0 ? -minor : minor;
}

export function reconciliationStatus(differenceMinorUnits: number): ReconciliationStatus {
  if (!Number.isInteger(differenceMinorUnits)) throw new TypeError("difference must be in integer minor units");
  const size = Math.abs(differenceMinorUnits);
  if (size === 0) return "reconciled";
  return size <= REVIEW_BAND_MINOR_UNITS ? "needs_review" : "failed";
}

/** Status for a difference held as a decimal amount (e.g. 0.03), via minor units. */
export function reconciliationStatusForAmount(difference: number, currency: string = "ZAR"): ReconciliationStatus {
  return reconciliationStatus(toMinorUnits(difference, currency));
}
