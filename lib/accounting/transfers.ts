/**
 * Inter-account transfer detection.
 *
 * The accounting reason this exists: money moved between two accounts the same
 * business owns is not income and not an expense. Left unmatched, a R50,000
 * transfer appears as R50,000 of expense on one statement and R50,000 of income
 * on the other — inflating both sides of the profit and loss by the same amount
 * and leaving the net result unchanged, which is exactly the kind of error that
 * survives a casual review.
 *
 * Everything here is deterministic: dates, amounts, direction and account
 * identity. No model call. The output is CANDIDATES with stated evidence, never
 * a decision — nothing in this module marks a transfer as confirmed, because a
 * wrong automatic match creates the opposite error to the one it set out to fix,
 * silently removing real income or real expense from the accounts.
 */

export type TransferSide = {
  transactionId: string;
  runId: string;
  /** From the owning statement run. Null when the statement did not state it. */
  accountNumber: string | null;
  accountLabel: string;
  date: string | null;
  debit: number | null;
  credit: number | null;
  description: string;
};

export type TransferStrength = "strong" | "possible";

export type TransferCandidate = {
  outbound: TransferSide;
  inbound: TransferSide;
  amount: number;
  /** Absolute difference between the two legs. 0 for an exact match. */
  amountDelta: number;
  dayGap: number;
  strength: TransferStrength;
  /** Why this pair was surfaced, in the words shown to the accountant. */
  evidence: string[];
};

/** A transfer's legs settle within a few days; beyond that the pairing is coincidence. */
export const MAX_TRANSFER_DAY_GAP = 5;
const STRONG_DAY_GAP = 3;

/** Cents-level tolerance for "the same amount", to absorb rounding only. */
const EXACT_AMOUNT_EPSILON = 0.005;

/**
 * Wider tolerance for a possible match, to allow a transfer fee deducted in
 * flight. Deliberately small and absolute: a percentage tolerance would grow
 * with the amount and start pairing unrelated large transactions.
 */
const NEAR_AMOUNT_TOLERANCE = 60;

function dayGap(a: string, b: string): number {
  const first = Date.parse(a);
  const second = Date.parse(b);
  if (Number.isNaN(first) || Number.isNaN(second)) return Number.POSITIVE_INFINITY;
  return Math.abs(first - second) / 86_400_000;
}

function looksLikeTransferWording(description: string): boolean {
  return /\btransfer\b|\btrf\b|\bib\s|internet\s+bank|\bmove\b/i.test(description);
}

/**
 * Pair outbound debits with inbound credits that plausibly represent the same
 * movement of money.
 *
 * Rejected by construction:
 *   - Same statement run. A transfer's two legs are recorded on two different
 *     statements; a debit and a credit on one statement are two transactions.
 *   - Same account number, when both are known. Money is not transferred to the
 *     account it came from.
 *   - Anything already decided, passed in via `decidedTransactionIds`.
 */
export function findTransferCandidates(
  sides: TransferSide[],
  decidedTransactionIds: Set<string> = new Set(),
): TransferCandidate[] {
  const outbound = sides.filter((side) => (side.debit ?? 0) > 0 && !decidedTransactionIds.has(side.transactionId));
  const inbound = sides.filter((side) => (side.credit ?? 0) > 0 && !decidedTransactionIds.has(side.transactionId));

  const candidates: TransferCandidate[] = [];

  for (const out of outbound) {
    for (const inn of inbound) {
      if (out.transactionId === inn.transactionId) continue;

      // Two legs, two statements. Without this a single statement's own debits
      // and credits would pair with each other.
      if (out.runId === inn.runId) continue;

      // Known-equal account numbers mean one account, so no transfer. Unknown
      // account numbers are not treated as a match, only as unproven — the
      // different-run and date-window rules still apply, and the pair can never
      // reach "strong" without confirmed account identity.
      const accountsKnown = Boolean(out.accountNumber && inn.accountNumber);
      if (accountsKnown && out.accountNumber === inn.accountNumber) continue;

      if (!out.date || !inn.date) continue;
      const gap = dayGap(out.date, inn.date);
      if (gap > MAX_TRANSFER_DAY_GAP) continue;

      const outAmount = out.debit ?? 0;
      const inAmount = inn.credit ?? 0;
      const delta = Math.abs(outAmount - inAmount);
      if (delta > NEAR_AMOUNT_TOLERANCE) continue;

      const exact = delta <= EXACT_AMOUNT_EPSILON;
      const wording = looksLikeTransferWording(out.description) || looksLikeTransferWording(inn.description);

      const evidence: string[] = [];
      evidence.push(exact ? "Amounts match exactly" : `Amounts differ by ${delta.toFixed(2)}`);
      evidence.push(gap === 0 ? "Same date" : `${gap} day${gap === 1 ? "" : "s"} apart`);
      evidence.push(
        accountsKnown
          ? "Different accounts in this workspace"
          : "Different statements, but at least one account number is unknown",
      );
      if (wording) evidence.push("Description mentions a transfer");

      // "Strong" requires every independent signal to agree: exact amount, a
      // tight date window, and confirmed different accounts. Wording alone
      // never promotes a pair — "IB TRANSFER TO" appears on plenty of payments
      // to third parties, which are genuine expenses.
      const strength: TransferStrength = exact && gap <= STRONG_DAY_GAP && accountsKnown ? "strong" : "possible";

      candidates.push({
        outbound: out,
        inbound: inn,
        amount: outAmount,
        amountDelta: delta,
        dayGap: gap,
        strength,
        evidence,
      });
    }
  }

  // Best evidence first: strong before possible, then closest amount, then
  // closest date, then a stable id order so the same data always renders the
  // same way.
  candidates.sort(
    (a, b) =>
      Number(b.strength === "strong") - Number(a.strength === "strong") ||
      a.amountDelta - b.amountDelta ||
      a.dayGap - b.dayGap ||
      a.outbound.transactionId.localeCompare(b.outbound.transactionId),
  );

  return candidates;
}

/**
 * Keep only the best candidate for each transaction.
 *
 * One payment cannot be two transfers. Without this, a round R50,000 debit near
 * three separate R50,000 credits would offer three contradictory pairings, and
 * confirming them all would remove three times the money that actually moved.
 * Ranking is already applied, so the first candidate touching a transaction
 * wins and later ones referencing either leg are dropped.
 */
export function bestTransferCandidates(candidates: TransferCandidate[]): TransferCandidate[] {
  const claimed = new Set<string>();
  const kept: TransferCandidate[] = [];
  for (const candidate of candidates) {
    if (claimed.has(candidate.outbound.transactionId) || claimed.has(candidate.inbound.transactionId)) continue;
    claimed.add(candidate.outbound.transactionId);
    claimed.add(candidate.inbound.transactionId);
    kept.push(candidate);
  }
  return kept;
}
