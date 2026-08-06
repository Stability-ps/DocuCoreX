import type {
  AcceptanceVerdict,
  ExtractionMetadata,
  ExtractionPipelineResult,
  ExtractionStrategy,
  OcrEngineComparison,
  OcrEngineId,
  ParserMethod,
  PdfKind,
  StructuredRow,
} from "@/lib/pdf/types";

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
  extractionFormatVersion?: number;
  preExtractedRows?: StructuredRow[];
  structuredProvider?: ParserMethod;
  // 0..1, copied from StructuredQuality.rowContinuity (not an overall confidence score).
  structuredRowContinuity?: number;
  structuredPageCount?: number;
  structuredRowCount?: number;
  structuredDiagnostics?: Record<string, unknown>;
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
  // Which strategy the analysis chose, which OCR engine won, and the head-to-head
  // record when more than one engine ran.
  strategy: ExtractionStrategy;
  ocrEngine: OcrEngineId | null;
  ocrEngineComparison: OcrEngineComparison[];
  verdict: AcceptanceVerdict;
};

// Requirement 2: pdfjs/pdfplumber → pass extracted text/tables/transactions;
// ocr/hybrid → pass OCR-enhanced text/result. In every case we hand the worker
// the merged combinedText (best available source), and it keeps the original PDF
// as a fallback when the provided text is too thin to trust.
export function buildWorkerInput(result: ExtractionPipelineResult): WorkerExtractionInput {
  const text = result.merged?.combinedText ?? "";
  const transactions = result.merged?.transactions ?? [];
  const structured = result.merged?.structured;
  const structuredRows = structured?.rows ?? [];
  // Send the extracted text whenever there is a non-trivial amount of it; the
  // worker makes the final call (it compares against its own native extraction),
  // so we don't over-gate here on confidence.
  const useProvidedText = text.trim().length >= 50;
  const input: WorkerExtractionInput = {
    parser: result.parserMethod,
    useProvidedText,
    preExtractedText: text,
    transactionCandidateCount: transactions.length,
    metadata: result.merged?.metadata ?? {},
    ocrUsed: Boolean(result.ocrUsed),
  };
  if (structuredRows.length > 0) {
    input.extractionFormatVersion = 2;
    input.preExtractedRows = structuredRows;
    input.structuredProvider = result.merged?.parser ?? result.parserMethod;
    input.structuredRowContinuity = structured?.quality?.rowContinuity ?? 0;
    input.structuredPageCount = structured?.pageMeta?.length ?? 0;
    input.structuredRowCount = structuredRows.length;
    input.structuredDiagnostics = {
      tableCount: structured?.quality?.tableCount ?? 0,
      transactionTableCount: structured?.quality?.transactionTableCount ?? 0,
      rowContinuity: structured?.quality?.rowContinuity ?? 0,
      resolvedRoles: structured?.quality?.resolvedRoles ?? [],
      joinedRowCount: structured?.quality?.joinedRowCount ?? 0,
      droppedFurnitureCount: structured?.quality?.droppedFurnitureCount ?? 0,
    };
  }
  return input;
}

// Requirement 4: the metadata persisted with the run and surfaced in the UI.
export function extractionProcessingMetadata(result: ExtractionPipelineResult): ProcessingExtractionMetadata {
  return {
    selectedParser: result.parserMethod,
    extractionConfidence: result.selection?.confidence ?? 0,
    ocrUsed: Boolean(result.ocrUsed),
    detectedPdfType: result.analysis?.kind ?? "scanned",
    // "valid" reflects reconciliation alone; the overall acceptance verdict
    // (which also covers completeness and cross-engine agreement) is carried
    // separately in `verdict` and must not be collapsed into this field.
    validationStatus: result.validation?.valid ? "valid" : "review_required",
    warnings: result.warnings ?? [],
    reconciliationDifference: result.validation?.difference ?? null,
    missingTransactionCount: result.validation?.missingTransactionCount ?? null,
    strategy: result.strategy ?? "native",
    ocrEngine: result.ocrEngine ?? null,
    ocrEngineComparison: result.ocrEngineComparison ?? [],
    verdict: result.verdict ?? "review_required",
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
    case "mistral_ocr":
      return "Processed with Mistral OCR";
    case "azure_di":
      return "Processed with Azure Document Intelligence";
    case "hybrid":
      return "Processed with hybrid extraction";
    default:
      return "Processed";
  }
}
