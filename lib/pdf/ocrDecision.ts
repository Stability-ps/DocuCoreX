// Evidence-based decision on whether a PDF genuinely needs OCR. Replaces the
// blunt "0 transactions ⇒ OCR" rule that sent clean, short digital PDFs through a
// ~43s OCR round-trip unnecessarily. Pure + fully unit-tested.
//
// Thresholds are intentionally NOT lowered blindly. The decision weighs multiple
// signals: whether the PDF is genuinely scanned, text-layer quality (chars),
// character coverage across pages, and whether a substantial digital text layer
// exists. Transaction count alone never forces OCR when a readable text layer is
// present — a document may simply be short or not a bank statement.
import type { PdfKind } from "@/lib/pdf/types";

// A native text layer with at least this many characters and adequate page
// coverage is treated as genuinely readable digital text (OCR unnecessary).
export const READABLE_MIN_CHARS = 40;
export const READABLE_MIN_COVERAGE = 0.6;

export type OcrEvidence = {
  kind: PdfKind; // digital | weak-text | scanned
  pdfjsChars: number; // chars from the PDF.js text layer
  nativeChars: number; // max chars from pdfjs / pdfplumber
  nativeTransactions: number; // max transactions parsed natively
  coverage: number; // fraction of pages that have a text layer (0..1)
  pageCount: number;
  confidence: number; // analysis confidence 0..100
  scannedFastPath: boolean; // <=20 chars AND classified scanned
  skipOcrFastPath: boolean; // >500 chars digital text layer
};

export type OcrDecision = { needsOcr: boolean; reason: string };

export function decideOcrNeed(e: OcrEvidence): OcrDecision {
  // 1. Genuinely scanned / no text layer → OCR is the only option.
  if (e.scannedFastPath) return { needsOcr: true, reason: "scanned fast path — no usable text layer" };

  // 2. Strong digital text layer (>500 chars) → never OCR.
  if (e.skipOcrFastPath) return { needsOcr: false, reason: "strong digital text layer (>500 chars)" };

  // 3. Evidence check: is the native text layer genuinely readable? A non-scanned
  //    PDF with adequate coverage and a real amount of text is trustworthy even if
  //    zero transactions were parsed (it may simply be short or not a statement).
  const readableTextLayer =
    e.kind !== "scanned" && e.coverage >= READABLE_MIN_COVERAGE && e.nativeChars >= READABLE_MIN_CHARS;
  if (readableTextLayer) {
    return {
      needsOcr: false,
      reason: `readable digital text layer (${e.nativeChars} chars, ${Math.round(e.coverage * 100)}% page coverage) — OCR unnecessary`,
    };
  }

  // 4. Weak/sparse/low-coverage text, or almost no text → OCR to recover content.
  if (e.kind === "scanned" || e.nativeChars < 20 || e.coverage < READABLE_MIN_COVERAGE) {
    return { needsOcr: true, reason: "weak/sparse/low-coverage text layer — OCR to recover content" };
  }

  // 5. Otherwise the native text is adequate.
  return { needsOcr: false, reason: "native extraction sufficient" };
}
