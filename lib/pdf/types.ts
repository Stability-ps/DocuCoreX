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

export type ExtractionResult = {
  parser: "pdfjs" | "pdfplumber" | "ocr" | "hybrid";
  pageCount: number;
  pages: ExtractionPage[];
  combinedText: string;
  transactions: ExtractionTransaction[];
  metadata: ExtractionMetadata;
  warnings: string[];
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
  selectedParser: "pdfjs" | "pdfplumber" | "ocr" | "hybrid";
  confidence: number; // 0..100
  reasons: string[];
  extractionScores: {
    pdfjs?: ExtractionScore;
    pdfplumber?: ExtractionScore;
    ocr?: ExtractionScore;
  };
  warnings: string[];
  requiresReview: boolean;
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
export type ParserMethod = "pdfjs" | "pdfplumber" | "ocr" | "hybrid";

export type ExtractionDebug = {
  pdfjsTextLength: number;
  pdfplumberTextLength: number;
  ocrTextLength: number;
  preExtractedTextLength: number;
  sampleText: string;
  reasonNoTransactions: string | null;
};

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
  debug: ExtractionDebug;
};
