// Normalized shape every extractor produces, so the scoring / merge / validation
// layers are parser-agnostic.

export type ExtractionWord = { text: string; x?: number; y?: number; width?: number; height?: number };
export type ExtractionTable = { rows: string[][] };
export type ExtractionLine = { x0?: number; y0?: number; x1?: number; y1?: number };

export type ExtractionPage = {
  pageNumber: number;
  text: string;
  words: ExtractionWord[];
  tables: ExtractionTable[];
  lines: ExtractionLine[];
};

// OCR engines. "ocr" is the historical id for the primary OCRmyPDF/Tesseract
// engine and is kept verbatim so persisted parser_method values stay readable.
export type OcrEngineId = "tesseract" | "mistral_ocr" | "azure_di";

export type ExtractionResult = {
  parser: "pdfjs" | "pdfplumber" | "ocr" | "mistral_ocr" | "azure_di" | "hybrid";
  pageCount: number;
  pages: ExtractionPage[];
  combinedText: string;
  transactions: ExtractionTransaction[];
  metadata: ExtractionMetadata;
  warnings: string[];
  // Engine-reported confidence (0..100) for OCR results, and where it came from
  // ("tesseract-tsv" | "heuristic" | "mistral-page"). Native parsers leave these
  // undefined — a text layer has no OCR confidence. NEVER sufficient on its own
  // to call a result validated; see acceptExtraction().
  confidence?: number | null;
  confidenceSource?: string | null;
};

export type ExtractionTransaction = {
  date?: string | null;
  description?: string;
  debit?: number | null;
  credit?: number | null;
  balance?: number | null;
  raw?: string;
};

export type ExtractionMetadata = {
  company?: string | null;
  accountNumber?: string | null;
  statementPeriodStart?: string | null;
  statementPeriodEnd?: string | null;
  openingBalance?: number | null;
  closingBalance?: number | null;
  declaredCreditTotal?: number | null;
  declaredDebitTotal?: number | null;
  declaredCreditCount?: number | null;
  declaredDebitCount?: number | null;
  [key: string]: unknown;
};

// PDF.js analysis outcome — drives whether OCR is needed.
export type PdfKind = "digital" | "weak-text" | "scanned";

export type PdfPageSummary = { pageNumber: number; textLength: number; hasText: boolean };

export type PdfAnalysis = {
  pageCount: number;
  totalTextLength: number;
  averageTextPerPage: number;
  pages: PdfPageSummary[];
  isDigitalPdf: boolean;
  kind: PdfKind;
  needsOcr: boolean;
  confidence: number; // 0..100 that the digital text is usable
  extractedText: string;
  reasons: string[];
  // Back-compat aliases (older callers).
  characters: number;
  averageCharsPerPage: number;
};

// Per-extraction quality score.
export type ExtractionScore = {
  dates: number;
  amounts: number;
  tableRows: number;
  transactionRows: number;
  openingBalanceFound: boolean;
  closingBalanceFound: boolean;
  debitTotalFound: boolean;
  creditTotalFound: boolean;
  runningBalanceConsistent: boolean;
  pageCoverage: number; // 0..1
  score: number; // 0..100
};

// The parser-selection / merge decision (step 5 of the spec).
export type ParserSelection = {
  selectedParser: "pdfjs" | "pdfplumber" | "ocr" | "mistral_ocr" | "azure_di" | "hybrid";
  confidence: number; // 0..100
  reasons: string[];
  extractionScores: {
    pdfjs?: ExtractionScore;
    pdfplumber?: ExtractionScore;
    ocr?: ExtractionScore;
    mistral_ocr?: ExtractionScore;
    azure_di?: ExtractionScore;
  };
  warnings: string[];
  requiresReview: boolean;
  // Material cross-engine disagreements (dates, amounts, balances, transaction
  // rows). Never suppressed — any entry forces review so the conflict is visible
  // rather than silently resolved in favour of the higher-scoring engine.
  disagreements: ExtractionDisagreement[];
};

// A concrete, human-readable conflict between two extraction sources.
export type ExtractionDisagreement = {
  field: "transactionCount" | "closingBalance" | "openingBalance" | "dateRange" | "amountTotals";
  sources: string[]; // parser keys that disagreed
  values: string[]; // stringified values, aligned with `sources`
  detail: string;
};

