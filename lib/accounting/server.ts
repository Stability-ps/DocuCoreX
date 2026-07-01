import { randomUUID } from "node:crypto";
import { recordAuditLog } from "@/lib/audit";
import { getWorkspaceContext } from "@/lib/server-documents";
import { createDocumentVersionRecord } from "@/lib/supabase-server-adapter";
import type {
  AccountingRunDetail,
  AccountingStatementRun,
  AccountingTransaction,
  AccountingTransactionPatch,
} from "@/lib/accounting/types";

const accountingMaxUploadBytes = 200 * 1024 * 1024;

type AccountingRunRow = {
  id: string;
  workspace_id: string;
  document_id: string | null;
  processing_job_id: string | null;
  bank: string;
  statement_type: string;
  status: AccountingStatementRun["status"];
  company_name: string | null;
  account_number: string | null;
  statement_period_start: string | null;
  statement_period_end: string | null;
  opening_balance: number | string | null;
  closing_balance: number | string | null;
  transaction_count: number;
  bank_charges_total: number | string;
  source_storage_path: string;
  workbook_storage_path: string | null;
  extraction_provider: string;
  confidence: number | string;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type AccountingTransactionRow = {
  id: string;
  run_id: string;
  workspace_id: string;
  transaction_date: string | null;
  description: string;
  debit_amount: number | string | null;
  credit_amount: number | string | null;
  running_balance: number | string | null;
  bank_charge: boolean;
  account_category: string;
  vat_treatment: AccountingTransaction["vatTreatment"];
  supported_by_invoice: boolean;
  notes: string;
  confidence: number | string;
  review_status: AccountingTransaction["reviewStatus"];
  source_page: number | null;
  raw_text: string | null;
  created_at: string;
  updated_at: string;
};

function toNumber(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const next = typeof value === "number" ? value : Number(value);
  return Number.isFinite(next) ? next : null;
}

function mapRun(row: AccountingRunRow): AccountingStatementRun {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    documentId: row.document_id,
    processingJobId: row.processing_job_id,
    bank: row.bank,
    statementType: row.statement_type,
    status: row.status,
    companyName: row.company_name,
    accountNumber: row.account_number,
    statementPeriodStart: row.statement_period_start,
    statementPeriodEnd: row.statement_period_end,
    openingBalance: toNumber(row.opening_balance),
    closingBalance: toNumber(row.closing_balance),
    transactionCount: row.transaction_count,
    bankChargesTotal: toNumber(row.bank_charges_total) ?? 0,
    sourceStoragePath: row.source_storage_path,
    workbookStoragePath: row.workbook_storage_path,
    extractionProvider: row.extraction_provider,
    confidence: toNumber(row.confidence) ?? 0,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTransaction(row: AccountingTransactionRow): AccountingTransaction {
  return {
    id: row.id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    transactionDate: row.transaction_date,
    description: row.description,
    debitAmount: toNumber(row.debit_amount),
    creditAmount: toNumber(row.credit_amount),
    runningBalance: toNumber(row.running_balance),
    bankCharge: row.bank_charge,
    accountCategory: row.account_category,
    vatTreatment: row.vat_treatment,
    supportedByInvoice: row.supported_by_invoice,
    notes: row.notes,
    confidence: toNumber(row.confidence) ?? 0,
    reviewStatus: row.review_status,
    sourcePage: row.source_page,
    rawText: row.raw_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertFnbPdf(file: File) {
  if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
    throw new Error("Phase 1 only supports FNB South Africa business bank statement PDFs.");
  }

  if (file.size <= 0) {
    throw new Error("The uploaded PDF is empty.");
  }

  if (file.size > accountingMaxUploadBytes) {
    throw new Error("The statement is larger than the 200 MB upload limit.");
  }
}

function accountingStoragePath(workspaceId: string, fileName: string) {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${workspaceId}/accounting/fnb/${randomUUID()}-${safeName}`;
}

export async function createFnbAccountingRun(file: File) {
  assertFnbPdf(file);

  const context = await getWorkspaceContext();
  if (!context) {
    throw new Error("Sign in is required to upload accounting statements.");
  }

  const storagePath = accountingStoragePath(context.workspaceId, file.name);
  const upload = await context.supabase.storage.from("documents").upload(storagePath, file, {
    contentType: file.type || "application/pdf",
    upsert: false,
  });

  if (upload.error) {
    throw new Error(upload.error.message);
  }

  const { data: document, error: documentError } = await context.supabase
    .from("documents")
    .insert({
      workspace_id: context.workspaceId,
      owner_id: context.userId,
      name: file.name,
      mime_type: file.type || "application/pdf",
      size_bytes: file.size,
      page_count: 0,
      status: "queued",
      detected_type: "bank_statement",
      storage_path: storagePath,
      tags: ["Accounting Intelligence", "FNB", "Bank Statement"],
    })
    .select("id")
    .single();

  if (documentError || !document) {
    throw new Error(documentError?.message ?? "Unable to create accounting document.");
  }

  await createDocumentVersionRecord(document.id, storagePath, "Original FNB statement upload");

  await context.supabase.from("uploads").insert({
    workspace_id: context.workspaceId,
    document_id: document.id,
    file_name: file.name,
    mime_type: file.type || "application/pdf",
    size_bytes: file.size,
    storage_path: storagePath,
    status: "completed",
    created_by: context.userId,
  });

  const { data: job, error: jobError } = await context.supabase
    .from("processing_jobs")
    .insert({
      document_id: document.id,
      type: "extraction",
      status: "queued",
      progress: 0,
      message: "Accounting intelligence queued",
    })
    .select("id")
    .single();

  if (jobError || !job) {
    throw new Error(jobError?.message ?? "Unable to create accounting processing job.");
  }

  const { data: run, error: runError } = await context.supabase
    .from("accounting_statement_runs")
    .insert({
      workspace_id: context.workspaceId,
      document_id: document.id,
      processing_job_id: job.id,
      bank: "FNB South Africa",
      status: "queued",
      source_storage_path: storagePath,
      created_by: context.userId,
    })
    .select("*")
    .single();

  if (runError || !run) {
    throw new Error(runError?.message ?? "Unable to create accounting statement run.");
  }

  await recordAuditLog({
    action: "accounting_statement_uploaded",
    entityType: "document",
    entityId: document.id,
    metadata: { runId: run.id, bank: "FNB South Africa", fileName: file.name },
  });

  return mapRun(run as AccountingRunRow);
}

export async function listAccountingRuns() {
  const context = await getWorkspaceContext();
  if (!context) return [];

  const { data, error } = await context.supabase
    .from("accounting_statement_runs")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as AccountingRunRow[]).map(mapRun);
}

export async function getAccountingRunDetail(runId: string): Promise<AccountingRunDetail | null> {
  const context = await getWorkspaceContext();
  if (!context) return null;

  const { data: run, error: runError } = await context.supabase
    .from("accounting_statement_runs")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .eq("id", runId)
    .single();

  if (runError || !run) {
    return null;
  }

  const { data: transactions, error: transactionError } = await context.supabase
    .from("accounting_transactions")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .eq("run_id", runId)
    .order("transaction_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });

  if (transactionError) {
    throw new Error(transactionError.message);
  }

  return {
    run: mapRun(run as AccountingRunRow),
    transactions: ((transactions ?? []) as AccountingTransactionRow[]).map(mapTransaction),
  };
}

export async function updateAccountingTransaction(transactionId: string, patch: AccountingTransactionPatch) {
  const context = await getWorkspaceContext();
  if (!context) {
    throw new Error("Unauthorized");
  }

  const update = {
    ...(patch.accountCategory !== undefined ? { account_category: patch.accountCategory } : {}),
    ...(patch.vatTreatment !== undefined ? { vat_treatment: patch.vatTreatment } : {}),
    ...(patch.supportedByInvoice !== undefined ? { supported_by_invoice: patch.supportedByInvoice } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    ...(patch.reviewStatus !== undefined ? { review_status: patch.reviewStatus } : {}),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await context.supabase
    .from("accounting_transactions")
    .update(update)
    .eq("workspace_id", context.workspaceId)
    .eq("id", transactionId)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "Unable to update transaction.");
  }

  await recordAuditLog({
    action: "accounting_transaction_reviewed",
    entityType: "accounting_transaction",
    entityId: transactionId,
    metadata: update,
  });

  return mapTransaction(data as AccountingTransactionRow);
}
