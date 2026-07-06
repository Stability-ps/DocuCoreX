import type { ExtractionPipelineResult, ExtractionResult, ParserMethod, PdfAnalysis } from "@/lib/pdf/types";
import { analyzeExtraction } from "@/lib/pdf/analyzePdf";
import { extractWithPdfjs } from "@/lib/pdf/extractWithPdfjs";
import { extractWithPdfplumber } from "@/lib/pdf/extractWithPdfplumber";
import { extractWithOcr } from "@/lib/pdf/extractWithOcr";
import { mergeExtractionResults } from "@/lib/pdf/mergeExtractionResults";
import { validateBankStatement } from "@/lib/accounting/validateBankStatement";
import { pdfLog } from "@/lib/pdf/log";

function assemble(
  analysis: PdfAnalysis,
  inputs: { pdfjs?: ExtractionResult; pdfplumber?: ExtractionResult | null; ocr?: ExtractionResult | null },
) {
  const { selection, merged } = mergeExtractionResults(analysis, {
    pdfjs: inputs.pdfjs,
    pdfplumber: inputs.pdfplumber ?? undefined,
    ocr: inputs.ocr ?? undefined,
  });
  const validation = validateBankStatement(merged);
  return { selection, merged, validation };
}

// Multi-parser pipeline with explicit routing:
//   1. Run PDF.js analysis FIRST.
//   2. Digital/strong text  -> native parsers (pdfplumber tables + PDF.js text).
//   3. Scanned/weak text    -> OCR fallback.
//   4. Native parse fails reconciliation -> OCR fallback retry.
//   5. Store the parser method used (pdfjs | pdfplumber | ocr | hybrid).
//   6. Log the parser decision clearly.
// Additive and defensive — a single extractor failing never fails the pipeline.
export async function runExtractionPipeline(buffer: Uint8Array, fileName = "statement.pdf"): Promise<ExtractionPipelineResult> {
  pdfLog("start", { fileName, bytes: buffer.byteLength });

  // 1. PDF.js analysis (also yields the digital text extraction).
  const pdfjs = await extractWithPdfjs(buffer);
  const analysis = analyzeExtraction(pdfjs);
  pdfLog("route.analysis", {
    pageCount: analysis.pageCount,
    totalTextLength: analysis.totalTextLength,
    averageTextPerPage: analysis.averageTextPerPage,
    kind: analysis.kind,
    isDigitalPdf: analysis.isDigitalPdf,
    needsOcr: analysis.needsOcr,
    confidence: analysis.confidence,
  });

  let routeReason: string;
  let pdfplumber: ExtractionResult | null = null;
  let ocr: ExtractionResult | null = null;

  if (analysis.isDigitalPdf) {
    // 2. Digital → native parsers, no OCR.
    routeReason = `Digital PDF (${analysis.averageTextPerPage} chars/page, ${analysis.confidence}% confidence) → native parsers.`;
    pdfplumber = await extractWithPdfplumber(buffer, fileName);
  } else {
    // 3. Scanned / weak text → still try native, then OCR fallback.
    routeReason = `${analysis.kind} PDF (${analysis.confidence}% text confidence) → OCR fallback.`;
    pdfplumber = analysis.kind === "weak-text" ? await extractWithPdfplumber(buffer, fileName) : null;
    ocr = await extractWithOcr(buffer, fileName);
  }

  let assembled = assemble(analysis, { pdfjs, pdfplumber, ocr });

  // 4. Native parse failed reconciliation and OCR has not run yet → OCR retry.
  if (assembled.validation.requiresReview && !ocr) {
    pdfLog("route.ocr_retry", { reason: "reconciliation failed on native parse", difference: assembled.validation.difference });
    ocr = await extractWithOcr(buffer, fileName);
    if (ocr && (ocr.combinedText.length > 0 || ocr.transactions.length > 0)) {
      const retry = assemble(analysis, { pdfjs, pdfplumber, ocr });
      // Keep whichever reconciles (or has higher confidence).
      if (retry.validation.valid || retry.selection.confidence > assembled.selection.confidence) {
        assembled = retry;
        routeReason += " Native parse did not reconcile — OCR fallback used.";
      } else {
        routeReason += " OCR retry did not improve reconciliation.";
      }
    }
  }

  const ocrUsed = Boolean(ocr && (ocr.combinedText.length > 0 || ocr.transactions.length > 0) && assembled.merged.parser !== "pdfjs");

  // Merge log: selected parser, per-parser scores and the reasons for selection.
  pdfLog("route.merge", {
    selectedParser: assembled.selection.selectedParser,
    confidence: assembled.selection.confidence,
    extractionScores: assembled.selection.extractionScores,
    reasons: assembled.selection.reasons,
  });

  // 5. Parser method used.
  const parserMethod: ParserMethod = assembled.selection.selectedParser;

  const warnings = [...new Set([...assembled.selection.warnings, ...assembled.merged.warnings])];
  const requiresReview = assembled.selection.requiresReview || assembled.validation.requiresReview;
  if (assembled.validation.requiresReview) warnings.push("Extraction completed but reconciliation needs review.");

  // 6. Log the parser decision clearly.
  pdfLog("route.decision", {
    parserMethod,
    ocrUsed,
    confidence: assembled.selection.confidence,
    reconciled: assembled.validation.valid,
    requiresReview,
    reason: routeReason,
  });

  return {
    analysis,
    ocrUsed,
    parserMethod,
    routeReason,
    selection: assembled.selection,
    merged: assembled.merged,
    validation: assembled.validation,
    warnings: [...new Set(warnings)],
    requiresReview,
  };
}