// Bank-statement validation result.
export type BankStatementCheck = {
  rule: string;
  ok: boolean;
  extracted: string | number | null;
  expected: string | number | null;
  detail: string;
};

export type BankStatementValidation = {
  valid: boolean;
  requiresReview: boolean;
  checks: BankStatementCheck[];
  expectedClosingBalance: number | null;
  calculatedClosingBalance: number | null;
  difference: number | null;
  missingTransactionCount: number | null;
};

// The full pipeline output surfaced to the API / UI.
export type ParserMethod = "pdfjs" | "pdfplumber" | "ocr" | "mistral_ocr" | "azure_di" | "hybrid";

// Per-extractor diagnostics — which stage ran, succeeded, and why others failed.
export type ExtractionStageDiag = {
  stage: "pdfjs" | "pdfplumber" | "ocr" | "mistral_ocr" | "azure_di";
  attempted: boolean;
  ok: boolean; // produced usable text/transactions
  ms: number;
  pages: number;
  chars: number;
  transactions: number;
  skippedReason?: string | null;
  failureReason?: string | null;
};

export type ExtractionDebug = {
  pdfjsTextLength: number;
  pdfplumberTextLength: number;
  ocrTextLength: number;
  // Text recovered by the secondary Mistral OCR engine (0 when it never ran).
  mistralTextLength: number;
  // Text recovered by Azure Document Intelligence (0 when it never ran).
  azureTextLength: number;
  preExtractedTextLength: number;
  sampleText: string;
  reasonNoTransactions: string | null;
  // OCR engine diagnostics (ocr_endpoint, ocr_status, ocr_exit_code,
  // ocr_stderr_sample, sidecar_exists, sidecar_size, ocr_text_length, attempts).
  ocr: Record<string, unknown> | null;
  // Same, for the Mistral engine (endpoint, status, model, pages_processed).
  mistral: Record<string, unknown> | null;
  // Azure diagnostics (provider, model, pages, tables, paragraphs, words,
  // confidence, duration_ms, status).
  azure: Record<string, unknown> | null;
  // Which strategy the analysis selected, and which OCR engine (if any) won.
  strategy: ExtractionStrategy;
  ocrEngine: OcrEngineId | null;
  // One entry per extractor: pdfjs, pdfplumber, ocr, mistral_ocr.
  stages: ExtractionStageDiag[];
};

// How the document is to be extracted, chosen from the analysis before any
// extractor runs. Native is preferred for genuine digital PDFs — OCR cannot
// improve correctly embedded text.
export type ExtractionStrategy = "native" | "native_then_ocr" | "ocr_primary";

// Per-engine comparison record, persisted so the winner is auditable.
export type OcrEngineComparison = {
  engine: OcrEngineId;
  score: number; // scoreExtraction 0..100
  confidence: number | null; // engine-reported, may be null
  chars: number;
  transactions: number;
  won: boolean;
};

// Overall acceptance verdict. "validated" requires EVERY check to pass:
// extraction produced content, reconciliation balanced, required fields present,
// and no material cross-engine disagreement. OCR confidence alone never earns it.
export type AcceptanceVerdict = "validated" | "review_required" | "failed";

export type ExtractionPipelineResult = {
  analysis: PdfAnalysis;
  ocrUsed: boolean;
  parserMethod: ParserMethod;
  routeReason: string;
  selection: ParserSelection;
  merged: ExtractionResult;
  validation: BankStatementValidation | null;
  warnings: string[];
  requiresReview: boolean;
  // Strategy chosen from the analysis, before any extractor ran.
  strategy: ExtractionStrategy;
  // The OCR engine whose output was actually selected, or null when the result
  // came from native extraction only.
  ocrEngine: OcrEngineId | null;
  // Head-to-head record when more than one OCR engine ran.
  ocrEngineComparison: OcrEngineComparison[];
  // Whether this result came from an Enhanced OCR run. The cache uses this so a
  // standard result can never satisfy an Enhanced request — enumerating which
  // providers happened to run is fragile, and adding a provider silently broke
  // that guard once already.
  enhanced: boolean;
  // The single acceptance verdict — see AcceptanceVerdict.
  verdict: AcceptanceVerdict;
  accepted: boolean; // verdict === "validated"
  debug: ExtractionDebug;
  // True when this result was served from the extraction cache (document_id +
  // file_hash) rather than freshly extracted — the expensive OCR/parse was reused.
  cached?: boolean;
};
