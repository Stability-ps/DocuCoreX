import type { ExtractionPipelineResult, ExtractionResult } from "@/lib/pdf/types";
import { analyzeExtraction } from "@/lib/pdf/analyzePdf";
import { extractWithPdfjs } from "@/lib/pdf/extractWithPdfjs";
import { extractWithPdfplumber } from "@/lib/pdf/extractWithPdfplumber";
import { extractWithOcr } from "@/lib/pdf/extractWithOcr";
import { mergeExtractionResults } from "@/lib/pdf/mergeExtractionResults";
import { validateBankStatement } from "@/lib/accounting/validateBankStatement";
import { scoreExtraction } from "@/lib/pdf/scoreExtraction";
import { pdfLog } from "@/lib/pdf/log";

// The multi-parser pipeline: PDF.js analysis → pdfplumber (digital) → OCR
// (only when needed) → score → merge → validate. Defensive throughout: any
// single extractor failing does not fail the pipeline.
export async function runExtractionPipeline(buffer: Uint8Array, fileName = "statement.pdf"): Promise<ExtractionPipelineResult> {
  pdfLog("start", { fileName, bytes: buffer.byteLength });

  // 1. PDF.js analysis (also gives us the digital text extraction).
  const pdfjs = await extractWithPdfjs(buffer);
  const analysis = analyzeExtraction(pdfjs);

  // 2. pdfplumber on digital/weak PDFs (tables). Skipped for scanned-only.
  const pdfplumber = analysis.kind !== "scanned" ? await extractWithPdfplumber(buffer, fileName) : null;

  // 3. OCR fallback — only when PDF.js flags scanned/weak, OR pdfplumber/PDF.js
  // both returned poor extraction.
  const pdfjsScore = scoreExtraction(pdfjs);
  const plumberScore = pdfplumber ? scoreExtraction(pdfplumber) : null;
  const poorDigital = pdfjsScore.transactionRows === 0 && (plumberScore == null || plumberScore.transactionRows === 0);
  const needsOcr = analysis.needsOcr || poorDigital;
  let ocr: ExtractionResult | null = null;
  if (needsOcr) {
    ocr = await extractWithOcr(buffer, fileName);
  }
  const ocrUsed = Boolean(ocr && (ocr.combinedText.length > 0 || ocr.transactions.length > 0));

  // 4 + 5 + 6. Score, select and merge.
  const { selection, merged } = mergeExtractionResults(analysis, {
    pdfjs,
    pdfplumber: pdfplumber ?? undefined,
    ocr: ocr ?? undefined,
  });

  // 7 + 8. Validate the merged result against the statement's own figures.
  const validation = validateBankStatement(merged);

  const warnings = [...new Set([...selection.warnings, ...merged.warnings, ...analysis.reasons.filter(() => false)])];
  const requiresReview = selection.requiresReview || validation.requiresReview;
  if (validation.requiresReview) warnings.push("Extraction completed but reconciliation needs review.");

  pdfLog("done", {
    selectedParser: selection.selectedParser,
    confidence: selection.confidence,
    ocrUsed,
    valid: validation.valid,
    requiresReview,
  });

  return { analysis, ocrUsed, selection, merged, validation, warnings: [...new Set(warnings)], requiresReview };
}
