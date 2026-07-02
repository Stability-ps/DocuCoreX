import { documents } from "@/lib/product-data";
import type {
  AiInsight,
  DocumentComment,
  DocumentDownload,
  DocumentRecord,
  DocumentVersion,
  ExtractionResult,
  InvoiceItemRecord,
  InvoiceRecord,
  OcrResult,
  ProcessingJob,
} from "@/lib/types";

const now = new Date().toISOString();

type MockStore = {
  documentRecords: DocumentRecord[];
  documentVersions: DocumentVersion[];
  processingJobs: ProcessingJob[];
  ocrResults: OcrResult[];
  extractionResults: ExtractionResult[];
  apiKeys: Array<Record<string, string | null>>;
  auditLogs: Array<Record<string, unknown>>;
  documentComments: DocumentComment[];
  documentDownloads: DocumentDownload[];
  aiInsights: AiInsight[];
  invoices: InvoiceRecord[];
  invoiceItems: InvoiceItemRecord[];
  invoiceSequences: Record<string, number>;
  usageSummary: {
    periodStart: string;
    periodEnd: string;
    documentsUploaded: number;
    pagesProcessed: number;
    ocrCreditsUsed: number;
    ocrCreditsRemaining: number;
    storageBytes: number;
    exportsCreated: number;
  };
};

const globalMockStore = globalThis as typeof globalThis & { __docucorexMockStore?: MockStore };

const seedDocumentRecords: DocumentRecord[] = documents.map((doc) => ({
  id: doc.id,
  workspaceId: "workspace_demo",
  ownerId: "user_demo",
  name: doc.name,
  mimeType: doc.name.endsWith(".zip") ? "application/zip" : "application/pdf",
  sizeBytes: Number.parseFloat(doc.size) * 1024 * 1024,
  pageCount: doc.pages,
  status: doc.status === "Ready" ? "ready" : doc.status === "Review" ? "review" : doc.status === "Processing" ? "processing" : "queued",
  detectedType:
    doc.type === "Bank statement"
      ? "bank_statement"
      : doc.type === "Invoices"
        ? "invoice"
        : doc.type === "Receipts"
          ? "receipt"
          : doc.type === "Financial statements"
            ? "financial_statement"
            : "unknown",
  storagePath: `workspace_demo/documents/${doc.id}/${doc.name}`,
  tags: doc.tags,
  starred: doc.tags.includes("Board"),
  shared: doc.tags.includes("Audit"),
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
}));

const seedDocumentVersions: DocumentVersion[] = [
  {
    id: "version_statement_q2_3",
    documentId: "statement-q2",
    versionNumber: 3,
    storagePath: "workspace_demo/documents/statement-q2/Business Statement Q2.pdf",
    changeNote: "Exports regenerated after OCR confidence review",
    createdBy: "Patric",
    createdAt: now,
  },
  {
    id: "version_statement_q2_2",
    documentId: "statement-q2",
    versionNumber: 2,
    storagePath: "workspace_demo/documents/statement-q2/Business Statement Q2 - OCR.pdf",
    changeNote: "OCR text layer generated",
    createdBy: "System",
    createdAt: now,
  },
  {
    id: "version_statement_q2_1",
    documentId: "statement-q2",
    versionNumber: 1,
    storagePath: "workspace_demo/documents/statement-q2/original.pdf",
    changeNote: "Original upload",
    createdBy: "Patric",
    createdAt: now,
  },
];

const seedProcessingJobs: ProcessingJob[] = [
  {
    id: "job_ocr_statement_q2",
    documentId: "statement-q2",
    type: "ocr",
    status: "completed",
    progress: 100,
    message: "OCR text layer generated",
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "job_extract_statement_q2",
    documentId: "statement-q2",
    type: "extraction",
    status: "completed",
    progress: 100,
    message: "Transactions and VAT tags extracted",
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "job_convert_invoice_batch",
    documentId: "invoice-batch",
    type: "conversion",
    status: "running",
    progress: 64,
    message: "Creating Excel workbook",
    createdAt: now,
    updatedAt: now,
  },
];

