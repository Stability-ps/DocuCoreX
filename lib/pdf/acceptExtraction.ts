// The single acceptance gate. EVERY extraction result passes through this
// function before it is returned, regardless of which strategy produced it — a
// pure-native parse of a pristine digital PDF is scrutinised exactly as hard as
// a scanned document that needed two OCR engines.
//
// WHICH checks apply depends on what the document is expected to be:
//
//   expect: "bank_statement"          expect: "document"
//   1. extraction    ✓                1. extraction    ✓
//   2. completeness  ✓                2. completeness  — n/a
//   3. reconciliation ✓               3. reconciliation — n/a
//   4. agreement     ✓                4. agreement     ✓
//
// The statement checks demand transaction rows and opening/closing balances.
// Applying them to an invoice, contract or ID would reject a perfectly good
// extraction and escalate it through both OCR engines for no benefit — so for a
// generic document, "text was extracted and the sources agree" IS success.
// Statement validation is still computed and returned either way; under
// "document" it simply does not cause rejection.
//
// Engine-reported OCR confidence is deliberately NOT one of these checks. A high
// Tesseract or Mistral confidence means the characters were legible, not that
// the extraction is correct — it can never on its own promote a result to
// validated. It is recorded for comparison and for the escalation decision only.
import type {
  AcceptanceVerdict,
  BankStatementValidation,
  ExtractionResult,
  OcrEngineComparison,
  OcrEngineId,
  ParserSelection,
  PdfAnalysis,
} from "@/lib/pdf/types";
import { mergeExtractionResults } from "@/lib/pdf/mergeExtractionResults";
import { scoreExtraction } from "@/lib/pdf/scoreExtraction";
import { validateBankStatement } from "@/lib/accounting/validateBankStatement";

export type AcceptanceCandidates = {
  pdfjs?: ExtractionResult;
  pdfplumber?: ExtractionResult;
  ocr?: ExtractionResult;
  mistral?: ExtractionResult;
  azure?: ExtractionResult;
};

/**
 * What the caller expects the document to be. Defaults to "bank_statement"
 * everywhere so a caller that forgets to declare it keeps the STRICTER checks —
 * losing reconciliation on a real statement is a correctness bug, whereas an
 * unnecessary strict pass on a generic document only costs an escalation.
 */
export type ExtractionExpectation = "bank_statement" | "document";

export type AcceptanceOptions = { expect?: ExtractionExpectation };

// Generic-document quality floor: on a multi-page document, text recovered from
// only a handful of pages means the extraction partially FAILED (a mixed PDF
// where some pages are scanned images), which is worth escalating to OCR. This
// is document-agnostic — it measures extraction quality, not banking semantics.
export const GENERIC_MIN_PAGE_COVERAGE = 0.5;
const PAGE_HAS_TEXT_MIN_CHARS = 20;

function pageCoverage(merged: ExtractionResult): number | null {
  // Only meaningful when we have per-page detail for a multi-page document.
  if (merged.pageCount <= 1 || merged.pages.length === 0) return null;
  const withText = merged.pages.filter((p) => (p.text || "").trim().length > PAGE_HAS_TEXT_MIN_CHARS).length;
  return withText / merged.pageCount;
}

export type AcceptanceResult = {
  selection: ParserSelection;
  merged: ExtractionResult;
  validation: BankStatementValidation;
  verdict: AcceptanceVerdict;
  accepted: boolean; // verdict === "validated"
  /** Every reason the result fell short of "validated" — never empty when not accepted. */
  rejectionReasons: string[];
  /** Which OCR engine's output was selected, or null for a native-only result. */
  ocrEngine: OcrEngineId | null;
  /** Head-to-head record, populated when at least one OCR engine ran. */
  ocrEngineComparison: OcrEngineComparison[];
};

// Map a merged parser id back to the OCR engine that produced it. "hybrid" is
// resolved by asking which OCR candidate actually contributed the transactions.
function resolveOcrEngine(selection: ParserSelection, candidates: AcceptanceCandidates, merged: ExtractionResult): OcrEngineId | null {
  if (selection.selectedParser === "ocr") return "tesseract";
  if (selection.selectedParser === "mistral_ocr") return "mistral_ocr";
  if (selection.selectedParser === "azure_di") return "azure_di";
  if (selection.selectedParser !== "hybrid") return null;
  // Hybrid: the transactions carry the substance, so credit whichever OCR engine
  // supplied them (identified by reference equality with the merged rows).
  if (candidates.ocr && candidates.ocr.transactions === merged.transactions) return "tesseract";
  if (candidates.mistral && candidates.mistral.transactions === merged.transactions) return "mistral_ocr";
  if (candidates.azure && candidates.azure.transactions === merged.transactions) return "azure_di";
  return null;
}

