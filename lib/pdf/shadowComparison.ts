// Shadow-mode comparison (Phase C — observational only).
//
// Compares whatever the production pipeline actually adopted against what Azure
// Document Intelligence would have produced, for statements that ALREADY PASSED
// the acceptance gate. Nothing here influences the pipeline, the merge, the
// acceptance verdict or the exported workbook — it exists purely to gather
// evidence before any production behaviour changes.
//
// Pure by design: no I/O, no env reads. The caller supplies both extractions.
import type { ExtractionResult } from "@/lib/pdf/types";
import { scoreExtraction } from "@/lib/pdf/scoreExtraction";
import { validateBankStatement } from "@/lib/accounting/validateBankStatement";

export type ShadowMetric = {
  metric: string;
  current: string | number | null;
  azure: string | number | null;
  /** Signed delta where both sides are numeric, otherwise a human summary. */
  difference: string | number | null;
  /** Which side this metric favours. "tie" when neither is materially better. */
  favours: "current" | "azure" | "tie";
};

export type ShadowComparison = {
  currentProvider: string;
  azureAvailable: boolean;
  metrics: ShadowMetric[];
  /** The headline verdict for the report. */
  wouldAzureHaveBeenBetter: boolean;
  reason: string;
  /** Per-side tallies so a reviewer can see how close the call was. */
  score: { current: number; azure: number; ties: number };
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sumField(result: ExtractionResult, field: "debit" | "credit"): number {
  return round2(result.transactions.reduce((total, t) => total + Math.abs(t[field] ?? 0), 0));
}

// Page coverage: pages carrying real text over the document's page count.
export function pageCoverage(result: ExtractionResult): number {
  if (!result.pageCount) return 0;
  const withText = result.pages.filter((p) => (p.text || "").trim().length > 20).length;
  return round2(withText / result.pageCount);
}

// Row continuity: the share of consecutive transactions whose running balance
// chains correctly. This is the strongest single indicator that rows were
// segmented properly — a mis-split row breaks the chain immediately.
export function rowContinuity(result: ExtractionResult): number {
  const withBalance = result.transactions.filter((t) => typeof t.balance === "number");
  if (withBalance.length < 2) return 0;
  let consistent = 0;
  for (let i = 1; i < withBalance.length; i += 1) {
    const expected = (withBalance[i - 1].balance as number) + (withBalance[i].credit ?? 0) - (withBalance[i].debit ?? 0);
    if (Math.abs(expected - (withBalance[i].balance as number)) < 0.05) consistent += 1;
  }
  return round2(consistent / (withBalance.length - 1));
}

// A description that ends mid-token, or is suspiciously short, is the signature
// of a wrapped line that was never rejoined.
const TRUNCATED_TAIL = /[A-Za-z0-9]-$|\b(?:AND|OF|TO|FOR|THE|REF|PMT)$/i;

export function wrappedDescriptionRecovery(result: ExtractionResult): number {
  const described = result.transactions.filter((t) => (t.description ?? "").trim().length > 0);
  if (!described.length) return 0;
  const clean = described.filter((t) => !TRUNCATED_TAIL.test((t.description ?? "").trim()));
  return round2(clean.length / described.length);
}

// Merchant description quality: non-empty, of usable length, and not reduced to
// punctuation or a bare reference number.
export function merchantDescriptionQuality(result: ExtractionResult): number {
  if (!result.transactions.length) return 0;
  const good = result.transactions.filter((t) => {
    const d = (t.description ?? "").trim();
    return d.length >= 4 && /[A-Za-z]{3,}/.test(d);
  });
  return round2(good.length / result.transactions.length);
}

// Transaction grouping quality: rows carrying BOTH a date and an amount. A row
// that lost its date, or an amount, was grouped wrongly.
export function groupingQuality(result: ExtractionResult): number {
  if (!result.transactions.length) return 0;
  const complete = result.transactions.filter((t) => Boolean(t.date) && (t.debit != null || t.credit != null));
  return round2(complete.length / result.transactions.length);
}

export function missingFields(result: ExtractionResult): string[] {
  const missing: string[] = [];
  if (result.metadata.openingBalance == null) missing.push("openingBalance");
  if (result.metadata.closingBalance == null) missing.push("closingBalance");
  if (result.metadata.statementPeriodStart == null) missing.push("statementPeriodStart");
  if (result.metadata.statementPeriodEnd == null) missing.push("statementPeriodEnd");
  if (result.metadata.accountNumber == null) missing.push("accountNumber");
  return missing;
}

// Higher is better for every metric in this list, so `favours` is a comparison.
type NumericMetric = { metric: string; current: number | null; azure: number | null; higherIsBetter: boolean; tolerance?: number };

function compareNumeric({ metric, current, azure, higherIsBetter, tolerance = 0 }: NumericMetric): ShadowMetric {
  if (current == null || azure == null) {
    return { metric, current, azure, difference: null, favours: "tie" };
  }
  const delta = round2(azure - current);
  let favours: ShadowMetric["favours"] = "tie";
  if (Math.abs(delta) > tolerance) favours = (delta > 0) === higherIsBetter ? "azure" : "current";
  return { metric, current, azure, difference: delta, favours };
}

/**
 * Build the comparison. `current` is whatever the pipeline actually adopted;
 * `azure` is the shadow extraction. Both are scored with the SAME functions the
 * production pipeline uses, so the numbers are directly comparable.
 */
export function compareExtractions(current: ExtractionResult, azure: ExtractionResult | null, currentProvider: string): ShadowComparison {
  if (!azure) {
    return {
      currentProvider,
      azureAvailable: false,
      metrics: [],
      wouldAzureHaveBeenBetter: false,
      reason: "Azure produced no result (unconfigured, failed or timed out).",
      score: { current: 0, azure: 0, ties: 0 },
    };
  }

  const currentValidation = validateBankStatement(current);
  const azureValidation = validateBankStatement(azure);
  const currentScore = scoreExtraction(current);
  const azureScore = scoreExtraction(azure);

  const currentMissing = missingFields(current);
  const azureMissing = missingFields(azure);

  const metrics: ShadowMetric[] = [
    compareNumeric({ metric: "extractionConfidence", current: currentScore.score, azure: azureScore.score, higherIsBetter: true, tolerance: 2 }),
    compareNumeric({ metric: "transactionCount", current: current.transactions.length, azure: azure.transactions.length, higherIsBetter: true, tolerance: 0 }),
    compareNumeric({ metric: "openingBalance", current: num(current.metadata.openingBalance), azure: num(azure.metadata.openingBalance), higherIsBetter: true, tolerance: Infinity }),
    compareNumeric({ metric: "closingBalance", current: num(current.metadata.closingBalance), azure: num(azure.metadata.closingBalance), higherIsBetter: true, tolerance: Infinity }),
    compareNumeric({ metric: "debitTotal", current: sumField(current, "debit"), azure: sumField(azure, "debit"), higherIsBetter: true, tolerance: Infinity }),
    compareNumeric({ metric: "creditTotal", current: sumField(current, "credit"), azure: sumField(azure, "credit"), higherIsBetter: true, tolerance: Infinity }),
    // Reconciliation: SMALLER absolute difference wins.
    compareNumeric({
      metric: "reconciliationDifference",
      current: currentValidation.difference != null ? Math.abs(currentValidation.difference) : null,
      azure: azureValidation.difference != null ? Math.abs(azureValidation.difference) : null,
      higherIsBetter: false,
      tolerance: 0.05,
    }),
    compareNumeric({ metric: "wrappedDescriptionRecovery", current: wrappedDescriptionRecovery(current), azure: wrappedDescriptionRecovery(azure), higherIsBetter: true, tolerance: 0.02 }),
    compareNumeric({ metric: "merchantDescriptionQuality", current: merchantDescriptionQuality(current), azure: merchantDescriptionQuality(azure), higherIsBetter: true, tolerance: 0.02 }),
    compareNumeric({ metric: "transactionGroupingQuality", current: groupingQuality(current), azure: groupingQuality(azure), higherIsBetter: true, tolerance: 0.02 }),
    compareNumeric({ metric: "pageCoverage", current: pageCoverage(current), azure: pageCoverage(azure), higherIsBetter: true, tolerance: 0.02 }),
    compareNumeric({ metric: "rowContinuity", current: rowContinuity(current), azure: rowContinuity(azure), higherIsBetter: true, tolerance: 0.02 }),
    {
      metric: "missingFields",
      current: currentMissing.length ? currentMissing.join(", ") : "none",
      azure: azureMissing.length ? azureMissing.join(", ") : "none",
      difference: azureMissing.length - currentMissing.length,
      favours: azureMissing.length === currentMissing.length ? "tie" : azureMissing.length < currentMissing.length ? "azure" : "current",
    },
  ];

  // Balance/total metrics are reported for inspection but never "won" — a
  // different figure is not automatically a better one. `tolerance: Infinity`
  // above forces them to tie; this keeps the verdict honest.
  const decisive = metrics.filter((m) => !["openingBalance", "closingBalance", "debitTotal", "creditTotal"].includes(m.metric));
  const score = {
    current: decisive.filter((m) => m.favours === "current").length,
    azure: decisive.filter((m) => m.favours === "azure").length,
    ties: decisive.filter((m) => m.favours === "tie").length,
  };

  // Verdict. Reconciliation is the one metric that can decide on its own: if the
  // adopted extraction already reconciles and Azure does not, Azure is not
  // better no matter how many soft metrics it wins.
  const currentReconciles = currentValidation.valid;
  const azureReconciles = azureValidation.valid;

  let wouldAzureHaveBeenBetter: boolean;
  let reason: string;

  if (currentReconciles && !azureReconciles) {
    wouldAzureHaveBeenBetter = false;
    reason = "Current extraction reconciles and Azure does not — reconciliation outranks every other signal.";
  } else if (!currentReconciles && azureReconciles) {
    wouldAzureHaveBeenBetter = true;
    reason = "Azure reconciles where the current extraction does not.";
  } else if (score.azure > score.current) {
    wouldAzureHaveBeenBetter = true;
    reason = `Azure won ${score.azure} of ${decisive.length} decisive metrics against ${score.current}.`;
  } else if (score.current > score.azure) {
    wouldAzureHaveBeenBetter = false;
    reason = `Current provider won ${score.current} of ${decisive.length} decisive metrics against ${score.azure}.`;
  } else {
    wouldAzureHaveBeenBetter = false;
    reason = "No material difference — both extractions are equivalent on every decisive metric.";
  }

  return { currentProvider, azureAvailable: true, metrics, wouldAzureHaveBeenBetter, reason, score };
}

// ── Sampling gate ─────────────────────────────────────────────────────────────
//
// Shadow mode costs one Azure call per statement, so it is only worth spending
// where Azure has a REALISTIC chance of improving extraction. A statement whose
// extraction is already complete and reconciles exactly has nothing for a layout
// engine to fix — sampling it would buy noise.
//
// Skips are still RECORDED (with a reason) rather than silently dropped: "0
// candidates in 50 statements" is itself strong evidence that promoting Azure is
// unjustified, and that only reads if the skips are counted.

export type ShadowSampleDecision = {
  sample: boolean;
  /** Why it was sampled, or why it was skipped. Always populated. */
  reason: string;
};

/** Extraction confidence at or above this is treated as already-good. */
export const SHADOW_MIN_EXTRACTION_CONFIDENCE = 95;

export type ShadowSampleEvidence = {
  /** 0..100 from the acceptance engine. */
  extractionConfidence: number;
  /** 0..100 derived from the statement checks; null when nothing was checked. */
  reconciliationConfidence: number | null;
  /** Signed reconciliation difference; null when it could not be computed. */
  reconciliationDifference: number | null;
  /** Rows the validation believes are missing. */
  missingTransactionCount: number | null;
  /** The adopted extraction, for description/field inspection. */
  merged: ExtractionResult;
  /** Extraction-level review flag (NOT the worker's per-transaction one). */
  extractionRequiresReview: boolean;
};

/**
 * Decide whether this statement is worth shadowing.
 *
 * Sampled when ANY signal suggests extraction fell short. Skipped only when the
 * extraction is complete on every axis.
 */
export function decideShadowSample(e: ShadowSampleEvidence): ShadowSampleDecision {
  const reasons: string[] = [];

  if (e.extractionConfidence < SHADOW_MIN_EXTRACTION_CONFIDENCE) {
    reasons.push(`extraction confidence ${e.extractionConfidence} < ${SHADOW_MIN_EXTRACTION_CONFIDENCE}`);
  }
  if (e.reconciliationConfidence != null && e.reconciliationConfidence < 100) {
    reasons.push(`reconciliation confidence ${e.reconciliationConfidence} < 100`);
  }
  if (e.reconciliationDifference != null && Math.abs(e.reconciliationDifference) > 0.005) {
    reasons.push(`reconciliation difference ${e.reconciliationDifference.toFixed(2)} ≠ 0`);
  }
  if (wrappedDescriptionRecovery(e.merged) < 1) {
    reasons.push("wrapped transaction descriptions detected");
  }
  if (hasMultiLineDescriptions(e.merged)) {
    reasons.push("multi-line merchant descriptions detected");
  }
  const missingBalances = missingFields(e.merged).filter((f) => f === "openingBalance" || f === "closingBalance");
  if (missingBalances.length) {
    reasons.push(`missing ${missingBalances.join(" and ")}`);
  }
  if (typeof e.missingTransactionCount === "number" && e.missingTransactionCount > 0) {
    reasons.push(`${e.missingTransactionCount} transaction row(s) missing`);
  }
  // Extraction-level review only. The worker's per-transaction review flags are
  // CLASSIFICATION decisions and Azure cannot influence them, so they must not
  // trigger a sample.
  if (e.extractionRequiresReview) {
    reasons.push("review required by the extraction gate (not classification)");
  }

  if (reasons.length) {
    return { sample: true, reason: reasons.join("; ") };
  }
  return {
    sample: false,
    reason: `extraction already complete (confidence ${e.extractionConfidence}, reconciled exactly, all rows and balances recovered)`,
  };
}

// A description carrying an embedded newline, or a run of whitespace wide enough
// to be a column break, is a merchant name the parser spread over several lines.
export function hasMultiLineDescriptions(result: ExtractionResult): boolean {
  return result.transactions.some((t) => {
    const d = t.description ?? "";
    return /[\r\n]/.test(d) || /\s{4,}/.test(d);
  });
}
