/**
 * Statement integrity and accounting coverage — deliberately two questions.
 *
 * "Was the statement read correctly?" and "has the accounting been decided?"
 * are different questions with different evidence, and answering them with one
 * number answers neither. On the real 615-row Standard Bank statement the
 * single blended figure read 67%, which described a statement that was in fact
 * reconstructed completely and reconciled to the cent — 615 of 615 rows, every
 * balance continuous, difference R0.00. The 67% was the average accounting
 * confidence of 615 rows, most of which nobody had classified yet, presented in
 * a field called extraction accuracy.
 *
 * The practical harm is not cosmetic. An accountant reading "67% extracted"
 * distrusts the ledger and re-checks the extraction — the one part that was
 * provably correct — while the actual finding, that 426 rows await an
 * accounting decision, is nowhere on screen.
 *
 * So: unresolved accounting rows never lower extraction integrity, and
 * classification confidence is measured only over rows that were actually
 * classified. An average that includes "I don't know" is not a confidence.
 */

import type { AccountingTransaction } from "@/lib/accounting/types";
import { isUnresolvedAccountingCategory } from "@/lib/accounting/review-options";

/** Provenance values that represent a real accounting decision. */
const CLASSIFIED_SOURCES = new Set(["deterministic", "learned_rule", "ai", "manual"]);

export type EvidenceGrade = "deterministic" | "learned_rule" | "ai" | "manual";

export type AccountingCoverage = {
  transactionCount: number;
  /** Rows carrying a genuine accounting treatment. */
  classified: number;
  /** Rows still awaiting an accounting decision. */
  unresolved: number;
  /** classified / total, 0-100. Null when there are no transactions. */
  coveragePercent: number | null;
  /** Total money moved by unresolved rows — the size of the open question. */
  unresolvedValue: number;
  /**
   * Mean confidence across CLASSIFIED rows only.
   *
   * Null when nothing is classified: an absent score is honest where 0 would
   * read as "classified, badly".
   */
  classifiedConfidence: number | null;
  /** How the classified rows were decided. */
  evidence: Record<EvidenceGrade, number>;
};

/**
 * A row counts as classified only if BOTH its provenance and its category say
 * so.
 *
 * Either alone is insufficient, and the gap between them is where a false
 * "classified" comes from: PR #59 established that an AI decline stays
 * `unresolved`, but a row can also carry a real provenance while its category
 * is still a review bucket — classified by mechanism, undecided in substance.
 */
export function isClassified(transaction: AccountingTransaction): boolean {
  const source = transaction.classificationSource;
  if (!source || !CLASSIFIED_SOURCES.has(source)) return false;
  return !isUnresolvedAccountingCategory(transaction.accountCategory);
}

export function summarizeAccountingCoverage(transactions: AccountingTransaction[]): AccountingCoverage {
  const evidence: Record<EvidenceGrade, number> = {
    deterministic: 0,
    learned_rule: 0,
    ai: 0,
    manual: 0,
  };

  let classified = 0;
  let unresolvedValue = 0;
  let confidenceTotal = 0;
  let confidenceCount = 0;

  for (const transaction of transactions) {
    if (isClassified(transaction)) {
      classified += 1;
      const grade = transaction.classificationSource as EvidenceGrade;
      if (grade in evidence) evidence[grade] += 1;

      // classificationConfidence is the classification's own score;
      // `confidence` is an extraction signal and is deliberately not used here.
      const score = transaction.classificationConfidence;
      if (typeof score === "number" && Number.isFinite(score)) {
        confidenceTotal += score;
        confidenceCount += 1;
      }
      continue;
    }

    unresolvedValue += (transaction.debitAmount ?? 0) + (transaction.creditAmount ?? 0);
  }

  const transactionCount = transactions.length;

  return {
    transactionCount,
    classified,
    unresolved: transactionCount - classified,
    coveragePercent: transactionCount ? Math.round((classified / transactionCount) * 100) : null,
    unresolvedValue,
    classifiedConfidence: confidenceCount ? Math.round(confidenceTotal / confidenceCount) : null,
    evidence,
  };
}

export type StatementIntegrity = {
  transactionCount: number;
  /** Rows carrying the source row they were read from. */
  withSourceRow: number;
  sourceRowComplete: boolean;
  reconciled: boolean;
  reconciliationDifference: number | null;
  /** Extraction-only score from the worker. Never blended with classification. */
  extractionConfidence: number | null;
};

/**
 * Integrity, built strictly from extraction evidence.
 *
 * `transactions` are used only for what they reveal about the READ — how many
 * rows, and whether each carries the source row it came from. Nothing about
 * their accounting treatment enters this function, which is the property the
 * tests pin: reclassifying every row, or none, must not move this number.
 */
export function summarizeStatementIntegrity(input: {
  transactions: AccountingTransaction[];
  reconciliationDifference: number | null;
  extractionConfidence: number | null;
}): StatementIntegrity {
  const withSourceRow = input.transactions.filter((t) => t.sourceRow != null).length;
  const difference = input.reconciliationDifference;

  return {
    transactionCount: input.transactions.length,
    withSourceRow,
    sourceRowComplete: input.transactions.length > 0 && withSourceRow === input.transactions.length,
    // A cent tolerance, matching the worker. Exact float equality would report
    // a reconciled statement as broken over a rounding artefact.
    reconciled: difference != null && Math.abs(difference) <= 0.05,
    reconciliationDifference: difference,
    extractionConfidence: input.extractionConfidence,
  };
}
