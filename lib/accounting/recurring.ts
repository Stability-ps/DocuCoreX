/**
 * Recurring transaction detection.
 *
 * Rent, insurance, loan instalments, subscriptions, bank fees, payroll, fleet
 * tracking. These are commitments an accountant already knows exist; the point
 * is to state them from the bank data rather than from memory, and to make them
 * available to forecasting as CONFIRMED obligations rather than guesses.
 *
 * Deterministic — dates, amounts and merchant identity that already exists on
 * the row. No model call, per the instruction to prefer database computation for
 * this class of work.
 *
 * The discipline that matters here is refusing to claim a pattern from too
 * little evidence. Two payments are one interval, and one interval is not a
 * rhythm: any two dates are "regular" in the trivial sense that a single gap
 * separates them. A forecast built on that would present coincidence as a
 * commitment, so three occurrences are required before anything is reported.
 */

export type RecurringFrequency = "weekly" | "fortnightly" | "monthly" | "quarterly";

export type RecurringOccurrence = {
  transactionId: string;
  date: string;
  amount: number;
};

export type RecurringInput = {
  transactionId: string;
  merchant: string | null;
  date: string | null;
  debit: number | null;
  credit: number | null;
  accountCategory: string;
};

export type RecurringPattern = {
  merchant: string;
  frequency: RecurringFrequency;
  occurrences: RecurringOccurrence[];
  /** Mean of the observed amounts. */
  averageAmount: number;
  /** Largest deviation from the average, as a fraction of it. */
  amountVariance: number;
  /** True when every amount sits within a few percent of the average. */
  amountIsStable: boolean;
  medianIntervalDays: number;
  lastSeen: string;
  /** last seen + median interval. An estimate, and labelled as one. */
  nextExpected: string;
  /** 0-100, from interval regularity, amount stability and occurrence count. */
  confidence: number;
  commonCategory: string | null;
};

/** Three occurrences give two intervals — the minimum that can agree or disagree. */
export const MIN_OCCURRENCES = 3;

const FREQUENCY_WINDOWS: Array<{ frequency: RecurringFrequency; min: number; max: number; target: number }> = [
  { frequency: "weekly", min: 6, max: 8, target: 7 },
  { frequency: "fortnightly", min: 12, max: 16, target: 14 },
  // Calendar months are 28-31 days, and a payment date that falls on a weekend
  // is often moved, so the window is wider than the month itself.
  { frequency: "monthly", min: 26, max: 35, target: 30 },
  { frequency: "quarterly", min: 84, max: 96, target: 91 },
];

const DAY_MS = 86_400_000;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function addDays(iso: string, days: number): string {
  const base = Date.parse(iso);
  if (Number.isNaN(base)) return iso;
  // Date-only output: these are statement dates, and a time component would
  // imply precision the source does not have.
  return new Date(base + Math.round(days) * DAY_MS).toISOString().slice(0, 10);
}

function classifyFrequency(intervalDays: number): RecurringFrequency | null {
  return FREQUENCY_WINDOWS.find((window) => intervalDays >= window.min && intervalDays <= window.max)?.frequency ?? null;
}

/**
 * Find recurring payment patterns, one per merchant.
 *
 * Only outgoing amounts are considered. An incoming rhythm is a different
 * accounting question — regular receipts are revenue patterns, not commitments —
 * and treating them together would let a salary credit and a rent debit average
 * into one meaningless "pattern".
 */
export function findRecurringPatterns(
  rows: RecurringInput[],
  dismissedMerchants: Set<string> = new Set(),
): RecurringPattern[] {
  const byMerchant = new Map<string, RecurringInput[]>();

  for (const row of rows) {
    const merchant = row.merchant?.trim();
    if (!merchant || !row.date) continue;
    if ((row.debit ?? 0) <= 0) continue;
    if (dismissedMerchants.has(merchant.toLowerCase())) continue;
    const existing = byMerchant.get(merchant);
    if (existing) existing.push(row);
    else byMerchant.set(merchant, [row]);
  }

  const patterns: RecurringPattern[] = [];

  for (const [merchant, merchantRows] of byMerchant) {
    if (merchantRows.length < MIN_OCCURRENCES) continue;

    const occurrences: RecurringOccurrence[] = merchantRows
      .map((row) => ({ transactionId: row.transactionId, date: row.date as string, amount: row.debit ?? 0 }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const intervals: number[] = [];
    for (let index = 1; index < occurrences.length; index += 1) {
      const gap = (Date.parse(occurrences[index].date) - Date.parse(occurrences[index - 1].date)) / DAY_MS;
      if (Number.isFinite(gap)) intervals.push(gap);
    }
    if (intervals.length < MIN_OCCURRENCES - 1) continue;

    const medianInterval = median(intervals);
    const frequency = classifyFrequency(medianInterval);
    if (!frequency) continue;

    // Every interval must land in the same window. A merchant paid twice in one
    // month and then not for a quarter has a median that looks monthly while
    // nothing about it is regular.
    if (!intervals.every((interval) => classifyFrequency(interval) === frequency)) continue;

    const amounts = occurrences.map((occurrence) => occurrence.amount);
    const averageAmount = amounts.reduce((sum, amount) => sum + amount, 0) / amounts.length;
    const amountVariance = averageAmount
      ? Math.max(...amounts.map((amount) => Math.abs(amount - averageAmount))) / averageAmount
      : 0;
    const amountIsStable = amountVariance <= 0.05;

    const categoryCounts = new Map<string, number>();
    for (const row of merchantRows) categoryCounts.set(row.accountCategory, (categoryCounts.get(row.accountCategory) ?? 0) + 1);
    let commonCategory: string | null = null;
    let best = 0;
    for (const [category, count] of categoryCounts) {
      if (count > best) {
        best = count;
        commonCategory = category;
      }
    }

    // Confidence is evidence, not a guess. Regularity of the intervals carries
    // the most weight, then how many times it has happened, then whether the
    // amount holds steady. A three-occurrence pattern is capped well below a
    // long-established one however tidy its dates look.
    const target = FREQUENCY_WINDOWS.find((window) => window.frequency === frequency)!.target;
    const intervalDrift = Math.max(...intervals.map((interval) => Math.abs(interval - target))) / target;
    const regularityScore = Math.max(0, 1 - intervalDrift) * 55;
    const historyScore = Math.min(occurrences.length / 6, 1) * 30;
    const stabilityScore = Math.max(0, 1 - amountVariance) * 15;
    const confidence = Math.round(Math.min(100, regularityScore + historyScore + stabilityScore));

    const lastSeen = occurrences[occurrences.length - 1].date;

    patterns.push({
      merchant,
      frequency,
      occurrences,
      averageAmount,
      amountVariance,
      amountIsStable,
      medianIntervalDays: medianInterval,
      lastSeen,
      nextExpected: addDays(lastSeen, medianInterval),
      confidence,
      commonCategory,
    });
  }

  // Most confident first, then largest commitment — the order in which an
  // accountant would want to check them.
  patterns.sort((a, b) => b.confidence - a.confidence || b.averageAmount - a.averageAmount || a.merchant.localeCompare(b.merchant));

  return patterns;
}
