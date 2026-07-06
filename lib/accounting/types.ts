export type AccountingRunStatus = "queued" | "processing" | "review" | "completed" | "failed" | "cancelled";

export type VatTreatment = "standard" | "zero_rated" | "exempt" | "out_of_scope" | "review";

export type AccountingReviewStatus = "needs_review" | "ready" | "approved" | "in_review" | "rejected" | "resolved";

export type AccountingStatementRun = {
  id: string;
  workspaceId: string;
  documentId: string | null;
  processingJobId: string | null;
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
  sourcePage: number | null;
  sourceRow?: number | null;
  reviewComment?: string;
  rawText: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AccountingRunDetail = {
  run: AccountingStatementRun;
  transactions: AccountingTransaction[];
};

export type AccountingTransactionPatch = Partial<
  Pick<AccountingTransaction, "accountCategory" | "vatTreatment" | "supportedByInvoice" | "notes" | "reviewStatus">
>;
