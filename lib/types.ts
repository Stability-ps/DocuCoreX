export type DocumentStatus = "uploaded" | "queued" | "processing" | "ready" | "review" | "failed" | "archived";

export type DocumentType =
  | "bank_statement"
  | "invoice"
  | "receipt"
  | "financial_statement"
  | "contract"
  | "payslip"
  | "tax_document"
  | "purchase_order"
  | "unknown";

export type DocumentRecord = {
  id: string;
  workspaceId: string;
  ownerId: string;
  folderId?: string | null;
  name: string;
  mimeType: string;
  sizeBytes: number;
  pageCount: number;
  status: DocumentStatus;
  detectedType: DocumentType;
  storagePath: string;
  tags: string[];
  starred?: boolean;
  shared?: boolean;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DocumentVersion = {
  id: string;
  documentId: string;
  versionNumber: number;
  storagePath: string;
  changeNote: string;
  createdBy: string;
  createdAt: string;
};

export type ProcessingJobType = "upload" | "virus_scan" | "ocr" | "layout_analysis" | "extraction" | "conversion" | "export";

export type ProcessingJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type ProcessingJob = {
  id: string;
  documentId: string;
  type: ProcessingJobType;
  status: ProcessingJobStatus;
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
};

export type OcrResult = {
  id: string;
  documentId: string;
  language: string;
  confidence: number;
  text: string;
  layoutStatus: "queued" | "analysing" | "complete";
  createdAt: string;
};

export type ExtractionResult = {
  id: string;
  documentId: string;
  detectedType: DocumentType;
  confidence: number;
  fields: Record<string, string | number | boolean | null>;
  lineItems: Array<Record<string, string | number | boolean | null>>;
  createdAt: string;
};

export type ConversionRequest = {
  documentId: string;
  from: "pdf" | "word" | "excel" | "image";
  to: "pdf" | "word" | "excel" | "image";
};

export type DocumentComment = {
  id: string;
  documentId: string;
  authorName: string;
  body: string;
  createdAt: string;
};

export type DocumentDownload = {
  id: string;
  documentId: string;
  label: string;
  format: "xlsx" | "json" | "txt" | "pdf" | "csv";
  status: "ready" | "processing" | "failed";
  href: string;
  createdAt: string;
};

export type AiInsight = {
  id: string;
  documentId: string;
  prompt: string;
  answer: string;
  confidence: number;
  createdAt: string;
};

export type InvoiceStatus = "draft" | "issued" | "paid" | "overdue" | "cancelled";

export type InvoiceLineItemDraft = {
  id?: string;
  serviceItem: string;
  quantity: string;
  unitPrice: string;
};

export type InvoiceItemRecord = {
  id: string;
  invoiceId: string;
  serviceItem: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  position: number;
  createdAt: string;
};

export type InvoiceRecord = {
  id: string;
  workspaceId: string;
  invoiceNumber: string;
  title: string | null;
  description: string | null;
  status: InvoiceStatus;
  clientName: string;
  clientEmail: string | null;
  clientPhone: string | null;
  clientAddress: string | null;
  issuerName: string | null;
  issuerEmail: string | null;
  issuerPhone: string | null;
  issuerAddress: string | null;
  logoDataUrl: string | null;
  bankDetails: string | null;
  notesToClient: string | null;
  termsAndConditions: string | null;
  subtotal: number;
  discountAmount: number;
  taxRate: number;
  taxAmount: number;
  totalAmount: number;
  amountPaid: number;
  dueDate: string | null;
  createdBy: string | null;
  sentAt: string | null;
  paidAt: string | null;
  overdueAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InvoiceWithItems = InvoiceRecord & { items: InvoiceItemRecord[] };
