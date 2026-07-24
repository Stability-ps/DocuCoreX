// Pure decision: given how a PDF was analysed and which OCR engine was selected,
// determine which extraction method actually performs the work. Drives the
// benchmark's "which engine was used" column and the runtime routing.

import type { PdfKind } from "@/lib/pdf/types";
import type { OcrEngine } from "@/lib/providers/selection";

export type ExtractionMethod = "pdfjs" | "pdfplumber" | OcrEngine;

export type MethodPlan = {
  /** The engine whose output is authoritative for this document. */
  primary: ExtractionMethod;
  /** All methods that run, in order (earlier = tried/collected first). */
  methods: ExtractionMethod[];
  needsOcr: boolean;
};

/**
 * digital     → PDF.js + pdfplumber text (no OCR)
 * weak-text   → PDF.js + pdfplumber, then OCR (selected engine) as a fallback
 * scanned     → OCR only (selected engine); Tesseract is the fallback engine
 */
export function planExtractionMethod(kind: PdfKind, ocr: OcrEngine): MethodPlan {
  if (kind === "digital") {
    return { primary: "pdfjs", methods: ["pdfjs", "pdfplumber"], needsOcr: false };
  }
  if (kind === "weak-text") {
    return { primary: "pdfplumber", methods: ["pdfjs", "pdfplumber", ocr], needsOcr: true };
  }
  // scanned
  return { primary: ocr, methods: [ocr], needsOcr: true };
}

/**
 * Tesseract fallback: if the primary OCR engine (e.g. OpenAI vision) fails or is
 * unavailable at runtime, fall back to Tesseract when it is reachable.
 */
export function ocrFallback(primary: OcrEngine, tesseractAvailable: boolean): OcrEngine | null {
  if (primary === "tesseract") return null;
  return tesseractAvailable ? "tesseract" : null;
}
