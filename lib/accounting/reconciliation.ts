/**
 * Bank reconciliation types and the matching rules.
 *
 * No server imports — the browser and the tests both use this.
 *
 * THE TWO BALANCES ARE DIFFERENT THINGS. `statementBalance` is what the bank
 * printed; `ledgerBalance` is what the books say, derived from postings. This
 * module never lets one stand in for the other, and the difference between them
 * is the thing being explained rather than an error to be hidden.
 */

export type ReconciliationItemType =
  | "matched"
  | "timing_difference"
  | "missing_posting"
  | "missing_bank_item"
  | "excluded";

export type BankAccountSummary = {
  id: string;
  label: string;
  bankName: string | null;
  accountNumber: string | null;
  ledgerAccountId: string;
  ledgerAccountCode: string;
  ledgerAccountName: string;
  /** What the bank printed on the latest statement in the period. Null when no statement is held. */
  statementBalance: number | null;
  statementDate: string | null;
  /** What the books say. Always derived from postings. */
  ledgerBalance: number;
  status: "reconciled" | "review" | "no_statement";
};

export type UnmatchedBankItem = {
  transactionId: string;
  date: string;
  description: string;
  reference: string | null;
  amount: number;
  runId: string;
};

export type UnmatchedLedgerEntry = {
  postingId: string;
  date: string;
  description: string | null;
  journalReference: string | null;
  amount: number;
};

export type ReconciliationItem = {
  id: string;
  transactionId: string | null;
  postingId: string | null;
  matchGroup: string | null;
  itemType: ReconciliationItemType;
  matchMethod: "manual" | "auto" | "suggested";
  matchConfidence: number | null;
  resolvingJournalId: string | null;
  note: string | null;
};

export type Reconciliation = {
  id: string;
  bankAccountId: string;
  periodStart: string;
  periodEnd: string;
  status: "in_progress" | "completed" | "reopened";
  statementBalance: number | null;
  ledgerBalanceAtCompletion: number | null;
  completedAt: string | null;
};

export const ITEM_TYPE_LABELS: Record<ReconciliationItemType, string> = {
  matched: "Matched",
  timing_difference: "Timing difference",
  missing_posting: "Missing from ledger",
  missing_bank_item: "Not yet on statement",
  excluded: "Excluded",
};

/**
 * A missing posting is an ACCOUNTING ERROR, not a reconciling item.
 *
 * Timing differences resolve themselves — the payment clears next month. A
 * missing posting means the books are wrong and someone has to act, so it must
 * never be allowed to make a reconciliation balance. The database enforces
 * this; the UI has to say it.
 */
export function isAccountingError(itemType: ReconciliationItemType): boolean {
  return itemType === "missing_posting";
}

export type MatchSuggestion = {
  transactionId: string;
  postingId: string;
  confidence: number;
  reasons: string[];
};

