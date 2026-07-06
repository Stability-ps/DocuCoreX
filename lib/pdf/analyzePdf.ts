import type { ExtractionResult, PdfAnalysis, PdfKind } from "@/lib/pdf/types";
import { extractWithPdfjs } from "@/lib/pdf/extractWithPdfjs";
import { pdfLog } from "@/lib/pdf/log";

const DIGITAL_MIN_CHARS_PER_PAGE = 200;
const WEAK_MIN_CHARS_PER_PAGE = 25;

// Pure classifier from a PDF.js extraction: digital, weak-text or scanned, and
// whether OCR is needed. Testable without a real PDF.
export function analyzeExtraction(pdfjs: ExtractionResult): PdfAnalysis {
  const totalTextLength = pdfjs.combinedText.trim().length;
  const pageCount = Math.max(1, pdfjs.pageCount);
  const averageTextPerPage = Math.round(totalTextLength / pageCount);
  const pages = pdfjs.pages.map((p) => {
    const textLength = (p.text || "").trim().length;
    return { pageNumber: p.pageNumber, textLength, hasText: textLength > WEAK_MIN_CHARS_PER_PAGE };
  });
  const pagesWithText = pages.filter((p) => p.hasText).length;
  const coverage = pages.length ? pagesWithText / pages.length : 0;

  let kind: PdfKind;
  const reasons: string[] = [];
  if (averageTextPerPage >= DIGITAL_MIN_CHARS_PER_PAGE && coverage >= 0.6) {
    kind = "digital";
    reasons.push(`digital text (${averageTextPerPage} chars/page, ${Math.round(coverage * 100)}% pages with text)`);
  } else if (averageTextPerPage >= WEAK_MIN_CHARS_PER_PAGE) {
    kind = "weak-text";
    reasons.push(`sparse text (${averageTextPerPage} chars/page) — likely partial digital text`);
  } else {
    kind = "scanned";
    reasons.push(`little/no extractable text (${averageTextPerPage} chars/page) — likely scanned`);
  }

  const isDigitalPdf = kind === "digital";
  const needsOcr = !isDigitalPdf;
  // Confidence that the extracted digital text is usable (0..100).
  const textDensity = Math.min(1, averageTextPerPage / DIGITAL_MIN_CHARS_PER_PAGE);
  const confidence = Math.max(0, Math.min(100, Math.round((coverage * 0.6 + textDensity * 0.4) * 100)));

  return {
    pageCount,
    totalTextLength,
    averageTextPerPage,
    pages,
    isDigitalPdf,
    kind,
    needsOcr,
    confidence,
    extractedText: pdfjs.combinedText,
    reasons,
    characters: totalTextLength,
    averageCharsPerPage: averageTextPerPage,
  };
}

// Buffer entry point: run PDF.js then classify.
export async function analyzePdf(buffer: Uint8Array): Promise<PdfAnalysis> {
  const pdfjs = await extractWithPdfjs(buffer);
  const analysis = analyzeExtraction(pdfjs);
  pdfLog("analyze", { kind: analysis.kind, needsOcr: analysis.needsOcr, avgChars: analysis.averageCharsPerPage });
  return analysis;
}
