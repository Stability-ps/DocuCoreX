import type { AccountingTransaction } from "@/lib/accounting/types";

/**
 * Which transactions genuinely break the running-balance chain.
 *
 * The review screen used to label rows "Balance mismatch · possible missing
 * bank charge" by taking the first N REVIEW ITEMS — no arithmetic was performed
 * anywhere. On the real 615-row Standard Bank statement that put the warning on
 * 488 rows of a ledger whose chain has zero gaps, and whose debits and credits
 * match the bank's own declared totals to the cent.
 *
 * A row needing classification review and a row breaking the balance chain are
 * unrelated facts. The first is about what a transaction MEANS; the second is
 * about whether the ledger adds up. Presenting one as the other tells a
 * reviewer their arithmetic is broken when it is not, and buries any real
 * mismatch among hundreds of false ones.
 *
 * So the warning is now computed, or it is not shown.
 */

export type BalanceContinuity = {
  /** Ids of transactions whose printed balance does not follow from the previous one. */
  mismatchedIds: Set<string>;
  /** False when the chain could not be verified, in which case nothing is claimed. */
  verified: boolean;
  /** Why verification was skipped, for the UI and for logs. */
  reason: string;
};

const CENT = 0.005;

function toCents(value: number): number {
  return Math.round(value * 100);
}

/**
 * Walk the chain in canonical statement order.
 *
 * Canonical order is required, not preferred: a statement prints several
 * movements on one day, and the chain depends on their order within that day.
 * Sorting the same 615 production rows by date produced 513 phantom gaps and by
 * insertion time produced 615, against a true order with none. So when
 * `sourceRow` is missing — rows written before it was persisted — the honest
 * answer is that nothing can be verified, and no warning is shown at all.
 */
export function computeBalanceContinuity(
  transactions: AccountingTransaction[],
  openingBalance: number | null | undefined,
): BalanceContinuity {
  const none = (reason: string): BalanceContinuity => ({ mismatchedIds: new Set(), verified: false, reason });

  if (!transactions.length) return none("no transactions");
  if (openingBalance === null || openingBalance === undefined) return none("no opening balance to chain from");

  const ordered = [...transactions];
  const missingSequence = ordered.some((t) => t.sourceRow === null || t.sourceRow === undefined);
  if (missingSequence) return none("canonical order unavailable — reprocess to populate the sequence");
  ordered.sort((a, b) => (a.sourceRow ?? 0) - (b.sourceRow ?? 0));

  // Every row must carry a printed balance, or the chain has holes that are not
  // mismatches — they are simply unknown, and guessing across them would
  // manufacture the very false warnings this replaces.
  if (ordered.some((t) => t.runningBalance === null || t.runningBalance === undefined)) {
    return none("some rows have no printed running balance");
  }

  const mismatchedIds = new Set<string>();
  let previous = toCents(openingBalance);
  for (const transaction of ordered) {
    const expected = previous + toCents(transaction.creditAmount ?? 0) - toCents(transaction.debitAmount ?? 0);
    const actual = toCents(transaction.runningBalance as number);
    if (Math.abs(expected - actual) > toCents(CENT)) mismatchedIds.add(transaction.id);
    // Continue from what the STATEMENT printed, not from what we expected, so a
    // single break flags one row rather than every row after it.
    previous = actual;
  }

  return { mismatchedIds, verified: true, reason: mismatchedIds.size ? `${mismatchedIds.size} balance break(s)` : "chain is continuous" };
}
