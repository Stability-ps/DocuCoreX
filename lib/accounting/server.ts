import { randomUUID } from "node:crypto";
import { recordAuditLog } from "@/lib/audit";
import { detectBankProfile } from "@/lib/accounting/engine/registry";
import { BASE_MERCHANT_KNOWLEDGE } from "@/lib/accounting/engine/merchant-kb";
import { getWorkspaceContext } from "@/lib/server-documents";
import { createDocumentVersionRecord } from "@/lib/supabase-server-adapter";
import type {
  AccountingRunDetail,
  AccountingReviewStatus,
  AccountingStatementRun,
  AccountingTransaction,
  AccountingTransactionPatch,
} from "@/lib/accounting/types";
import type { AccountingActionAuditInput, ReviewQueueItem, ReviewQueueStatus } from "@/lib/accounting/engine/types";

const accountingMaxUploadBytes = 200 * 1024 * 1024;
const PROCESSING_HEARTBEAT_STALE_MS = 10 * 60 * 1000;
const PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;

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
  statement_date?: string | null;
  opening_balance: number | string | null;
  closing_balance: number | string | null;
  transaction_count: number;
  bank_charges_total: number | string;
  source_storage_path: string;
  workbook_storage_path: string | null;
  extraction_provider: string;
  parser_profile?: string | null;
  parser_version?: string | null;
  review_required?: boolean | null;
  review_reason?: string | null;
  processing_duration_ms?: number | null;
  extraction_accuracy?: number | string | null;
  parser_method?: string | null;
  extraction_confidence?: number | string | null;
  detected_pdf_type?: string | null;
  ocr_used?: boolean | null;
  route_reason?: string | null;
  extraction_warnings?: string[] | null;
  validation_status?: string | null;
  reconciliation_difference?: number | string | null;
  missing_transaction_count?: number | null;
  requires_review?: boolean | null;
  processing_step?: string | null;
  processing_started_at?: string | null;
  parser_debug?: Record<string, unknown> | null;
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
  source_row?: number | null;
  review_comment?: string | null;
  raw_text: string | null;
  created_at: string;
  updated_at: string;
};

function toNumber(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const next = typeof value === "number" ? value : Number(value);
  return Number.isFinite(next) ? next : null;
}

