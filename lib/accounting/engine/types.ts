export type BankProfileId =
  | "fnb_business_v1"
  | "standard_bank_business_v1"
  | "absa_business_v1"
  | "nedbank_business_v1"
  | "capitec_business_v1"
  | "investec_business_v1";

export type BankCapability =
  | "ocr_required"
  | "supports_multi_page"
  | "supports_combined_statements"
  | "running_balance_validation"
  | "vat_extraction"
  | "ai_categorisation"
  | "review_mode"
  | "bank_charges_detection";

export type ParserCapabilityMatrix = Record<BankCapability, boolean>;

export type ParserHealth = {
  parserName: BankProfileId;
  version: string;
  lastUpdated: string;
  regressionPassRate: number;
  supportedLayouts: string[];
  knownIssues: string[];
  confidence: number;
  averageExtractionAccuracy: number;
};

export type StatementAnalytics = {
  bank: string;
  statementsProcessed: number;
  successRate: number;
  averageConfidence: number;
  averageProcessingMs: number;
  averageReviewRate: number;
  commonFailures: string[];
};

export type ReviewQueueStatus = "needs_review" | "in_review" | "approved" | "rejected" | "resolved";

export type ReviewQueueItem = {
  transactionId: string;
  runId: string;
  bank: string;
  statementLabel: string;
  transactionDate: string | null;
  description: string;
  accountCategory: string;
  vatTreatment: string;
  confidence: number;
  status: ReviewQueueStatus;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type AccountingActionAuditInput = {
  action: string;
  entityType: string;
  entityId: string;
  previousValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
};
