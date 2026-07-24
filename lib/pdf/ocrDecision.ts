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
  pdfplumberChars: number; // chars from the pdfplumber text layer
  nativeTransactions: number; // max transactions parsed natively
  coverage: number; // fraction of pages that have a PDF.js text layer (0..1)
  pageCount: number;
  confidence: number; // analysis confidence 0..100
  skipOcrFastPath: boolean; // >500 chars PDF.js text layer
};

export type OcrDecision = { needsOcr: boolean; reason: string };

// OCR is needed ONLY when neither native extractor (PDF.js nor pdfplumber) recovered
// usable readable text. Using the BEST evidence from both means a genuinely digital
// PDF is never sent to OCR just because PDF.js had a runtime hiccup — while scanned,
// sparse, or corrupt documents (both extractors empty) still OCR.
export function decideOcrNeed(e: OcrEvidence): OcrDecision {
  // 1. Strong PDF.js digital text layer (>500 chars) → never OCR.
  if (e.skipOcrFastPath) return { needsOcr: false, reason: "strong digital text layer (>500 chars)" };

  // 2. Best trustworthy native text from either extractor.
  const best = Math.max(e.pdfjsChars, e.pdfplumberChars);
  if (best < READABLE_MIN_CHARS) {
    // Neither PDF.js nor pdfplumber recovered usable text → genuinely scanned /
    // sparse / corrupt → OCR to recover content.
    return { needsOcr: true, reason: `insufficient native text (best ${best} chars from pdfjs/pdfplumber) — OCR to recover content` };
  }

  // 3. pdfplumber recovered readable text while PDF.js returned ~nothing (a PDF.js
  //    runtime failure): trust pdfplumber — PDF.js-derived coverage is meaningless.
  if (e.pdfjsChars < 20 && e.pdfplumberChars >= READABLE_MIN_CHARS) {
    return { needsOcr: false, reason: `readable text recovered by pdfplumber (${e.pdfplumberChars} chars) — OCR unnecessary` };
  }

  // 4. PDF.js produced readable text: trust it, but require adequate page coverage
  //    so a mostly-scanned multi-page doc with a little text still OCRs.
  if (e.coverage >= READABLE_MIN_COVERAGE) {
    return { needsOcr: false, reason: `readable digital text layer (${best} chars, ${Math.round(e.coverage * 100)}% coverage) — OCR unnecessary` };
  }
  return { needsOcr: true, reason: `low page coverage (${Math.round(e.coverage * 100)}%) — OCR to recover content` };
}
