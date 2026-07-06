import type { ExtractionResult, PdfAnalysis, PdfKind } from "@/lib/pdf/types";
import { extractWithPdfjs } from "@/lib/pdf/extractWithPdfjs";
import { pdfLog } from "@/lib/pdf/log";

const DIGITAL_MIN_CHARS_PER_PAGE = 200;
const WEAK_MIN_CHARS_PER_PAGE = 25;

// Pure classifier from a PDF.js extraction: digital, weak-text or scanned, and
// whether OCR is needed. Testable without a real PDF.
export function analyzeExtraction(pdfjs: ExtractionResult): PdfAnalysis {
  const characters = pdfjs.combinedText.trim().length;
  const pageCount = Math.max(1, pdfjs.pageCount);
  const averageCharsPerPage = Math.round(characters / pageCount);
  const pagesWithText = pdfjs.pages.filter((p) => (p.text || "").trim().length > WEAK_MIN_CHARS_PER_PAGE).length;
  const coverage = pdfjs.pages.length ? pagesWithText / pdfjs.pages.length : 0;

  let kind: PdfKind;
  const reasons: string[] = [];
  if (averageCharsPerPage >= DIGITAL_MIN_CHARS_PER_PAGE && coverage >= 0.6) {
    kind = "digital";
    reasons.push(`digital text (${averageCharsPerPage} chars/page, ${Math.round(coverage * 100)}% pages with text)`);
  } else if (averageCharsPerPage >= WEAK_MIN_CHARS_PER_PAGE) {
    kind = "weak-text";
    reasons.push(`sparse text (${averageCharsPerPage} chars/page) — likely partial digital text`);
  } else {
    kind = "scanned";
    reasons.push(`little/no extractable text (${averageCharsPerPage} chars/page) — likely scanned`);
  }

  const needsOcr = kind !== "digital";
  return { pageCount, characters, averageCharsPerPage, kind, needsOcr, reasons };
}

// Buffer entry point: run PDF.js then classify.
export async function analyzePdf(buffer: Uint8Array): Promise<PdfAnalysis> {
  const pdfjs = await extractWithPdfjs(buffer);
  const analysis = analyzeExtraction(pdfjs);
  pdfLog("analyze", { kind: analysis.kind, needsOcr: analysis.needsOcr, avgChars: analysis.averageCharsPerPage });
  return analysis;
}
