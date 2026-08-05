// The single acceptance gate. EVERY extraction result passes through this
// function before it is returned, regardless of which strategy produced it — a
// pure-native parse of a pristine digital PDF is scrutinised exactly as hard as
// a scanned document that needed two OCR engines.
//
// A result is "validated" ONLY when all four checks pass:
//   1. extraction   — some content was actually recovered
//   2. completeness — the fields a statement must have are present
//   3. reconciliation — the arithmetic balances
//   4. agreement    — no material conflict between extraction sources
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
};

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
  if (selection.selectedParser !== "hybrid") return null;
  // Hybrid: the transactions carry the substance, so credit whichever OCR engine
  // supplied them (identified by reference equality with the merged rows).
  if (candidates.ocr && candidates.ocr.transactions === merged.transactions) return "tesseract";
  if (candidates.mistral && candidates.mistral.transactions === merged.transactions) return "mistral_ocr";
  return null;
}

function buildComparison(candidates: AcceptanceCandidates, winner: OcrEngineId | null): OcrEngineComparison[] {
  const entries: Array<{ engine: OcrEngineId; result: ExtractionResult }> = [];
  if (candidates.ocr) entries.push({ engine: "tesseract", result: candidates.ocr });
  if (candidates.mistral) entries.push({ engine: "mistral_ocr", result: candidates.mistral });
  return entries.map(({ engine, result }) => ({
    engine,
    score: scoreExtraction(result).score,
    confidence: result.confidence ?? null,
    chars: result.combinedText.trim().length,
    transactions: result.transactions.length,
    won: engine === winner,
  }));
}

export function acceptExtraction(analysis: PdfAnalysis, candidates: AcceptanceCandidates): AcceptanceResult {
  const { selection, merged } = mergeExtractionResults(analysis, candidates);
  const validation = validateBankStatement(merged);

  const rejectionReasons: string[] = [];

  // 1. Extraction — did anything come back at all?
  const hasText = merged.combinedText.trim().length > 0;
  const hasTransactions = merged.transactions.length > 0;
  if (!hasText && !hasTransactions) {
    rejectionReasons.push("No readable content was extracted.");
  } else if (!hasTransactions) {
    rejectionReasons.push("Text was extracted but no transaction rows were detected.");
  }

  // 2. Completeness — the fields a statement must carry.
  if (merged.metadata.openingBalance == null) rejectionReasons.push("Opening balance is missing.");
  if (merged.metadata.closingBalance == null) rejectionReasons.push("Closing balance is missing.");

  // 3. Reconciliation.
  if (!validation.valid) {
    const diff = validation.difference;
    rejectionReasons.push(diff != null ? `Reconciliation failed (difference ${diff.toFixed(2)}).` : "Reconciliation could not be completed.");
  }

  // 4. Agreement between sources — surfaced, never silently resolved.
  for (const disagreement of selection.disagreements) {
    rejectionReasons.push(disagreement.detail);
  }

  // The merge layer's own low-confidence / review flag still counts.
  if (selection.requiresReview && !rejectionReasons.length) {
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