const seedOcrResults: OcrResult[] = [
  {
    id: "ocr_statement_q2",
    documentId: "statement-q2",
    language: "en",
    confidence: 98.7,
    text: [
      "Statement period: 01 Apr 2026 - 30 Jun 2026",
      "Opening balance: R 184,221.09",
      "Total money in: R 1,402,880.50",
      "Total money out: R 1,118,320.30",
      "Potential duplicate payments: 4",
      "VAT tagged transactions: 312",
    ].join("\n"),
    layoutStatus: "complete",
    createdAt: now,
  },
];

const seedExtractionResults: ExtractionResult[] = [
  {
    id: "extract_statement_q2",
    documentId: "statement-q2",
    detectedType: "bank_statement",
    confidence: 98.7,
    fields: {
      accountHolder: "Demo Business Account",
      statementPeriod: "2026-04-01 to 2026-06-30",
      openingBalance: 184221.09,
      closingBalance: 468781.29,
      totalMoneyIn: 1402880.5,
      totalMoneyOut: 1118320.3,
      duplicateCandidates: 4,
      vatTransactions: 312,
    },
    lineItems: [
      { date: "2026-06-10", description: "Supplier payment 1000", debit: 1280, credit: null, balance: 468781.29 },
      { date: "2026-06-11", description: "Client deposit", debit: null, credit: 42000, balance: 510781.29 },
      { date: "2026-06-12", description: "Software subscription", debit: 1899, credit: null, balance: 508882.29 },
    ],
    createdAt: now,
  },
];

const seedApiKeys = [
  {
    id: "api_key_demo",
    name: "Production API",
    lastFour: "9X2A",
    lastUsedAt: "2026-06-27T07:42:00.000Z",
    createdAt: now,
    revokedAt: null,
  },
  {
    id: "api_key_webhooks",
    name: "Webhook worker",
    lastFour: "F7K1",
    lastUsedAt: null,
    createdAt: now,
    revokedAt: null,
  },
];

const seedAuditLogs = [
  {
    id: "audit_upload",
    actor: "Patric",
    action: "document.uploaded",
    entityType: "document",
    entityId: "statement-q2",
    metadata: { fileName: "Business Statement Q2.pdf" },
    createdAt: now,
  },
  {
    id: "audit_extract",
    actor: "System",
    action: "extraction.completed",
    entityType: "document",
    entityId: "statement-q2",
    metadata: { confidence: 98.7 },
    createdAt: now,
  },
  {
    id: "audit_export",
    actor: "Patric",
    action: "export.created",
    entityType: "conversion",
    entityId: "conversion_demo",
    metadata: { format: "xlsx" },
    createdAt: now,
  },
];

const seedUsageSummary = {
  periodStart: "2026-06-01",
  periodEnd: "2026-06-30",
  documentsUploaded: 1284,
  pagesProcessed: 48930,
  ocrCreditsUsed: 13600,
  ocrCreditsRemaining: 86400,
  storageBytes: 2.8 * 1024 * 1024 * 1024 * 1024,
  exportsCreated: 9718,
};

const seedDocumentComments: DocumentComment[] = [
  {
    id: "comment_vat_review",
    documentId: "statement-q2",
    authorName: "Mia",
    body: "Please verify the VAT treatment on the highlighted supplier payments.",
    createdAt: now,
  },
  {
    id: "comment_duplicate",
    documentId: "statement-q2",
    authorName: "Jon",
    body: "Duplicate transfer detected on page 14. Marked for reconciliation.",
    createdAt: now,
  },
  {
    id: "comment_export",
    documentId: "statement-q2",
    authorName: "Lerato",
    body: "Exported clean CSV for the accounting import.",
    createdAt: now,
  },
];

const seedDocumentDownloads: DocumentDownload[] = [
  {
    id: "download_xlsx_statement_q2",
    documentId: "statement-q2",
    label: "Excel workbook",
    format: "xlsx",
    status: "ready",
    href: "/api/download-file/download_xlsx_statement_q2",
    createdAt: now,
  },
  {
    id: "download_json_statement_q2",
    documentId: "statement-q2",
    label: "JSON payload",
    format: "json",
    status: "ready",
    href: "/api/download-file/download_json_statement_q2",
    createdAt: now,
  },
  {
    id: "download_ocr_statement_q2",
    documentId: "statement-q2",
    label: "OCR text file",
    format: "txt",
    status: "ready",
    href: "/api/download-file/download_ocr_statement_q2",
    createdAt: now,
  },
];