function normalizeMerchantKey(description: string) {
  return description
    .toLowerCase()
    .replace(/\b\d{1,2}\s+[a-z]{3,9}\b/g, " ")
    .replace(/\b(?:inv|invoice|ref|rmsp|m)\s*[\w-]+\b/g, " ")
    .replace(/\b\d{3,}\b/g, " ")
    .replace(/\d+[.,]\d{2}\s*(cr|dr)?/g, " ")
    .replace(/\b(pty|ltd|business account)\b/g, " ")
    .replace(/[^a-z#* ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
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
    statementDate: row.statement_date ?? null,
    openingBalance: toNumber(row.opening_balance),
    closingBalance: toNumber(row.closing_balance),
    transactionCount: row.transaction_count,
    bankChargesTotal: toNumber(row.bank_charges_total) ?? 0,
    sourceStoragePath: row.source_storage_path,
    workbookStoragePath: row.workbook_storage_path,
    extractionProvider: row.extraction_provider,
    parserProfile: row.parser_profile ?? undefined,
    parserVersion: row.parser_version ?? undefined,
    reviewRequired: Boolean(row.review_required),
    reviewReason: row.review_reason ?? null,
    processingDurationMs: row.processing_duration_ms ?? null,
    extractionAccuracy: toNumber(row.extraction_accuracy ?? null) ?? null,
    parserMethod: row.parser_method ?? null,
    extractionConfidence: toNumber(row.extraction_confidence ?? null) ?? null,
    detectedPdfType: row.detected_pdf_type ?? null,
    ocrUsed: row.ocr_used ?? null,
    routeReason: row.route_reason ?? null,
    extractionWarnings: Array.isArray(row.extraction_warnings) ? row.extraction_warnings : null,
    validationStatus: row.validation_status ?? null,
    reconciliationDifference: toNumber(row.reconciliation_difference ?? null) ?? null,
    missingTransactionCount: row.missing_transaction_count ?? null,
    requiresReview: row.requires_review ?? null,
    processingStep: row.processing_step ?? null,
    processingStartedAt: row.processing_started_at ?? null,
    parserDebug: (row.parser_debug as Record<string, unknown> | null) ?? null,
    confidence: toNumber(row.confidence) ?? 0,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isProcessingLikeStatus(status: string | null | undefined) {
  return status === "processing" || status === "queued";
}

function processingStuckReason(row: Pick<AccountingRunRow, "processing_started_at" | "updated_at">): string | null {
  const now = Date.now();
  const startedAtMs = Date.parse(row.processing_started_at || "") || Date.parse(row.updated_at || "");
  const updatedAtMs = Date.parse(row.updated_at || "");
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(updatedAtMs)) return null;

  const elapsedSinceStartMs = now - startedAtMs;
  if (elapsedSinceStartMs >= PROCESSING_TIMEOUT_MS) {
    const minutes = Math.max(1, Math.round(elapsedSinceStartMs / 60_000));
    return `Processing timed out after ${minutes} minutes. Marked as stuck — retry or force reprocess.`;
  }

  const elapsedSinceHeartbeatMs = now - updatedAtMs;
  if (elapsedSinceHeartbeatMs >= PROCESSING_HEARTBEAT_STALE_MS) {
    const minutes = Math.max(1, Math.round(elapsedSinceHeartbeatMs / 60_000));
    return `Processing stale — no heartbeat update for ${minutes} minutes. Marked as stuck — retry or force reprocess.`;
  }
  return null;
}

async function markRunStuckIfNeeded(context: NonNullable<Awaited<ReturnType<typeof getWorkspaceContext>>>, row: AccountingRunRow): Promise<AccountingRunRow> {
  if (!isProcessingLikeStatus(row.status)) return row;
  const reason = processingStuckReason(row);
  if (!reason) return row;

  const nowIso = new Date().toISOString();
  const { error } = await context.supabase
    .from("accounting_statement_runs")
    .update({
      status: "failed",
      error: reason,
      processing_step: "Stuck / Needs retry",
      updated_at: nowIso,
    })
    .eq("workspace_id", context.workspaceId)
    .eq("id", row.id);
  if (error) return row;

  if (row.processing_job_id) {
    await context.supabase
      .from("processing_jobs")
      .update({
        status: "failed",
        progress: 100,
        message: reason,
        error: reason,
        updated_at: nowIso,
      })
      .eq("id", row.processing_job_id);
  }

  return {
    ...row,
    status: "failed",
    error: reason,
    processing_step: "Stuck / Needs retry",
    updated_at: nowIso,
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
    sourceRow: row.source_row ?? null,
    reviewComment: row.review_comment ?? "",
    rawText: row.raw_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function recordAccountingActionAudit(input: AccountingActionAuditInput) {
  const context = await getWorkspaceContext().catch(() => null);
  if (!context) return;

  const { error } = await context.supabase.from("accounting_action_audit").insert({
    workspace_id: context.workspaceId,
    actor_id: context.userId,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId,
    previous_value: input.previousValue ?? null,
    new_value: input.newValue ?? null,
    metadata: input.metadata ?? {},
  });

  if (error && error.code !== "42P01" && error.code !== "PGRST204") {
    console.warn("[accounting] action audit insert failed", error.message);
  }
}

async function ensureMerchantKnowledgeBase() {
  const context = await getWorkspaceContext();
  if (!context) return;

  const now = new Date().toISOString();
  const rows = BASE_MERCHANT_KNOWLEDGE.map((entry) => ({
    workspace_id: context.workspaceId,
    canonical_name: entry.canonicalName,
    aliases: entry.aliases,
    default_category: entry.defaultCategory,
    default_vat_treatment: entry.defaultVatTreatment,
    confidence: entry.confidence ?? 90,
    created_by: context.userId,
    updated_at: now,
  }));

  const { error } = await context.supabase
    .from("accounting_merchant_knowledge")
    .upsert(rows, { onConflict: "workspace_id,canonical_name", ignoreDuplicates: true });

  if (error && error.code !== "42P01" && error.code !== "PGRST204") {
    console.warn("[accounting] could not seed merchant knowledge base", error.message);
  }

  const ruleRows = BASE_MERCHANT_KNOWLEDGE.flatMap((entry) => {
    const phrases = [entry.canonicalName, ...entry.aliases];
    return phrases
      .map((phrase) => ({ phrase, merchantKey: normalizeMerchantKey(phrase) }))
      .filter((rule, index, list) => rule.merchantKey && list.findIndex((item) => item.merchantKey === rule.merchantKey) === index)
      .map(({ phrase, merchantKey }) => ({
        workspace_id: context.workspaceId,
        merchant_key: merchantKey,
        account_category: entry.defaultCategory,
        vat_treatment: entry.defaultVatTreatment,
        review_status:
          entry.defaultReviewStatus ??
          (entry.defaultVatTreatment === "review" || entry.defaultCategory.includes("Review") || entry.defaultCategory.includes("Uncategorised")
            ? "needs_review"
            : "approved"),
        confidence: entry.confidence ?? 90,
        reason: entry.reason ?? `Seeded supplier rule: ${entry.canonicalName}.`,
        sample_description: phrase,
        created_by: context.userId,
        updated_at: now,
        last_used_at: now,
      }));
  });

  const { error: ruleError } = await context.supabase
    .from("accounting_classification_rules")
    .upsert(ruleRows, { onConflict: "workspace_id,merchant_key", ignoreDuplicates: true });

  if (ruleError && ruleError.code !== "42P01" && ruleError.code !== "PGRST204") {
    console.warn("[accounting] could not seed accounting classification rules", ruleError.message);
  }
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
  const parserProfile = detectBankProfile({ bank: "FNB South Africa", fileName: file.name });
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
      parser_profile: parserProfile,
      parser_version: parserProfile,
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

  await recordAccountingActionAudit({
    action: "statement_uploaded",
    entityType: "accounting_statement_run",
    entityId: run.id,
    newValue: { bank: "FNB South Africa", parserProfile, fileName: file.name },
  });

  await ensureMerchantKnowledgeBase();

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

  const healed = await Promise.all(((data ?? []) as AccountingRunRow[]).map((row) => markRunStuckIfNeeded(context, row)));
  return healed.map(mapRun);
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
  const healedRun = await markRunStuckIfNeeded(context, run as AccountingRunRow);

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
    run: mapRun(healedRun),
    transactions: ((transactions ?? []) as AccountingTransactionRow[]).map(mapTransaction),
  };
}

export async function repairStuckAccountingRuns(options?: { runId?: string }) {
  const context = await getWorkspaceContext();
  if (!context) {
    throw new Error("Unauthorized");
  }

  let query = context.supabase
    .from("accounting_statement_runs")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .in("status", ["queued", "processing"]);
  if (options?.runId) {
    query = query.eq("id", options.runId);
  }
  const { data, error } = await query;
  if (error) {
    throw new Error(error.message);
  }

  const rows = (data ?? []) as AccountingRunRow[];
  const repaired: string[] = [];
  for (const row of rows) {
    const next = await markRunStuckIfNeeded(context, row);
    if (next.status === "failed" && row.status !== "failed") repaired.push(row.id);
  }

  return { checked: rows.length, repairedRunIds: repaired };
}

export async function deleteAccountingRuns(runIds: string[]) {
  const context = await getWorkspaceContext();
  if (!context) {
    throw new Error("Unauthorized");
  }

  const ids = Array.from(new Set(runIds)).filter(Boolean);
  if (!ids.length) return { deletedIds: [] as string[] };

  const { data: runs, error: runError } = await context.supabase
    .from("accounting_statement_runs")
    .select("id, document_id, processing_job_id, source_storage_path, workbook_storage_path")
    .eq("workspace_id", context.workspaceId)
    .in("id", ids);

  if (runError) {
    throw new Error(runError.message);
  }

  const foundRuns = runs ?? [];
  const foundIds = foundRuns.map((run) => run.id);
  if (!foundIds.length) return { deletedIds: [] as string[] };

  await context.supabase.from("accounting_transactions").delete().eq("workspace_id", context.workspaceId).in("run_id", foundIds);
  await context.supabase.from("accounting_statement_runs").delete().eq("workspace_id", context.workspaceId).in("id", foundIds);

  const documentIds = foundRuns.map((run) => run.document_id).filter(Boolean) as string[];
  if (documentIds.length) {
    await context.supabase
      .from("documents")
      .update({ deleted_at: new Date().toISOString(), status: "trashed", updated_at: new Date().toISOString() })
      .eq("workspace_id", context.workspaceId)
      .in("id", documentIds);
  }

  const jobIds = foundRuns.map((run) => run.processing_job_id).filter(Boolean) as string[];
  if (jobIds.length) {
    await context.supabase.from("processing_jobs").update({ status: "cancelled", updated_at: new Date().toISOString() }).in("id", jobIds);
  }

  await Promise.all(
    foundIds.map((id) =>
      recordAuditLog({
        action: "accounting_statement_deleted",
        entityType: "accounting_statement_run",
        entityId: id,
        metadata: { bulk: foundIds.length > 1 },
      }),
    ),
  );

  await recordAccountingActionAudit({
    action: "statement_deleted",
    entityType: "accounting_statement_run",
    entityId: foundIds.join(","),
    previousValue: { runs: foundRuns },
    metadata: { count: foundIds.length },
  });

  return { deletedIds: foundIds };
}

export async function updateAccountingTransaction(transactionId: string, patch: AccountingTransactionPatch) {
  const context = await getWorkspaceContext();
  if (!context) {
    throw new Error("Unauthorized");
  }

  const { data: previousRow } = await context.supabase
    .from("accounting_transactions")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .eq("id", transactionId)
    .single();

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

  const transaction = mapTransaction(data as AccountingTransactionRow);
  const shouldLearn =
    patch.accountCategory !== undefined ||
    patch.vatTreatment !== undefined ||
    patch.reviewStatus === "approved" ||
    patch.supportedByInvoice !== undefined;
  const merchantKey = normalizeMerchantKey(transaction.description);

  if (shouldLearn && merchantKey && transaction.accountCategory !== "Review Required" && transaction.accountCategory !== "Uncategorised Expense") {
    const { error: learningError } = await context.supabase
      .from("accounting_classification_rules")
      .upsert(
        {
          workspace_id: context.workspaceId,
          merchant_key: merchantKey,
          account_category: transaction.accountCategory,
          vat_treatment: transaction.vatTreatment,
          review_status: transaction.reviewStatus,
          confidence: transaction.reviewStatus === "approved" ? 98 : 92,
          reason: `Learned from accountant correction: ${transaction.accountCategory}.`,
          sample_description: transaction.description,
          created_by: context.userId,
          updated_at: new Date().toISOString(),
          last_used_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,merchant_key" },
      );
    if (learningError && learningError.code !== "42P01" && learningError.code !== "PGRST204") {
      console.warn("[accounting] could not save classification learning rule", learningError.message);
    }
  }

  const { error: learningEventError } = await context.supabase.from("accounting_ai_learning_events").insert({
    workspace_id: context.workspaceId,
    transaction_id: transaction.id,
    merchant: merchantKey || transaction.description,
    description: transaction.description,
    chosen_category: transaction.accountCategory,
    vat_treatment: transaction.vatTreatment,
    confidence: transaction.confidence,
    manual_correction: Boolean(patch.accountCategory || patch.vatTreatment || patch.reviewStatus),
    created_by: context.userId,
  });
  if (learningEventError && learningEventError.code !== "42P01" && learningEventError.code !== "PGRST204") {
    console.warn("[accounting] could not save learning event", learningEventError.message);
  }

  await recordAuditLog({
    action: "accounting_transaction_reviewed",
    entityType: "accounting_transaction",
    entityId: transactionId,
    metadata: update,
  });

  await recordAccountingActionAudit({
    action: "manual_edit",
    entityType: "accounting_transaction",
    entityId: transactionId,
    previousValue: previousRow ? mapTransaction(previousRow as AccountingTransactionRow) : null,
    newValue: transaction,
    metadata: { patch },
  });

  return transaction;
}

export async function listAccountingReviewQueue(status?: ReviewQueueStatus): Promise<ReviewQueueItem[]> {
  const context = await getWorkspaceContext();
  if (!context) {
    throw new Error("Unauthorized");
  }

  const query = context.supabase
    .from("accounting_transactions")
    .select("id,run_id,transaction_date,description,account_category,vat_treatment,confidence,review_status,notes,created_at,updated_at")
    .eq("workspace_id", context.workspaceId)
    .order("updated_at", { ascending: false });

  if (status) {
    query.eq("review_status", status as AccountingReviewStatus);
  }

  const { data: rows, error } = await query;
  if (error) {
    throw new Error(error.message);
  }

  const runIds = Array.from(new Set((rows ?? []).map((row) => row.run_id))).filter(Boolean);
  const { data: runs } = runIds.length
    ? await context.supabase
        .from("accounting_statement_runs")
        .select("id,bank,statement_period_start,statement_period_end")
        .in("id", runIds)
    : { data: [] as Array<{ id: string; bank: string; statement_period_start: string | null; statement_period_end: string | null }> };

  const runMap = new Map((runs ?? []).map((run) => [run.id, run]));

  return (rows ?? []).map((row) => {
    const run = runMap.get(row.run_id);
    return {
      transactionId: row.id,
      runId: row.run_id,
      bank: run?.bank ?? "Unknown",
      statementLabel: `${run?.statement_period_start ?? "Unknown"} to ${run?.statement_period_end ?? "Unknown"}`,
      transactionDate: row.transaction_date,
      description: row.description,
      accountCategory: row.account_category,
      vatTreatment: row.vat_treatment,
      confidence: Number(row.confidence ?? 0),
      status: row.review_status as ReviewQueueStatus,
      notes: row.notes ?? "",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

export async function updateAccountingReviewWorkflow(transactionId: string, status: ReviewQueueStatus, comment: string) {
  const context = await getWorkspaceContext();
  if (!context) {
    throw new Error("Unauthorized");
  }

  const { data: previousRow } = await context.supabase
    .from("accounting_transactions")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .eq("id", transactionId)
    .single();

  const { data, error } = await context.supabase
    .from("accounting_transactions")
    .update({ review_status: status, review_comment: comment || null, updated_at: new Date().toISOString() })
    .eq("workspace_id", context.workspaceId)
    .eq("id", transactionId)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "Unable to update review workflow.");
  }

  const transaction = mapTransaction(data as AccountingTransactionRow);
  await recordAuditLog({
    action: "accounting_review_status_changed",
    entityType: "accounting_transaction",
    entityId: transactionId,
    metadata: { status, comment },
  });
  await recordAccountingActionAudit({
    action: "review_status_changed",
    entityType: "accounting_transaction",
    entityId: transactionId,
    previousValue: previousRow ? mapTransaction(previousRow as AccountingTransactionRow) : null,
    newValue: transaction,
    metadata: { comment },
  });

  return transaction;
}

export async function listAccountingReviewComments(transactionId: string) {
  const context = await getWorkspaceContext();
  if (!context) {
    throw new Error("Unauthorized");
  }

  const { data, error } = await context.supabase
    .from("accounting_review_comments")
    .select("id, transaction_id, body, created_at, author_id")
    .eq("workspace_id", context.workspaceId)
    .eq("transaction_id", transactionId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    transactionId: row.transaction_id,
    body: row.body,
    createdAt: row.created_at,
    authorId: row.author_id,
  }));
}

export async function addAccountingReviewComment(transactionId: string, body: string) {
  const context = await getWorkspaceContext();
  if (!context) {
    throw new Error("Unauthorized");
  }

  const { data, error } = await context.supabase
    .from("accounting_review_comments")
    .insert({
      workspace_id: context.workspaceId,
      transaction_id: transactionId,
      body,
      author_id: context.userId,
    })
    .select("id, transaction_id, body, created_at, author_id")
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "Unable to add review comment.");
  }

  await recordAuditLog({
    action: "accounting_review_comment_added",
    entityType: "accounting_transaction",
    entityId: transactionId,
    metadata: { commentLength: body.length },
  });
  await recordAccountingActionAudit({
    action: "review_comment_added",
    entityType: "accounting_transaction",
    entityId: transactionId,
    newValue: { body },
  });

  return {
    id: data.id,
    transactionId: data.transaction_id,
    body: data.body,
    createdAt: data.created_at,
    authorId: data.author_id,
  };
}
