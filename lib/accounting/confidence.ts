// The three confidence metrics, kept deliberately separate.
//
// A single "Confidence" percentage caused three consecutive misdiagnoses: a ~79%
// figure looked like an OCR failure for weeks when it was actually the mean of
// accounting-classification rule scores, and had nothing to do with extraction.
// These must never be averaged into one number.
//
//   Extraction      — how accurately the document was READ
//                     source: the extraction pipeline (selection.confidence)
//   Classification  — how confidently transactions were CATEGORISED
//                     source: classify_transaction / OpenAI in the worker
//   Reconciliation  — how internally CONSISTENT the reconstructed statement is
//                     source: balances, totals and continuity checks
//
// Pure: no I/O, no env reads.
import type { BankStatementValidation } from "@/lib/pdf/types";

export type ConfidenceTrio = {
  /** 0..100, or null when the producing stage never ran. */
  extraction: number | null;
  classification: number | null;
  reconciliation: number | null;
};

export type ConfidenceKind = keyof ConfidenceTrio;

export const CONFIDENCE_LABELS: Record<ConfidenceKind, string> = {
  extraction: "Extraction Confidence",
  classification: "Classification Confidence",
  reconciliation: "Reconciliation Confidence",
};

export const CONFIDENCE_DESCRIPTIONS: Record<ConfidenceKind, string> = {
  extraction: "How accurately the document was extracted.",
  classification: "How confidently transactions were categorised.",
  reconciliation: "How reliable the reconstructed statement is.",
};

// Weights for the reconciliation score. Reconciliation itself dominates: a
// statement whose arithmetic does not close is unreliable regardless of how many
// individual checks pass.
const RULE_WEIGHTS: Record<string, number> = {
  reconciliation: 50,
  closing_balance: 10,
  opening_balance: 10,
  transaction_count: 10,
  credit_total: 7,
  debit_total: 7,
  credit_count: 3,
  debit_count: 3,
};
const DEFAULT_RULE_WEIGHT = 5;

/**
 * Reconciliation confidence from the statement validation.
 *
 * Returns null when no checks ran at all — an absent score is honest, whereas 0
 * would read as "we checked and it failed".
 */
export function reconciliationConfidence(validation: BankStatementValidation | null | undefined): number | null {
  if (!validation || !validation.checks.length) return null;

  const total = validation.checks.reduce((sum, c) => sum + (RULE_WEIGHTS[c.rule] ?? DEFAULT_RULE_WEIGHT), 0);
  if (total === 0) return null;
  const earned = validation.checks.reduce((sum, c) => sum + (c.ok ? (RULE_WEIGHTS[c.rule] ?? DEFAULT_RULE_WEIGHT) : 0), 0);

  let score = (earned / total) * 100;

  // Missing rows are a completeness problem the per-rule checks understate: a
  // statement can reconcile on totals while having dropped rows.
  const missing = validation.missingTransactionCount;
  if (typeof missing === "number" && missing > 0) {
    score -= Math.min(30, missing * 5);
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Assemble the trio. Every input is optional so a partially-processed run
 * reports nulls rather than fabricated zeroes.
 */
export function buildConfidenceTrio(input: {
  extractionConfidence?: number | null;
  classificationConfidence?: number | null;
  validation?: BankStatementValidation | null;
  /** Pre-computed reconciliation score, when the worker already derived it. */
  reconciliationConfidence?: number | null;
}): ConfidenceTrio {
  const clamp = (v: number | null | undefined) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null;

  return {
    extraction: clamp(input.extractionConfidence),
    classification: clamp(input.classificationConfidence),
    reconciliation: clamp(input.reconciliationConfidence) ?? reconciliationConfidence(input.validation),
  };
}

/**
 * The single deprecated `confidence` field, for backwards compatibility ONLY.
 *
 * It has always carried the CLASSIFICATION score, so it keeps carrying exactly
 * that. It is deliberately NOT an average of the trio: averaging would change
 * the meaning of a field existing integrations already read, and would recreate
 * the very conflation this work exists to remove.
 *
 * @deprecated Read `confidences.classification` instead.
 */
export function legacyConfidence(trio: ConfidenceTrio): number | null {
  return trio.classification;
}
