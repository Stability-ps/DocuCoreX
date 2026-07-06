import type { ExtractionMetadata, ExtractionPipelineResult, ParserMethod, PdfKind } from "@/lib/pdf/types";

// Turn a pipeline result into the input the accounting worker should receive, and
// into the processing metadata stored on the run / shown on the review page.

export type WorkerExtractionInput = {
  parser: ParserMethod;
  // Whether the worker should use the provided text instead of re-parsing the PDF.
  // The original PDF is always kept as a fallback (via storagePath).
  useProvidedText: boolean;
  preExtractedText: string;
  transactionCandidateCount: number;
  metadata: ExtractionMetadata;
  ocrUsed: boolean;
};

export type ProcessingExtractionMetadata = {
  selectedParser: ParserMethod;
  extractionConfidence: number;
  ocrUsed: boolean;
  detectedPdfType: PdfKind;
  validationStatus: "valid" | "review_required";
  warnings: string[];
  reconciliationDifference: number | null;
  missingTransactionCount: number | null;
};

// Requirement 2: pdfjs/pdfplumber → pass extracted text/tables/transactions;
// ocr/hybrid → pass OCR-enhanced text/result. In every case we hand the worker
// the merged combinedText (best available source), and it keeps the original PDF
// as a fallback when the provided text is too thin to trust.
export function buildWorkerInput(result: ExtractionPipelineResult): WorkerExtractionInput {
  const text = result.merged?.combinedText ?? "";
  const transactions = result.merged?.transactions ?? [];
  // Only trust the provided text when there is a meaningful amount of it.
  const useProvidedText = text.trim().length >= 200 && result.selection.confidence >= 40;
  return {
    parser: result.parserMethod,
    useProvidedText,
    preExtractedText: text,
    transactionCandidateCount: transactions.length,
    metadata: result.merged?.metadata ?? {},
    ocrUsed: Boolean(result.ocrUsed),
  };
}

// Requirement 4: the metadata persisted with the run and surfaced in the UI.
export function extractionProcessingMetadata(result: ExtractionPipelineResult): ProcessingExtractionMetadata {
  return {
    selectedParser: result.parserMethod,
    extractionConfidence: result.selection?.confidence ?? 0,
    ocrUsed: Boolean(result.ocrUsed),
    detectedPdfType: result.analysis?.kind ?? "scanned",
    validationStatus: result.validation?.valid ? "valid" : "review_required",
    warnings: result.warnings ?? [],
    reconciliationDifference: result.validation?.difference ?? null,
    missingTransactionCount: result.validation?.missingTransactionCount ?? null,
  };
}

// Human-readable "Processed with …" label for the review UI.
export function parserMethodLabel(method: string | null | undefined): string {
  switch (method) {
    case "pdfjs":
      return "Processed with PDF.js";
    case "pdfplumber":
      return "Processed with pdfplumber";
    case "ocr":
      return "Processed with OCR";
    case "hybrid":
      return "Processed with hybrid extraction";
    default:
      return "Processed";
  }
}