/** Days between two ISO dates, absolute. */
function daysApart(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Math.round(ms / 86_400_000);
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/** Proportion of the shorter string's words that appear in the longer. */
function wordOverlap(a: string, b: string): number {
  const left = new Set(normalise(a).split(" ").filter((word) => word.length > 2));
  const right = new Set(normalise(b).split(" ").filter((word) => word.length > 2));
  if (!left.size || !right.size) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let hits = 0;
  small.forEach((word) => {
    if (large.has(word)) hits += 1;
  });
  return hits / small.size;
}

/**
 * Propose matches between unmatched bank items and unmatched ledger entries.
 *
 * AMOUNT IS NECESSARY, NOT SUFFICIENT. A candidate must agree to the cent —
 * two entries that differ by any amount are not the same transaction, and
 * "close enough" matching is how a reconciliation silently absorbs an error.
 * Everything else raises or lowers confidence within that constraint.
 *
 * Nothing here confirms anything. Suggestions are returned for a person to
 * accept or reject; §5 and §6 both require that the accounting state never
 * depends on an automated decision.
 */
export function suggestMatches(
  bankItems: UnmatchedBankItem[],
  ledgerEntries: UnmatchedLedgerEntry[],
  options: { maxDaysApart?: number } = {},
): MatchSuggestion[] {
  const maxDays = options.maxDaysApart ?? 7;
  const suggestions: MatchSuggestion[] = [];
  const usedPostings = new Set<string>();

  // Deterministic: sort so the same inputs always propose the same matches,
  // regardless of the order the database happened to return rows in.
  const sortedBank = [...bankItems].sort((a, b) => a.date.localeCompare(b.date) || a.transactionId.localeCompare(b.transactionId));

  for (const bankItem of sortedBank) {
    const cents = Math.round(bankItem.amount * 100);

    const candidates = ledgerEntries
      .filter((entry) => !usedPostings.has(entry.postingId))
      .filter((entry) => Math.round(entry.amount * 100) === cents)
      .map((entry) => {
        const gap = daysApart(bankItem.date, entry.date);
        const overlap = wordOverlap(bankItem.description, entry.description ?? "");
        const referenceHit =
          Boolean(bankItem.reference) &&
          Boolean(entry.journalReference) &&
          normalise(bankItem.reference as string) === normalise(entry.journalReference as string);

        const reasons = ["Amount agrees to the cent"];
        // Confidence starts from the amount agreeing and is adjusted by the
        // weaker signals. It never reaches 100: a person confirms.
        let confidence = 60;
        if (gap === 0) {
          confidence += 20;
          reasons.push("Same date");
        } else if (gap <= maxDays) {
          confidence += 10;
          reasons.push(`${gap} day${gap === 1 ? "" : "s"} apart`);
        }
        if (referenceHit) {
          confidence += 15;
          reasons.push("Reference matches");
        }
        if (overlap >= 0.5) {
          confidence += 10;
          reasons.push("Description similar");
        }
        return { entry, gap, confidence: Math.min(confidence, 95), reasons };
      })
      .filter((candidate) => candidate.gap <= maxDays)
      .sort((a, b) => b.confidence - a.confidence || a.gap - b.gap || a.entry.postingId.localeCompare(b.entry.postingId));

    // Ambiguity is reported as lower confidence rather than resolved silently:
    // two equally good candidates means the system does not know which is right.
    const best = candidates[0];
    if (!best) continue;

    const tied = candidates.filter((candidate) => candidate.confidence === best.confidence).length > 1;
    usedPostings.add(best.entry.postingId);
    suggestions.push({
      transactionId: bankItem.transactionId,
      postingId: best.entry.postingId,
      confidence: tied ? Math.min(best.confidence, 50) : best.confidence,
      reasons: tied ? [...best.reasons, "Several entries match equally well"] : best.reasons,
    });
  }

  return suggestions;
}

export function confidenceLabel(confidence: number): "High" | "Medium" | "Low" {
  if (confidence >= 85) return "High";
  if (confidence >= 65) return "Medium";
  return "Low";
}

/**
 * The reconciliation statement, as an accountant would set it out.
 *
 *     statement balance
 *       − bank items not yet in the books
 *       + ledger entries not yet at the bank
 *       = ledger balance
 *
 * `unexplained` is the residual. It is computed in cents, because a
 * reconciliation that "balances" to 5.6e-17 has not balanced.
 */
export function reconciliationStatement(input: {
  statementBalance: number;
  ledgerBalance: number;
  bankSideItems: number[];
  ledgerSideItems: number[];
}): { bankSide: number; ledgerSide: number; unexplained: number; explained: boolean } {
  const cents = (value: number) => Math.round(value * 100);
  const bankSide = input.bankSideItems.reduce((total, amount) => total + cents(amount), 0);
  const ledgerSide = input.ledgerSideItems.reduce((total, amount) => total + cents(amount), 0);
  const residual = cents(input.statementBalance) - bankSide + ledgerSide - cents(input.ledgerBalance);
  return {
    bankSide: bankSide / 100,
    ledgerSide: ledgerSide / 100,
    unexplained: residual / 100,
    explained: residual === 0,
  };
}

/**
 * Whether a selected group of bank items and ledger entries may be matched.
 *
 * A match is a GROUP, not a pair: one transfer paying four invoices is one bank
 * line and four postings, and forcing that into pairs would either lose the
 * relationship or invent three bank lines that do not exist.
 *
 * The rule is the same one that governs a pair — the two sides must agree TO
 * THE CENT. A group that does not agree is not a match; it is a match plus a
 * difference, and the difference is exactly what a reconciliation exists to
 * surface rather than absorb.
 *
 * Signs: a bank debit and the ledger credit that answers it both reduce the
 * account, so the two sides are compared as magnitudes of the same movement.
 */
export function groupMatchStatus(input: {
  bankAmounts: number[];
  ledgerAmounts: number[];
}): { bankTotal: number; ledgerTotal: number; difference: number; canMatch: boolean; reason: string } {
  const cents = (values: number[]) => values.reduce((total, value) => total + Math.round(value * 100), 0);
  const bank = cents(input.bankAmounts);
  const ledger = cents(input.ledgerAmounts);

  if (!input.bankAmounts.length || !input.ledgerAmounts.length) {
    return {
      bankTotal: bank / 100,
      ledgerTotal: ledger / 100,
      difference: (bank - ledger) / 100,
      canMatch: false,
      reason: "Select at least one item on each side.",
    };
  }

  const difference = bank - ledger;
  return {
    bankTotal: bank / 100,
    ledgerTotal: ledger / 100,
    difference: difference / 100,
    canMatch: difference === 0,
    reason:
      difference === 0
        ? `${input.bankAmounts.length} bank ${input.bankAmounts.length === 1 ? "item" : "items"} against ${input.ledgerAmounts.length} ledger ${input.ledgerAmounts.length === 1 ? "entry" : "entries"}`
        : "The two sides differ; a group only matches when they agree to the cent.",
  };
}