const seedAiInsights: AiInsight[] = [
  {
    id: "ai_duplicates_statement_q2",
    documentId: "statement-q2",
    prompt: "Find duplicate payments.",
    answer:
      "Four duplicate payment candidates were found across suppliers, with two matching invoice references and two recurring subscription patterns that should be reviewed before export.",
    confidence: 94,
    createdAt: now,
  },
  {
    id: "ai_cashflow_statement_q2",
    documentId: "statement-q2",
    prompt: "Generate monthly cash flow.",
    answer:
      "Cash flow is positive for the quarter. June has the highest net inflow, while recurring software and loan fees account for the largest predictable monthly deductions.",
    confidence: 91,
    createdAt: now,
  },
];

const seedInvoices: InvoiceRecord[] = [
  {
    id: "invoice_demo_1",
    workspaceId: "workspace_demo",
    invoiceNumber: "INV-000001",
    sequenceNumber: 1,
    title: "Document processing services",
    description: "OCR, extraction and conversion services for business documents.",
    status: "issued",
    currency: "ZAR",
    invoiceDate: now.slice(0, 10),
    dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    paymentTerms: "14_days",
    referenceNumber: "DOCU-001",
    internalNotes: null,
    clientName: "Allianz Holdings (Pty) Ltd",
    clientCompanyName: "Allianz Holdings (Pty) Ltd",
    clientContactPerson: "Accounts Payable",
    clientEmail: "accounts@example.com",
    clientPhone: "+27 10 000 0000",
    clientAddress: "Waterfall Office Park, Midrand, South Africa",
    clientPostalAddress: null,
    clientVatNumber: "4210102051",
    clientRegistrationNumber: null,
    attentionTo: "Finance team",
    purchaseOrderNumber: "PO-2026-0004",
    clientReference: "INV-2026-0004",
    issuerName: "DocuCoreX",
    issuerTradingName: null,
    issuerEmail: "billing@docucorex.com",
    issuerPhone: "+27 10 500 0000",
    issuerWebsite: "www.docucorex.com",
    issuerAddress: "Cape Town, South Africa",
    issuerPostalAddress: null,
    issuerVatNumber: "4980299999",
    issuerRegistrationNumber: "2026/000000/07",
    logoDataUrl: null,
    bankName: "First National Bank",
    bankAccountHolder: "DocuCoreX",
    bankAccountNumber: "62812345678",
    bankBranchCode: "250655",
    bankSwift: "FIRNZAJJ",
    paymentReference: "INV-000001",
    paymentInstructions: "Please use the invoice number as payment reference.",
    bankDetails: null,
    notesToClient: "Thank you for your business. Please contact billing@docucorex.com if any invoice details need to be updated.",
    termsAndConditions: "Payment is due within 14 days of invoice date. Late payments may pause document processing access until the account is settled.",
    subtotal: 4200,
    discountAmount: 0,
    shippingAmount: 0,
    additionalCharges: 0,
    taxRate: 15,
    taxAmount: 630,
    totalAmount: 4830,
    amountPaid: 0,
    createdBy: "user_demo",
    sentAt: null,
    paidAt: null,
    overdueAt: null,
    cancelledAt: null,
    createdAt: now,
    updatedAt: now,
  },
];

const seedInvoiceItems: InvoiceItemRecord[] = [
  {
    id: "invoice_item_demo_1",
    invoiceId: "invoice_demo_1",
    serviceItem: "Bank statement OCR and extraction",
    quantity: 3,
    unitPrice: 1000,
    lineTotal: 3000,
    vatType: "standard",
    vatRate: 15,
    position: 0,
    createdAt: now,
  },
  {
    id: "invoice_item_demo_2",
    invoiceId: "invoice_demo_1",
    serviceItem: "Excel workbook export",
    quantity: 4,
    unitPrice: 250,
    lineTotal: 1000,
    vatType: "standard",
    vatRate: 15,
    position: 1,
    createdAt: now,
  },
  {
    id: "invoice_item_demo_3",
    invoiceId: "invoice_demo_1",
    serviceItem: "Secure storage and audit trail",
    quantity: 1,
    unitPrice: 200,
    lineTotal: 200,
    vatType: "standard",
    vatRate: 15,
    position: 2,
    createdAt: now,
  },
];

