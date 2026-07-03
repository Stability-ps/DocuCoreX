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

export type InvoiceVatType = "exempt" | "zero_rated" | "standard" | "custom";

export type InvoicePaymentTerms = "due_on_receipt" | "7_days" | "14_days" | "30_days" | "60_days" | "90_days";

export type InvoiceLineItemDraft = {
  id?: string;
  serviceItem: string;
  quantity: string;
  unitPrice: string;
  vatType: InvoiceVatType;
  vatRate: string;
};

export type InvoiceItemRecord = {
  id: string;
  invoiceId: string;
  serviceItem: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  vatType: InvoiceVatType;
  vatRate: number;
  position: number;
  createdAt: string;
};

export type CompanyProfile = {
  id: string;
  workspaceId: string;
  isDefault: boolean;
  isArchived: boolean;
  logoDataUrl: string | null;
  businessName: string;
  tradingName: string | null;
  vatNumber: string | null;
  registrationNumber: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  physicalAddress: string | null;
  postalAddress: string | null;
  bankName: string | null;
  bankAccountHolder: string | null;
  bankAccountNumber: string | null;
  bankBranchCode: string | null;
  bankSwift: string | null;
  paymentReference: string | null;
  defaultCurrency: string;
  defaultVatRate: number;
  defaultPaymentTerms: InvoicePaymentTerms;
  defaultNotes: string | null;
  defaultTerms: string | null;
  nextInvoiceNumber: number;
  createdAt: string;
  updatedAt: string;
};

export type InvoiceRecord = {
  id: string;
  workspaceId: string;
  companyId: string | null;
  invoiceNumber: string;
  sequenceNumber: number | null;
  title: string | null;
  description: string | null;
  status: InvoiceStatus;
  currency: string;
  invoiceDate: string;
  dueDate: string | null;
  paymentTerms: InvoicePaymentTerms;
  referenceNumber: string | null;
  internalNotes: string | null;
  // Issuer ("your business") details
  issuerName: string | null;
  issuerTradingName: string | null;
  issuerEmail: string | null;
  issuerPhone: string | null;
  issuerWebsite: string | null;
  issuerAddress: string | null;
  issuerPostalAddress: string | null;
  issuerVatNumber: string | null;
  issuerRegistrationNumber: string | null;
  logoDataUrl: string | null;
  // Payment / banking details
  bankName: string | null;
  bankAccountHolder: string | null;
  bankAccountNumber: string | null;
  bankBranchCode: string | null;
  bankSwift: string | null;
  paymentReference: string | null;
  paymentInstructions: string | null;
  /** @deprecated legacy free-text bank details field, superseded by the structured bank* fields above */
  bankDetails: string | null;
  // Client details
  clientName: string;
  clientCompanyName: string | null;
  clientContactPerson: string | null;
  clientEmail: string | null;
  clientPhone: string | null;
  clientAddress: string | null;
  clientPostalAddress: string | null;
  clientVatNumber: string | null;
  clientRegistrationNumber: string | null;
  attentionTo: string | null;
  purchaseOrderNumber: string | null;
  clientReference: string | null;
  // Notes
  notesToClient: string | null;
  termsAndConditions: string | null;
  // Totals
  subtotal: number;
  discountAmount: number;
  shippingAmount: number;
  additionalCharges: number;
  taxRate: number;
  taxAmount: number;
  totalAmount: number;
  amountPaid: number;
  createdBy: string | null;
  sentAt: string | null;
  paidAt: string | null;
  overdueAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InvoiceWithItems = InvoiceRecord & { items: InvoiceItemRecord[] };

export type NotificationType =
  | "invoice_created"
  | "invoice_updated"
  | "invoice_issued"
  | "invoice_overdue"
  | "invoice_paid"
  | "invoice_email_failed"
  | "document_upload_completed"
  | "document_upload_failed"
  | "document_ocr_completed"
  | "document_ocr_failed"
  | "document_converted"
  | "document_conversion_failed"
  | "document_export_ready"
  | "accounting_statement_processed"
  | "accounting_transactions_extracted"
  | "accounting_cash_flow_generated"
  | "accounting_vat_warning"
  | "accounting_duplicate_transaction"
  | "accounting_ai_review_completed"
  | "billing_subscription_renewed"
  | "billing_subscription_expiring"
  | "billing_payment_received"
  | "billing_payment_failed"
  | "billing_usage_limit_reached"
  | "team_user_invited"
  | "team_invitation_accepted"
  | "team_role_changed"
  | "team_comment_added"
  | "team_mention_received"
  | "security_new_login"
  | "security_password_changed"
  | "security_mfa_enabled"
  | "security_api_key_created"
  | "security_api_key_revoked"
  | "system_maintenance_notice"
  | "system_storage_almost_full"
  | "system_backup_completed"
  | "system_service_interruption";

export type NotificationRecord = {
  id: string;
  workspaceId: string;
  userId: string | null;
  type: NotificationType;
  title: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
  href: string | null;
  readAt: string | null;
  createdAt: string;
};
