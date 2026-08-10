export type AccountingRunStatus = "queued" | "processing" | "review" | "completed" | "failed" | "cancelled";

export type VatTreatment = "standard" | "zero_rated" | "exempt" | "out_of_scope" | "review";

export type AccountingReviewStatus = "needs_review" | "ready" | "approved" | "in_review" | "rejected" | "resolved";

export type AccountingStatementRun = {
  id: string;
  workspaceId: string;
  documentId: string | null;
  processingJobId: string | null;
  activeJobId?: string | null;
  bank: string;
  statementType: string;
  status: AccountingRunStatus;
  companyName: string | null;
  accountNumber: string | null;
  statementPeriodStart: string | null;
  statementPeriodEnd: string | null;
  statementDate?: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  transactionCount: number;
  bankChargesTotal: number;
  sourceStoragePath: string;
  workbookStoragePath: string | null;
  extractionProvider: string;
  parserProfile?: string;
  parserVersion?: string;
  reviewRequired?: boolean;
  reviewReason?: string | null;
  processingDurationMs?: number | null;
  extractionAccuracy?: number | null;
  // Multi-parser extraction pipeline metadata (migration 013).
  parserMethod?: string | null;
  extractionConfidence?: number | null;
  detectedPdfType?: string | null;
  ocrUsed?: boolean | null;
  routeReason?: string | null;
  extractionWarnings?: string[] | null;
  validationStatus?: string | null;
  reconciliationDifference?: number | null;
  missingTransactionCount?: number | null;
  requiresReview?: boolean | null;
  // Live processing step + start time (migration 014) for the UI stepper.
  processingStep?: string | null;
  processingStartedAt?: string | null;
  // Full parser/OCR debug blob (migration 015) — shown on failed runs so the
  // real reason + OCR diagnostics are visible, not just "Failed 0%".
  parserDebug?: Record<string, unknown> | null;
  // The three confidence metrics, kept separate. Null means "not measured",
  // which is honest for runs predating migration 019 — 0 would be a lie.
  confidences: {
    /** How accurately the document was extracted. */
    extraction: number | null;
    /** How confidently transactions were categorised. */
    classification: number | null;
    /** How reliable the reconstructed statement is. */
    reconciliation: number | null;
  };
  /**
   * @deprecated Carries the CLASSIFICATION score for backwards compatibility
   * only. Read `confidences.classification`. Never an average of the three.
   */
  confidence: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AccountingTransaction = {
  id: string;
  runId: string;
  workspaceId: string;
  transactionDate: string | null;
  description: string;
  debitAmount: number | null;
  creditAmount: number | null;
  runningBalance: number | null;
  bankCharge: boolean;
  accountCategory: string;
  vatTreatment: VatTreatment;
  supportedByInvoice: boolean;
  notes: string;
  confidence: number;
  reviewStatus: AccountingReviewStatus;
  /**
   * Where the category came from, and how sure that decision is — recorded by
   * the worker (migration 021), not inferred. Null on rows written before
   * provenance existed, which is honest: we do not know who classified them.
   *
   * `classificationConfidence` is deliberately not `confidence`. A row can be
   * extracted perfectly and still be hard to categorise, and for an AI-recovered
   * row `confidence` is capped as an EXTRACTION signal that classification must
   * not raise.
   */
  classificationSource: ClassificationSourceValue | null;
  classificationStrength: string | null;
  classificationConfidence: number | null;
  classificationReason: string | null;
  /** Merchant behind the bank's wording. `description` stays bank evidence. */
  normalizedMerchant: string | null;
  sourcePage: number | null;
  sourceRow?: number | null;
  reviewComment?: string;
  rawText: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Who classified a transaction. Matches the worker's vocabulary. */
export type ClassificationSourceValue =
  | "deterministic"
  | "learned_rule"
  | "ai"
  | "manual"
  | "unresolved";

export type AccountingRunDetail = {
  run: AccountingStatementRun;
  transactions: AccountingTransaction[];
};

export type AccountingTransactionPatch = Partial<
  Pick<AccountingTransaction, "accountCategory" | "vatTreatment" | "supportedByInvoice" | "notes" | "reviewStatus">
>;