const store =
  globalMockStore.__docucorexMockStore ??
  (globalMockStore.__docucorexMockStore = {
    documentRecords: [...seedDocumentRecords],
    documentVersions: [...seedDocumentVersions],
    processingJobs: [...seedProcessingJobs],
    ocrResults: [...seedOcrResults],
    extractionResults: [...seedExtractionResults],
    apiKeys: [...seedApiKeys],
    auditLogs: [...seedAuditLogs],
    documentComments: [...seedDocumentComments],
    documentDownloads: [...seedDocumentDownloads],
    aiInsights: [...seedAiInsights],
    invoices: [...seedInvoices],
    invoiceItems: [...seedInvoiceItems],
    invoiceSequences: { workspace_demo: 2 },
    usageSummary: { ...seedUsageSummary },
  });

export const documentRecords = store.documentRecords;
export const documentVersions = store.documentVersions;
export const processingJobs = store.processingJobs;
export const ocrResults = store.ocrResults;
export const extractionResults = store.extractionResults;
export const apiKeys = store.apiKeys;
export const auditLogs = store.auditLogs;
export const documentComments = store.documentComments;
export const documentDownloads = store.documentDownloads;
export const aiInsights = store.aiInsights;
export const invoices = store.invoices;
export const invoiceItems = store.invoiceItems;
export const invoiceSequences = store.invoiceSequences;
export const usageSummary = store.usageSummary;

export function getDocument(id: string) {
  return documentRecords.find((document) => document.id === id);
}

export function updateDocument(
  id: string,
  patch: Partial<Pick<DocumentRecord, "name" | "starred" | "shared" | "tags" | "status" | "deletedAt" | "folderId">>,
) {
  const document = getDocument(id);

  if (!document) {
    return null;
  }

  Object.assign(document, patch, { updatedAt: new Date().toISOString() });
  return document;
}

export function deleteDocumentRecord(id: string) {
  const index = documentRecords.findIndex((document) => document.id === id);

  if (index === -1) {
    return false;
  }

  documentRecords.splice(index, 1);
  return true;
}

export function getDocumentVersions(documentId: string) {
  return documentVersions.filter((version) => version.documentId === documentId);
}

export function createProcessingJob(documentId: string, type: ProcessingJob["type"], message: string): ProcessingJob {
  return {
    id: `job_${type}_${Date.now()}`,
    documentId,
    type,
    status: "queued",
    progress: 0,
    message,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function getDocumentComments(documentId: string) {
  return documentComments.filter((comment) => comment.documentId === documentId);
}

export function createDocumentComment(documentId: string, body: string, authorName = "Patric"): DocumentComment {
  const comment = {
    id: `comment_${Date.now()}`,
    documentId,
    authorName,
    body,
    createdAt: new Date().toISOString(),
  };

  documentComments.unshift(comment);
  return comment;
}

export function getDocumentDownloads(documentId: string) {
  return documentDownloads.filter((download) => download.documentId === documentId);
}

export function getAiInsights(documentId: string) {
  return aiInsights.filter((insight) => insight.documentId === documentId);
}

export function answerAiPrompt(documentId: string, prompt: string): AiInsight {
  const normalizedPrompt = prompt.toLowerCase();
  const known = getAiInsights(documentId).find((insight) => normalizedPrompt.includes(insight.prompt.toLowerCase().replace(".", "")));

  if (known) {
    return known;
  }

  const insight = {
    id: `ai_${Date.now()}`,
    documentId,
    prompt,
    answer:
      "DocuCoreX reviewed the extracted document data and found finance-relevant signals. The next production step is to connect this endpoint to the model orchestration layer.",
    confidence: 88,
    createdAt: new Date().toISOString(),
  };

  aiInsights.unshift(insight);
  return insight;
}

export function getDownload(downloadId: string) {
  return documentDownloads.find((download) => download.id === downloadId);
}
