// Pure decision: should the SECONDARY OCR engine (Mistral) be called?
//
// Tesseract/OCRmyPDF stays the primary engine. Mistral is a paid second opinion
// and is only worth its cost when the cheap path has demonstrably fallen short.
// The trigger conditions are exactly the four the product asked for:
//   1. OCR confidence is low
//   2. important fields are missing
//   3. reconciliation failed
//   4. Enhanced OCR was explicitly requested
//
// Note that conditions 2 and 3 can fire on a "native"-strategy document. That is
// deliberate: a missing closing balance or a failed reconciliation means the
// native parse is WRONG, not that the text layer is intact — so a second engine
// is worth trying even though the PDF is digital.
import type { ExtractionStrategy } from "@/lib/pdf/types";

function readThreshold(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : fallback;
}

// Below this engine-reported OCR confidence the primary result is not trusted.
export const MISTRAL_MIN_OCR_CONFIDENCE = readThreshold(process.env.MISTRAL_MIN_OCR_CONFIDENCE, 70);
// Below this merged-selection confidence the extraction as a whole is not trusted.
export const MISTRAL_MIN_SELECTION_CONFIDENCE = readThreshold(process.env.MISTRAL_MIN_SELECTION_CONFIDENCE, 60);
// Fewer characters than this from OCR means it effectively recovered nothing.
export const MISTRAL_MIN_OCR_CHARS = 40;

export type MistralEvidence = {
  /** MISTRAL_API_KEY present in this runtime. */
  configured: boolean;
  /** Explicit "Enhanced OCR" request from the caller. */
  enhanced: boolean;
  strategy: ExtractionStrategy;
  /** Whether the primary OCR engine ran at all. */
  ocrAttempted: boolean;
  /** Characters recovered by the primary OCR engine. */
  ocrChars: number;
  /** Engine-reported confidence 0..100 from the primary OCR engine, if any. */
  ocrConfidence: number | null;
  /** Merged selection confidence 0..100 from the acceptance engine. */
  selectionConfidence: number;
  transactionCount: number;
  hasOpeningBalance: boolean;
  hasClosingBalance: boolean;
  /** Reconciliation / validation flagged the result for review. */
  validationRequiresReview: boolean;
};

export type MistralDecision = { needed: boolean; reason: string };

export function decideMistralOcr(e: MistralEvidence): MistralDecision {
  // 1. Not configured — never attempt, never warn on every document.
  if (!e.configured) {
    return { needed: false, reason: "MISTRAL_API_KEY not configured" };
  }

  // 2. Explicit request always wins, whatever the analysis said.
  if (e.enhanced) {
    return { needed: true, reason: "Enhanced OCR explicitly requested" };
  }

  // 3. Low confidence from the primary OCR engine.
  if (e.ocrAttempted && e.ocrConfidence != null && e.ocrConfidence < MISTRAL_MIN_OCR_CONFIDENCE) {
    return { needed: true, reason: `primary OCR confidence ${e.ocrConfidence} < ${MISTRAL_MIN_OCR_CONFIDENCE}` };
  }

  // 4. The primary OCR engine ran and recovered essentially nothing.
  if (e.ocrAttempted && e.ocrChars < MISTRAL_MIN_OCR_CHARS) {
    return { needed: true, reason: `primary OCR recovered only ${e.ocrChars} chars` };
  }

  // 5. Important fields missing.
  if (e.transactionCount === 0) {
    return { needed: true, reason: "no transaction rows were extracted" };
  }
  if (!e.hasOpeningBalance || !e.hasClosingBalance) {
    const missing = [!e.hasOpeningBalance && "opening balance", !e.hasClosingBalance && "closing balance"].filter(Boolean).join(" and ");
    return { needed: true, reason: `missing ${missing}` };
  }

  // 6. Reconciliation failed.
  if (e.validationRequiresReview) {
    return { needed: true, reason: "reconciliation failed on the primary extraction" };
  }

  // 7. Overall extraction confidence too low to accept.
  if (e.selectionConfidence < MISTRAL_MIN_SELECTION_CONFIDENCE) {
    return { needed: true, reason: `selection confidence ${e.selectionConfidence} < ${MISTRAL_MIN_SELECTION_CONFIDENCE}` };
  }

  return { needed: false, reason: "primary extraction passed every check — second engine unnecessary" };
}
