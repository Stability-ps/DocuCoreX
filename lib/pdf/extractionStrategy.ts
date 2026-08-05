// Strategy selection: EVERY document is analysed first, and the analysis alone
// decides how it will be extracted. This replaces the ad-hoc booleans that were
// scattered through the pipeline (skipOcrFastPath / scannedFastPath) with one
// named decision that can be logged, persisted and unit-tested.
//
// Guiding rule: native extraction is preferred for genuine digital PDFs, because
// OCR cannot improve correctly embedded text — it can only degrade it. OCR is
// therefore never run speculatively on a healthy text layer; it stays reachable
// via escalation when the acceptance engine rejects the native result.
import type { ExtractionStrategy, PdfAnalysis } from "@/lib/pdf/types";

// A "digital" classification is only trusted when the analysis is also confident
// about it. Below this floor the text layer is treated as suspect and OCR is
// allowed to run alongside native extraction.
export const NATIVE_MIN_CONFIDENCE = readThreshold(process.env.NATIVE_MIN_CONFIDENCE, 60);

function readThreshold(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : fallback;
}

export type StrategyPlan = {
  strategy: ExtractionStrategy;
  reason: string;
  /** PDF.js + pdfplumber. Always true — native text is free and always a candidate. */
  runNative: boolean;
  /** Run OCR without waiting for the acceptance engine to reject the native result. */
  ocrUpfront: boolean;
};

/**
 * digital + confident   → "native"           native only; OCR only via escalation
 * digital + unconfident → "native_then_ocr"  text layer is suspect
 * weak-text             → "native_then_ocr"  mixed document — native plus OCR
 * scanned               → "ocr_primary"      OCR carries it; native still collected
 */
export function selectExtractionStrategy(analysis: PdfAnalysis): StrategyPlan {
  if (analysis.kind === "scanned") {
    return {
      strategy: "ocr_primary",
      reason: `scanned PDF (${analysis.averageTextPerPage} chars/page) — OCR required to recover content`,
      runNative: true,
      ocrUpfront: true,
    };
  }

  if (analysis.kind === "weak-text") {
    return {
      strategy: "native_then_ocr",
      reason: `mixed document (${analysis.averageTextPerPage} chars/page) — native text plus OCR for the gaps`,
      runNative: true,
      ocrUpfront: true,
    };
  }

  // kind === "digital"
  if (analysis.confidence < NATIVE_MIN_CONFIDENCE) {
    return {
      strategy: "native_then_ocr",
      reason: `digital text layer but low analysis confidence (${analysis.confidence} < ${NATIVE_MIN_CONFIDENCE}) — OCR kept available`,
      runNative: true,
      ocrUpfront: true,
    };
  }

  return {
    strategy: "native",
    reason: `genuine digital text layer (${analysis.averageTextPerPage} chars/page, confidence ${analysis.confidence}) — OCR cannot improve embedded text`,
    runNative: true,
    ocrUpfront: false,
  };
}