function buildComparison(candidates: AcceptanceCandidates, winner: OcrEngineId | null): OcrEngineComparison[] {
  const entries: Array<{ engine: OcrEngineId; result: ExtractionResult }> = [];
  if (candidates.ocr) entries.push({ engine: "tesseract", result: candidates.ocr });
  if (candidates.mistral) entries.push({ engine: "mistral_ocr", result: candidates.mistral });
  if (candidates.azure) entries.push({ engine: "azure_di", result: candidates.azure });
  return entries.map(({ engine, result }) => ({
    engine,
    score: scoreExtraction(result).score,
    confidence: result.confidence ?? null,
    chars: result.combinedText.trim().length,
    transactions: result.transactions.length,
    won: engine === winner,
  }));
}

export function acceptExtraction(analysis: PdfAnalysis, candidates: AcceptanceCandidates, options: AcceptanceOptions = {}): AcceptanceResult {
  const expect = options.expect ?? "bank_statement";
  const isStatement = expect === "bank_statement";
  const { selection, merged } = mergeExtractionResults(analysis, candidates);
  // Always computed and returned, so the UI can show reconciliation for anything
  // that turns out to carry statement figures. Only GATES acceptance for statements.
  const validation = validateBankStatement(merged);

  const rejectionReasons: string[] = [];

  // 1. Extraction — did anything come back at all? Applies to every document.
  const hasText = merged.combinedText.trim().length > 0;
  const hasTransactions = merged.transactions.length > 0;
  if (!hasText && !hasTransactions) {
    rejectionReasons.push("No readable content was extracted.");
  } else if (isStatement && !hasTransactions) {
    // Only a defect for a statement. For a contract or an ID, zero transaction
    // rows is the expected outcome, not a failure.
    rejectionReasons.push("Text was extracted but no transaction rows were detected.");
  }

  if (!isStatement && hasText) {
    // Generic quality floor: partial recovery on a multi-page document means
    // some pages yielded nothing, which OCR may be able to fix. Nothing here
    // assumes the document is financial.
    const coverage = pageCoverage(merged);
    if (coverage != null && coverage < GENERIC_MIN_PAGE_COVERAGE) {
      rejectionReasons.push(
        `Text recovered from only ${Math.round(coverage * 100)}% of pages (minimum ${Math.round(GENERIC_MIN_PAGE_COVERAGE * 100)}%).`,
      );
    }
  }

  if (isStatement) {
    // 2. Completeness — the fields a statement must carry.
    if (merged.metadata.openingBalance == null) rejectionReasons.push("Opening balance is missing.");
    if (merged.metadata.closingBalance == null) rejectionReasons.push("Closing balance is missing.");

    // 3. Reconciliation.
    if (!validation.valid) {
      const diff = validation.difference;
      rejectionReasons.push(diff != null ? `Reconciliation failed (difference ${diff.toFixed(2)}).` : "Reconciliation could not be completed.");
    }
  }

  // 4. Agreement between sources — surfaced, never silently resolved. Applies to
  // every document: two engines reading different text is a defect regardless of
  // what the document is.
  for (const disagreement of selection.disagreements) {
    rejectionReasons.push(disagreement.detail);
  }

  // The merge layer's own low-confidence flag is transaction-weighted
  // (scoreExtraction), so it is only meaningful for a statement.
  if (isStatement && selection.requiresReview && !rejectionReasons.length) {
    rejectionReasons.push(`Extraction confidence is low (${selection.confidence}).`);
  }

  // "failed" is reserved for nothing usable at all; anything partial is review.
  const verdict: AcceptanceVerdict = !hasText && !hasTransactions ? "failed" : rejectionReasons.length ? "review_required" : "validated";

  const ocrEngine = resolveOcrEngine(selection, candidates, merged);

  return {
    selection,
    merged,
    validation,
    verdict,
    accepted: verdict === "validated",
    rejectionReasons,
    ocrEngine,
    ocrEngineComparison: buildComparison(candidates, ocrEngine),
  };
}
