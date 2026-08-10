import { randomUUID } from "node:crypto";
import { recordAuditLog } from "@/lib/audit";
import { PENDING_BANK_NAME, PENDING_PARSER_PROFILE } from "@/lib/accounting/engine/bank-detection";
import { BASE_MERCHANT_KNOWLEDGE } from "@/lib/accounting/engine/merchant-kb";
import { canonicaliseCategory } from "@/lib/accounting/categories";
import { merchantKeyRejection } from "@/lib/accounting/merchant-keys";
import { isUnresolvedAccountingCategory } from "@/lib/accounting/review-options";
import { MAX_TAG_LENGTH, dedupeTags, normalizeTag, sameTag, sortTags, tagRejection } from "@/lib/accounting/tags";
import { bestTransferCandidates, findTransferCandidates, type TransferCandidate, type TransferSide } from "@/lib/accounting/transfers";
import { findRecurringPatterns, type RecurringInput, type RecurringPattern } from "@/lib/accounting/recurring";
import { latestBalancesByAccount, summarizeCashflow, type CashflowInput, type CashflowSummary } from "@/lib/accounting/cashflow";
import { buildCoverage, type CoverageResult, type CoverageStatement } from "@/lib/accounting/coverage";
import { buildFlowOfFunds, type FlowInput, type FlowOfFunds } from "@/lib/accounting/flow-of-funds";
import { buildCashForecast, type CashForecast } from "@/lib/accounting/forecast";
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
  // Migration 019 — the confidence split. Optional: runs predating it report null.
  classification_confidence?: number | string | null;
  reconciliation_confidence?: number | string | null;
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
  // Migration 024. Present on every select("*"); declared here so the stuck
  // sweeper can tell an accepted job from one that never reached the worker.
  active_job_id?: string | null;
  job_accepted_at?: string | null;
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
  // Migration 021. Optional: rows predating it report null rather than a guess.
  classification_source?: string | null;
  classification_strength?: string | null;
  classification_confidence?: number | string | null;
  classification_reason?: string | null;
  normalized_merchant?: string | null;
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
    // Strip reference tokens — "INV109034", "REF 8823", "M12345".
    //
    // The bare `m` alternative used to sit in this group, and `m` followed by
    // `[\w-]+` consumes ANY word beginning with m: "Momentum Health" became
    // "health", "MSI Industries" became "industries", and "mr d" became "d" —
    // the key that then matched 425 of 615 rows on a real statement. A reference
    // beginning with m is followed by a digit; a merchant name is not.
    .replace(/\b(?:inv|invoice|ref|rmsp)\s*[\w-]+\b/g, " ")
    .replace(/\bm\d[\w-]*\b/g, " ")
    .replace(/\b\d{3,}\b/g, " ")
    .replace(/\d+[.,]\d{2}\s*(cr|dr)?/g, " ")
    .replace(/\b(pty|ltd|business account)\b/g, " ")
    .replace(/[^a-z#* ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function deriveLearningMerchantKeys(description: string) {
  const normalized = normalizeMerchantKey(description);
  const keys = new Set<string>();
  if (normalized) keys.add(normalized);

  let merchant = normalized
    .replace(/\b(fnb|app|payment|pmt|rtc|ob|to|from|payshap|account|off|us|send|money|dr|cr|eft|credit|debit|pos|purchase|new|dl|domestic|trea)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const supplierMatch = merchant.match(/\b([a-z][a-z]+(?:\s+[a-z][a-z]+){0,3}\s+(?:industries|trading|enterprises|enterprise|interiors|services|works|suppliers|logistics|courier|freight))\b/);
  if (supplierMatch?.[1]) {
    keys.add(supplierMatch[1].trim().slice(0, 160));
  }

  if (merchant) keys.add(merchant.slice(0, 160));
  return Array.from(keys).filter((key) => key.length >= 4);
}

const EMPTY_ACCOUNTING_METADATA = new Set(["", "-", "—", "n/a", "na", "none", "<none>", "null", "undefined", "not provided"]);

function cleanAccountingMetadata(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (EMPTY_ACCOUNTING_METADATA.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

function mapRun(row: AccountingRunRow): AccountingStatementRun {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    documentId: row.document_id,
    processingJobId: row.processing_job_id,
    activeJobId: row.active_job_id ?? null,
    bank: cleanAccountingMetadata(row.bank) ?? row.bank,
    statementType: row.statement_type,
    status: row.status,
    companyName: cleanAccountingMetadata(row.company_name),
    accountNumber: cleanAccountingMetadata(row.account_number),
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
    confidences: {
      extraction: toNumber(row.extraction_confidence ?? null) ?? null,
      // Fall back to the legacy column: it has always held the classification
      // score, so pre-migration runs still report it correctly.
      classification: toNumber(row.classification_confidence ?? null) ?? toNumber(row.confidence ?? null) ?? null,
      reconciliation: toNumber(row.reconciliation_confidence ?? null) ?? null,
    },
    // @deprecated — see AccountingStatementRun.confidence
    confidence: toNumber(row.confidence) ?? 0,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isProcessingLikeStatus(status: string | null | undefined) {
  return status === "processing" || status === "queued";
}

/**
 * Why a run looks stuck, or null if it does not.
 *
 * `livenessAtIso` is the worker's heartbeat — processing_jobs.updated_at, which
 * a ticker touches every ~45s for as long as the task is alive. It is NOT the
 * run's updated_at, which only moves at stage boundaries.
 *
 * That distinction is the whole point. Reading the run's updated_at made "the
 * stage has not changed" indistinguishable from "the worker is dead", and a
 * legitimately long stage — classification is ~21 model round trips for a
 * 613-transaction statement — was failed at 10 minutes while healthy. Stale
 * must mean loss of liveness, not absence of progress.
 *
 * Falls back to the run's updated_at when no heartbeat is available, so a job
 * from before the ticker existed still gets the old behaviour rather than
 * becoming immortal.
 */
function processingStuckReason(
  row: Pick<AccountingRunRow, "processing_started_at" | "updated_at">,
  livenessAtIso?: string | null,
  enforceTotalTimeout = true,
): string | null {
  const now = Date.now();
  const startedAtMs = Date.parse(row.processing_started_at || "") || Date.parse(row.updated_at || "");
  const livenessParsed = Date.parse(livenessAtIso || "");
  const updatedAtMs = Number.isFinite(livenessParsed) ? livenessParsed : Date.parse(row.updated_at || "");
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(updatedAtMs)) return null;

  const elapsedSinceStartMs = now - startedAtMs;
  if (enforceTotalTimeout && elapsedSinceStartMs >= PROCESSING_TIMEOUT_MS) {
    const minutes = Math.max(1, Math.round(elapsedSinceStartMs / 60_000));
    return `Processing timed out after ${minutes} minutes. Marked as stuck — retry or force reprocess.`;
  }

  const elapsedSinceHeartbeatMs = now - updatedAtMs;
  if (elapsedSinceHeartbeatMs >= PROCESSING_HEARTBEAT_STALE_MS) {
    const minutes = Math.max(1, Math.round(elapsedSinceHeartbeatMs / 60_000));
    return `Processing appears interrupted — no worker heartbeat for ${minutes} minutes. Your uploaded statement is safe; retry or force reprocess.`;
  }
  return null;
}

/**
 * Mark a run stuck only after current database state proves its owner is dead.
 *
 * This runs on read, and it used to write status:"failed" for any run that had
 * been "processing" or "queued" too long — with no knowledge of job ownership.
 * That reintroduced, through the read path, exactly the defect #79 removed from
 * the dispatch path: a run marked failed while the worker was still working on
 * it. Production hit it — "Processing stale — no heartbeat update for 10
 * minutes" on a 37-page, 613-transaction statement the worker had accepted and
 * was still processing.
 *
 * Two cases are left alone:
 *
 *   ACCEPTED + LIVE — the worker owns the terminal state, per #79. A database
 *   function rechecks the linked job's current heartbeat and active_job_id under
 *   lock, so an observation made before a fresh heartbeat or Force Reprocess
 *   cannot fail the live/new attempt.
 *
 *   QUEUED — uploaded and waiting for someone to press Process (#78). It has
 *   not started, so it cannot be stuck, and it may legitimately sit there for
 *   days. Failing it after a timeout would be nonsense.
 *
 * Recoverable cases are an unaccepted dispatch that died, an accepted job whose
 * heartbeat is genuinely cold, or a terminal processing_jobs row whose run never
 * received its matching terminal write.
 */
async function markRunStuckIfNeeded(context: NonNullable<Awaited<ReturnType<typeof getWorkspaceContext>>>, row: AccountingRunRow): Promise<AccountingRunRow> {
  if (!isProcessingLikeStatus(row.status)) return row;
  // A queued run with no processing job is genuinely waiting on the user.
  // If it already has a processing job, the handoff started and the row should
  // be treated like an in-flight run so stale ownership can be repaired.
  if (row.status === "queued" && !row.processing_job_id) return row;

  // Liveness comes from the job's heartbeat, not the run's stage changes.
  let livenessAt: string | null = null;
  let jobStatus: string | null = null;
  if (row.processing_job_id) {
    const { data: job, error: heartbeatError } = await context.supabase
      .from("processing_jobs")
      .select("status, updated_at")
      .eq("id", row.processing_job_id)
      .maybeSingle();
    // Unknown liveness is not stale liveness. A transient read error must never
    // recreate the old bug by falling back to a stage timestamp and failing a
    // healthy worker in a long classification stage.
    if (heartbeatError) return row;
    const linkedJob = job as { status?: string; updated_at?: string } | null;
    livenessAt = linkedJob?.updated_at ?? null;
    jobStatus = linkedJob?.status ?? null;
  }

  const terminalJobMismatch = row.job_accepted_at && jobStatus && ["failed", "cancelled", "completed"].includes(jobStatus)
    ? `Processing worker ended with job status ${jobStatus}, but the statement run never reached a terminal state. Retry or force reprocess.`
    : null;
  // Accepted work has a live heartbeat every ~45s. Do not impose a total runtime
  // ceiling on healthy work, but do recover it when that heartbeat is genuinely
  // stale. Without this, a process lost during deploy remains immortal.
  const enforceTotalTimeout = row.status === "queued" ? false : !row.job_accepted_at;
  const reason = terminalJobMismatch ?? processingStuckReason(row, livenessAt, enforceTotalTimeout);
  if (!reason) return row;

  const livenessCutoff = new Date(Date.now() - PROCESSING_HEARTBEAT_STALE_MS).toISOString();
  const { data: repaired, error: repairError } = await context.supabase.rpc("fail_stale_accounting_run", {
    p_run_id: row.id,
    p_workspace_id: context.workspaceId,
    p_active_job_id: row.active_job_id ?? null,
    p_liveness_cutoff: livenessCutoff,
    p_reason: reason,
  });
  // The RPC rechecks current heartbeat, status, and active_job_id under a row
  // lock. False means the observed stale state changed before repair arrived.
  if (repairError || repaired !== true) return row;

  const nowIso = new Date().toISOString();

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
    classificationSource: (row.classification_source as AccountingTransaction["classificationSource"]) ?? null,
    classificationStrength: row.classification_strength ?? null,
    classificationConfidence: toNumber(row.classification_confidence ?? null),
    classificationReason: row.classification_reason ?? null,
    normalizedMerchant: row.normalized_merchant ?? null,
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
      // A seeded alias that normalises to something too generic to identify a
      // counterparty must not become a rule. "mr d" is where the production key
      // "d" came from, and it then claimed 425 of 615 rows on a real statement.
      .filter((rule) => {
        const rejection = merchantKeyRejection(rule.merchantKey);
        if (rejection) {
          console.warn("[accounting] merchant alias rejected as a learned rule", { phrase: rule.phrase, key: rule.merchantKey, rejection });
          return false;
        }
        return true;
      })
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
    throw new Error("Upload a bank statement PDF.");
  }

  if (file.size <= 0) {
    throw new Error("The uploaded PDF is empty.");
  }

  if (file.size > accountingMaxUploadBytes) {
    throw new Error("The statement is larger than the 200 MB upload limit.");
  }
}

// Bank-neutral by necessity, not by taste. This used to be ".../accounting/fnb/",
// and the accounting worker folded the storage path into its bank-keyword
// haystack, so the literal "fnb" in every path matched the FNB parser for every
// statement ever uploaded. Detection no longer reads paths at all; the segment
// stays neutral so no future detector can be poisoned by it either.
//
// Runs uploaded before this keeps their old path. Nothing reads the bank out of
// a path any more, so those runs route on their text like everything else.
function accountingStoragePath(workspaceId: string, fileName: string) {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${workspaceId}/accounting/statements/${randomUUID()}-${safeName}`;
}

export async function createFnbAccountingRun(file: File) {
  assertFnbPdf(file);

  const context = await getWorkspaceContext();
  if (!context) {
    throw new Error("Sign in is required to upload accounting statements.");
  }

  const storagePath = accountingStoragePath(context.workspaceId, file.name);
  // At upload nothing has read the PDF yet, so the bank is genuinely not known.
  // It used to be recorded as FNB here — a guess that the UI then displayed as
  // fact, and that survived on every run that failed before the worker could
  // correct it. The worker overwrites both fields from the detected bank.
  const parserProfile = PENDING_PARSER_PROFILE;
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
      tags: ["Accounting Intelligence", "Bank Statement"],
    })
    .select("id")
    .single();

  if (documentError || !document) {
    throw new Error(documentError?.message ?? "Unable to create accounting document.");
  }

  await createDocumentVersionRecord(document.id, storagePath, "Original statement upload");

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
      bank: PENDING_BANK_NAME,
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
    metadata: { runId: run.id, bank: PENDING_BANK_NAME, fileName: file.name },
  });

  await recordAccountingActionAudit({
    action: "statement_uploaded",
    entityType: "accounting_statement_run",
    entityId: run.id,
    newValue: { bank: PENDING_BANK_NAME, parserProfile, fileName: file.name },
  });

  await ensureMerchantKnowledgeBase();

  return mapRun(run as AccountingRunRow);
}

export async function listAccountingRuns() {
  const context = await getWorkspaceContext();
  if (!context) return [];

  await ensureMerchantKnowledgeBase();

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

  await ensureMerchantKnowledgeBase();

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
    // Canonical statement order. source_row is the sequence the parser validated
    // the running-balance chain in; date is not a substitute, because a statement
    // prints several movements per day and their order within the day is what the
    // chain depends on. Ordering by date + created_at produced 513 phantom
    // balance "gaps" on a ledger that actually has none.
    .order("source_row", { ascending: true, nullsFirst: false })
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
  const learningMerchantKeys = deriveLearningMerchantKeys(transaction.description);

  // A learned rule is applied to every future matching transaction in this
  // workspace, so it may only carry a category from the shared vocabulary.
  // Storing an unrecognised or historical spelling here would spread it: the
  // worker would apply it, the dropdown could not offer it back, and the two
  // sides would drift apart again — which is the divergence the canonical
  // vocabulary exists to close.
  //
  // An unresolved category is also not a lesson. "Suspense / Review Required"
  // means nobody decided yet, and teaching it would suppress future review.
  const learnableCategory = canonicaliseCategory(transaction.accountCategory);
  const categoryIsTeachable = learnableCategory !== null && !isUnresolvedAccountingCategory(learnableCategory);
  // Only keys specific enough to identify a counterparty may be taught. A
  // correction on a description that normalises to a generic fragment would
  // otherwise create a rule that claims unrelated transactions forever.
  const safeMerchantKeys = learningMerchantKeys.filter((key) => {
    const rejection = merchantKeyRejection(key);
    if (rejection) console.warn("[accounting] learned key rejected", { key, rejection });
    return !rejection;
  });
  if (shouldLearn && safeMerchantKeys.length && categoryIsTeachable) {
    const { error: learningError } = await context.supabase
      .from("accounting_classification_rules")
      .upsert(
        safeMerchantKeys.map((key) => ({
          workspace_id: context.workspaceId,
          merchant_key: key,
          account_category: learnableCategory,
          vat_treatment: transaction.vatTreatment,
          review_status: transaction.reviewStatus,
          confidence: transaction.reviewStatus === "approved" ? 98 : 92,
          reason: `Learned from accountant correction: ${transaction.accountCategory}.`,
          sample_description: transaction.description,
          created_by: context.userId,
          updated_at: new Date().toISOString(),
          last_used_at: new Date().toISOString(),
        })),
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

/**
 * Tags for every transaction on a run, keyed by transaction id.
 *
 * One query for the whole statement rather than one per row: a 613-transaction
 * statement would otherwise issue 613 requests to render a column.
 */
export async function getRunTransactionTags(runId: string): Promise<Record<string, string[]>> {
  const context = await getWorkspaceContext();
  if (!context) return {};

  // Scoped through the run's own transactions so a tag can only be read via a
  // transaction the caller can already see. RLS enforces the workspace boundary
  // independently; this keeps the query from relying on that alone.
  const { data: transactionRows, error: transactionError } = await context.supabase
    .from("accounting_transactions")
    .select("id")
    .eq("run_id", runId)
    .eq("workspace_id", context.workspaceId);

  if (transactionError || !transactionRows?.length) return {};

  const ids = transactionRows.map((row) => row.id as string);
  const { data, error } = await context.supabase
    .from("accounting_transaction_tags")
    .select("transaction_id, tag")
    .eq("workspace_id", context.workspaceId)
    .in("transaction_id", ids);

  // A missing table (migration 031 not applied) must not blank the statement.
  if (error) {
    if (error.code !== "42P01") console.warn("[accounting] tag read failed", error.message);
    return {};
  }

  const byTransaction: Record<string, string[]> = {};
  for (const row of data ?? []) {
    const key = row.transaction_id as string;
    (byTransaction[key] ??= []).push(row.tag as string);
  }
  for (const key of Object.keys(byTransaction)) byTransaction[key] = sortTags(dedupeTags(byTransaction[key]));
  return byTransaction;
}

/** Every distinct tag in the workspace — the vocabulary offered when tagging. */
export async function getWorkspaceTagVocabulary(): Promise<string[]> {
  const context = await getWorkspaceContext();
  if (!context) return [];
  const { data, error } = await context.supabase
    .from("accounting_transaction_tags")
    .select("tag")
    .eq("workspace_id", context.workspaceId)
    .limit(1000);

  if (error) return [];
  return sortTags(dedupeTags((data ?? []).map((row: { tag: string }) => row.tag)));
}

export async function addTransactionTag(transactionId: string, rawTag: string): Promise<string[]> {
  const context = await getWorkspaceContext();
  if (!context) throw new Error("Unauthorized");
  const tag = normalizeTag(rawTag);
  const rejection = tagRejection(rawTag);
  if (rejection) throw new Error(rejection === "empty" ? "A tag cannot be empty." : `A tag cannot exceed ${MAX_TAG_LENGTH} characters.`);

  // Confirm the transaction is in this workspace before writing. RLS would
  // reject a foreign id anyway, but a 404 is a truthful answer and an RLS
  // rejection surfaced as a 400 is not.
  const { data: transaction } = await context.supabase
    .from("accounting_transactions")
    .select("id")
    .eq("id", transactionId)
    .eq("workspace_id", context.workspaceId)
    .maybeSingle();
  if (!transaction) throw new Error("Transaction not found.");

  const { error } = await context.supabase.from("accounting_transaction_tags").insert({
    workspace_id: context.workspaceId,
    transaction_id: transactionId,
    tag,
    created_by: context.userId,
  });

  // 23505 is the case-insensitive unique index: the tag is already there, which
  // is the state the caller asked for. Re-adding is not an error.
  if (error && error.code !== "23505") throw new Error(error.message);

  await recordAccountingActionAudit({
    action: "transaction_tag_added",
    entityType: "accounting_transaction",
    entityId: transactionId,
    newValue: { tag },
  });

  return listTagsForTransaction(context, transactionId);
}

export async function removeTransactionTag(transactionId: string, rawTag: string): Promise<string[]> {
  const context = await getWorkspaceContext();
  if (!context) throw new Error("Unauthorized");
  const tag = normalizeTag(rawTag);

  const { data: existing } = await context.supabase
    .from("accounting_transaction_tags")
    .select("id, tag")
    .eq("workspace_id", context.workspaceId)
    .eq("transaction_id", transactionId);

  // Matched in JS on the same case-insensitive rule the index uses, so removing
  // "project alpha" removes the stored "Project Alpha".
  const match = (existing ?? []).find((row) => sameTag(row.tag as string, tag));
  if (match) {
    const { error } = await context.supabase
      .from("accounting_transaction_tags")
      .delete()
      .eq("id", match.id as string)
      .eq("workspace_id", context.workspaceId);
    if (error) throw new Error(error.message);

    await recordAccountingActionAudit({
      action: "transaction_tag_removed",
      entityType: "accounting_transaction",
      entityId: transactionId,
      previousValue: { tag: match.tag },
    });
  }

  return listTagsForTransaction(context, transactionId);
}

async function listTagsForTransaction(context: NonNullable<Awaited<ReturnType<typeof getWorkspaceContext>>>, transactionId: string): Promise<string[]> {
  const { data } = await context.supabase
    .from("accounting_transaction_tags")
    .select("tag")
    .eq("workspace_id", context.workspaceId)
    .eq("transaction_id", transactionId);
  return sortTags(dedupeTags((data ?? []).map((row: { tag: string }) => row.tag)));
}

/**
 * Transfer candidates across every statement in the workspace.
 *
 * Cross-run by necessity: a transfer's two legs are recorded on two different
 * statements, so a per-statement query can never see both. The window is bounded
 * by transaction count rather than left open, because this runs on request.
 */
export async function getWorkspaceTransferCandidates(): Promise<{
  candidates: TransferCandidate[];
  decided: Array<{ outboundTransactionId: string; inboundTransactionId: string; status: string }>;
}> {
  const context = await getWorkspaceContext();
  if (!context) return { candidates: [], decided: [] };

  const { data: runRows } = await context.supabase
    .from("accounting_statement_runs")
    .select("id, bank, account_number")
    .eq("workspace_id", context.workspaceId);

  const runs = new Map((runRows ?? []).map((row) => [row.id as string, row]));
  if (runs.size < 2) {
    // One statement cannot contain both legs, so there is nothing to match and
    // no reason to read the transactions at all.
    return { candidates: [], decided: [] };
  }

  const { data: rows } = await context.supabase
    .from("accounting_transactions")
    .select("id, run_id, transaction_date, debit_amount, credit_amount, description")
    .eq("workspace_id", context.workspaceId)
    .order("transaction_date", { ascending: false })
    .limit(5000);

  const sides: TransferSide[] = (rows ?? []).map((row) => {
    const run = runs.get(row.run_id as string);
    const accountNumber = (run?.account_number as string | null) ?? null;
    return {
      transactionId: row.id as string,
      runId: row.run_id as string,
      accountNumber,
      accountLabel: [run?.bank as string | undefined, accountNumber].filter(Boolean).join(" ") || "Unknown account",
      date: (row.transaction_date as string | null) ?? null,
      debit: (row.debit_amount as number | null) ?? null,
      credit: (row.credit_amount as number | null) ?? null,
      description: (row.description as string) ?? "",
    };
  });

  const { data: decisions, error: decisionError } = await context.supabase
    .from("accounting_transfer_matches")
    .select("outbound_transaction_id, inbound_transaction_id, status")
    .eq("workspace_id", context.workspaceId);

  // A missing table (migration 032 not applied) means no decisions yet, not a
  // failure to show candidates.
  if (decisionError && decisionError.code !== "42P01") {
    console.warn("[accounting] transfer decisions unreadable", decisionError.message);
  }

  // Both a confirmation and a rejection take a pair out of circulation: a
  // rejected pair must not be re-offered after every reprocess.
  const decidedIds = new Set<string>();
  for (const row of decisions ?? []) {
    decidedIds.add(row.outbound_transaction_id as string);
    decidedIds.add(row.inbound_transaction_id as string);
  }

  return {
    candidates: bestTransferCandidates(findTransferCandidates(sides, decidedIds)),
    decided: (decisions ?? []).map((row) => ({
      outboundTransactionId: row.outbound_transaction_id as string,
      inboundTransactionId: row.inbound_transaction_id as string,
      status: row.status as string,
    })),
  };
}

export async function decideTransferMatch(input: {
  outboundTransactionId: string;
  inboundTransactionId: string;
  status: "confirmed" | "rejected";
  evidence?: string[];
}): Promise<void> {
  const context = await getWorkspaceContext();
  if (!context) throw new Error("Unauthorized");

  if (input.outboundTransactionId === input.inboundTransactionId) {
    throw new Error("A transaction cannot be transferred to itself.");
  }

  // Both legs must belong to this workspace. RLS enforces it too, but a
  // membership check here produces a truthful 404 instead of a write that
  // silently affects nothing.
  const { data: legs } = await context.supabase
    .from("accounting_transactions")
    .select("id")
    .eq("workspace_id", context.workspaceId)
    .in("id", [input.outboundTransactionId, input.inboundTransactionId]);
  if ((legs ?? []).length !== 2) throw new Error("Transaction not found.");

  const { error } = await context.supabase.from("accounting_transfer_matches").upsert(
    {
      workspace_id: context.workspaceId,
      outbound_transaction_id: input.outboundTransactionId,
      inbound_transaction_id: input.inboundTransactionId,
      status: input.status,
      evidence: input.evidence ?? [],
      decided_by: context.userId,
      decided_at: new Date().toISOString(),
    },
    { onConflict: "outbound_transaction_id,inbound_transaction_id" },
  );
  if (error) throw new Error(error.message);

  // A transfer decision changes reported profit, so it is never anonymous.
  await recordAccountingActionAudit({
    action: input.status === "confirmed" ? "transfer_confirmed" : "transfer_rejected",
    entityType: "accounting_transfer_match",
    entityId: `${input.outboundTransactionId}:${input.inboundTransactionId}`,
    newValue: { status: input.status, evidence: input.evidence ?? [] },
  });
}

/** Undo a decision, returning the pair to the candidate list. */
export async function clearTransferMatch(outboundTransactionId: string, inboundTransactionId: string): Promise<void> {
  const context = await getWorkspaceContext();
  if (!context) throw new Error("Unauthorized");

  const { error } = await context.supabase
    .from("accounting_transfer_matches")
    .delete()
    .eq("workspace_id", context.workspaceId)
    .eq("outbound_transaction_id", outboundTransactionId)
    .eq("inbound_transaction_id", inboundTransactionId);
  if (error) throw new Error(error.message);

  await recordAccountingActionAudit({
    action: "transfer_decision_cleared",
    entityType: "accounting_transfer_match",
    entityId: `${outboundTransactionId}:${inboundTransactionId}`,
  });
}

/**
 * Recurring patterns across every statement in the workspace, with decisions.
 *
 * Cross-run by nature: a monthly commitment only becomes visible once several
 * statements exist, so a per-statement view would show almost nothing.
 */
export async function getWorkspaceRecurringPatterns(): Promise<{
  patterns: RecurringPattern[];
  confirmed: string[];
  dismissed: string[];
}> {
  const context = await getWorkspaceContext();
  if (!context) return { patterns: [], confirmed: [], dismissed: [] };

  const { data: decisions, error: decisionError } = await context.supabase
    .from("accounting_recurring_decisions")
    .select("merchant, status")
    .eq("workspace_id", context.workspaceId);

  // A missing table (migration 033 not applied) means no decisions yet.
  if (decisionError && decisionError.code !== "42P01") {
    console.warn("[accounting] recurring decisions unreadable", decisionError.message);
  }

  const confirmed: string[] = [];
  const dismissed = new Set<string>();
  for (const row of decisions ?? []) {
    const merchant = (row.merchant as string) ?? "";
    if ((row.status as string) === "dismissed") dismissed.add(merchant.trim().toLowerCase());
    else confirmed.push(merchant);
  }

  const { data: rows } = await context.supabase
    .from("accounting_transactions")
    .select("id, normalized_merchant, transaction_date, debit_amount, credit_amount, account_category")
    .eq("workspace_id", context.workspaceId)
    .order("transaction_date", { ascending: false })
    .limit(5000);

  const inputs: RecurringInput[] = (rows ?? []).map((row) => ({
    transactionId: row.id as string,
    merchant: (row.normalized_merchant as string | null) ?? null,
    date: (row.transaction_date as string | null) ?? null,
    debit: (row.debit_amount as number | null) ?? null,
    credit: (row.credit_amount as number | null) ?? null,
    accountCategory: (row.account_category as string) ?? "",
  }));

  return {
    patterns: findRecurringPatterns(inputs, dismissed),
    confirmed,
    dismissed: [...dismissed],
  };
}

export async function decideRecurringPattern(merchant: string, status: "confirmed" | "dismissed", observed?: unknown): Promise<void> {
  const context = await getWorkspaceContext();
  if (!context) throw new Error("Unauthorized");

  const trimmed = merchant.trim();
  if (!trimmed) throw new Error("A merchant is required.");

  const { error } = await context.supabase.from("accounting_recurring_decisions").upsert(
    {
      workspace_id: context.workspaceId,
      merchant: trimmed,
      status,
      observed: observed ?? {},
      decided_by: context.userId,
      decided_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,merchant" },
  );
  if (error) throw new Error(error.message);

  await recordAccountingActionAudit({
    action: status === "confirmed" ? "recurring_confirmed" : "recurring_dismissed",
    entityType: "accounting_recurring_pattern",
    entityId: trimmed,
    newValue: { status },
  });
}

/**
 * Cashflow across every statement in the workspace.
 *
 * Confirmed inter-account transfers are excluded from the totals. Both legs are
 * removed together: dropping only one would leave the gross figures disagreeing
 * with net movement by the transfer amount.
 */
export async function getWorkspaceCashflow(): Promise<{
  summary: CashflowSummary;
  balances: Array<{ accountLabel: string; asAt: string | null; balance: number }>;
}> {
  const context = await getWorkspaceContext();
  const empty = summarizeCashflow([]);
  if (!context) return { summary: empty, balances: [] };

  const { data: runRows } = await context.supabase
    .from("accounting_statement_runs")
    .select("bank, account_number, statement_period_end, closing_balance")
    .eq("workspace_id", context.workspaceId);

  const balances = latestBalancesByAccount(
    (runRows ?? []).map((run) => ({
      accountLabel:
        [run.bank as string | undefined, run.account_number as string | undefined].filter(Boolean).join(" ") ||
        "Unknown account",
      periodEnd: (run.statement_period_end as string | null) ?? null,
      closingBalance: (run.closing_balance as number | null) ?? null,
    })),
  );

  const { data: confirmedRows, error: confirmedError } = await context.supabase
    .from("accounting_transfer_matches")
    .select("outbound_transaction_id, inbound_transaction_id")
    .eq("workspace_id", context.workspaceId)
    .eq("status", "confirmed");

  // A missing table (migration 032 not applied) means no confirmations yet, so
  // nothing is excluded — the totals are then gross, which hasGaps and the
  // excluded count make visible rather than silent.
  if (confirmedError && confirmedError.code !== "42P01") {
    console.warn("[accounting] confirmed transfers unreadable", confirmedError.message);
  }

  const confirmedTransferIds = new Set<string>();
  for (const row of confirmedRows ?? []) {
    confirmedTransferIds.add(row.outbound_transaction_id as string);
    confirmedTransferIds.add(row.inbound_transaction_id as string);
  }

  const { data: rows } = await context.supabase
    .from("accounting_transactions")
    .select("id, transaction_date, debit_amount, credit_amount, account_category, bank_charge")
    .eq("workspace_id", context.workspaceId)
    .order("transaction_date", { ascending: true })
    .limit(10000);

  const inputs: CashflowInput[] = (rows ?? []).map((row) => ({
    transactionId: row.id as string,
    date: (row.transaction_date as string | null) ?? null,
    debit: (row.debit_amount as number | null) ?? null,
    credit: (row.credit_amount as number | null) ?? null,
    accountCategory: (row.account_category as string) ?? "",
    bankCharge: Boolean(row.bank_charge),
  }));

  return { summary: summarizeCashflow(inputs, confirmedTransferIds), balances };
}

/** Statement coverage for the workspace, measured against its engagement. */
export async function getWorkspaceCoverage(): Promise<{
  coverage: CoverageResult;
  engagement: { startDate: string | null; endDate: string | null; expectedAccounts: string[] };
}> {
  const context = await getWorkspaceContext();
  const noEngagement = { startDate: null, endDate: null, expectedAccounts: [] as string[] };
  if (!context) return { coverage: buildCoverage([], { startMonth: null, endMonth: null, expectedAccounts: [] }), engagement: noEngagement };

  const { data: engagementRow, error: engagementError } = await context.supabase
    .from("accounting_engagement")
    .select("start_date, end_date, expected_accounts")
    .eq("workspace_id", context.workspaceId)
    .maybeSingle();

  // A missing table (migration 034 not applied) simply means no engagement is
  // configured, which coverage already handles by reporting interior gaps only.
  if (engagementError && engagementError.code !== "42P01" && engagementError.code !== "PGRST116") {
    console.warn("[accounting] engagement unreadable", engagementError.message);
  }

  const engagement = {
    startDate: (engagementRow?.start_date as string | null) ?? null,
    endDate: (engagementRow?.end_date as string | null) ?? null,
    expectedAccounts: ((engagementRow?.expected_accounts as string[] | null) ?? []).filter(Boolean),
  };

  const { data: runRows } = await context.supabase
    .from("accounting_statement_runs")
    .select("bank, account_number, statement_period_end, closing_balance, opening_balance, transaction_count, status")
    .eq("workspace_id", context.workspaceId);

  const statements: CoverageStatement[] = (runRows ?? [])
    .filter((run) => run.statement_period_end)
    .map((run) => {
      const closing = (run.closing_balance as number | null) ?? null;
      return {
        accountLabel:
          [run.bank as string | undefined, run.account_number as string | undefined].filter(Boolean).join(" ") ||
          "Unknown account",
        month: String(run.statement_period_end).slice(0, 7),
        // "Reconciled" here means the statement completed AND a closing balance
        // was established. A run still in review has not proven anything.
        reconciled: (run.status as string) === "completed" && closing != null,
        hasClosingBalance: closing != null,
        transactionCount: (run.transaction_count as number | null) ?? 0,
      };
    });

  return {
    coverage: buildCoverage(statements, {
      startMonth: engagement.startDate ? engagement.startDate.slice(0, 7) : null,
      endMonth: engagement.endDate ? engagement.endDate.slice(0, 7) : null,
      expectedAccounts: engagement.expectedAccounts,
    }),
    engagement,
  };
}

export async function saveWorkspaceEngagement(input: {
  startDate: string | null;
  endDate: string | null;
  expectedAccounts: string[];
}): Promise<void> {
  const context = await getWorkspaceContext();
  if (!context) throw new Error("Unauthorized");

  if (input.startDate && input.endDate && input.startDate > input.endDate) {
    throw new Error("The engagement start date must not be after the end date.");
  }

  const { error } = await context.supabase.from("accounting_engagement").upsert(
    {
      workspace_id: context.workspaceId,
      start_date: input.startDate,
      end_date: input.endDate,
      expected_accounts: input.expectedAccounts.map((account) => account.trim()).filter(Boolean),
      updated_by: context.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id" },
  );
  if (error) throw new Error(error.message);

  // Changing the engagement changes which statements are considered owed, so
  // it is recorded like any other decision that moves a reported figure.
  await recordAccountingActionAudit({
    action: "engagement_updated",
    entityType: "accounting_engagement",
    entityId: context.workspaceId,
    newValue: input as unknown as Record<string, unknown>,
  });
}

/**
 * Flow of funds across the workspace, or the reason one would mislead.
 *
 * Confirmed transfers are excluded for the same reason as in cashflow: internal
 * movement is neither a source of funds nor a use of them.
 */
export async function getWorkspaceFlowOfFunds(): Promise<FlowOfFunds> {
  const context = await getWorkspaceContext();
  if (!context) return buildFlowOfFunds([]);

  const { data: confirmedRows, error: confirmedError } = await context.supabase
    .from("accounting_transfer_matches")
    .select("outbound_transaction_id, inbound_transaction_id")
    .eq("workspace_id", context.workspaceId)
    .eq("status", "confirmed");

  if (confirmedError && confirmedError.code !== "42P01") {
    console.warn("[accounting] confirmed transfers unreadable", confirmedError.message);
  }

  const confirmedTransferIds = new Set<string>();
  for (const row of confirmedRows ?? []) {
    confirmedTransferIds.add(row.outbound_transaction_id as string);
    confirmedTransferIds.add(row.inbound_transaction_id as string);
  }

  const { data: rows } = await context.supabase
    .from("accounting_transactions")
    .select("id, debit_amount, credit_amount, account_category")
    .eq("workspace_id", context.workspaceId)
    .limit(10000);

  const inputs: FlowInput[] = (rows ?? []).map((row) => ({
    transactionId: row.id as string,
    debit: (row.debit_amount as number | null) ?? null,
    credit: (row.credit_amount as number | null) ?? null,
    accountCategory: (row.account_category as string) ?? "",
  }));

  return buildFlowOfFunds(inputs, { confirmedTransferIds });
}

/**
 * Cash forecast for the workspace.
 *
 * The join that makes this honest: recurring patterns are recomputed, then
 * filtered to those a person has CONFIRMED. A detected pattern is a hypothesis
 * and never reaches buildCashForecast — which is why the confirm store from
 * migration 033 exists.
 */
export async function getWorkspaceForecast(today: string): Promise<CashForecast> {
  const context = await getWorkspaceContext();
  if (!context) {
    return buildCashForecast({
      openingBalance: null,
      openingBalanceAsAt: null,
      confirmedCommitments: [],
      averageMonthlyInflow: null,
      monthsObserved: 0,
      today,
    });
  }

  const [{ patterns, confirmed }, cashflow] = await Promise.all([
    getWorkspaceRecurringPatterns(),
    getWorkspaceCashflow(),
  ]);

  const confirmedKeys = new Set(confirmed.map((merchant) => merchant.trim().toLowerCase()));
  const confirmedCommitments = patterns
    .filter((pattern) => confirmedKeys.has(pattern.merchant.trim().toLowerCase()))
    .map((pattern) => ({
      merchant: pattern.merchant,
      averageAmount: pattern.averageAmount,
      medianIntervalDays: pattern.medianIntervalDays,
      nextExpected: pattern.nextExpected,
      frequency: pattern.frequency,
      confidence: pattern.confidence,
    }));

  // The most recent balance across accounts, with the date it was true. Not a
  // sum: latestBalancesByAccount deliberately refuses to add balances whose
  // statements end on different dates.
  const newest = [...cashflow.balances]
    .filter((balance) => balance.asAt)
    .sort((a, b) => (b.asAt ?? "").localeCompare(a.asAt ?? ""))[0];

  return buildCashForecast({
    openingBalance: newest?.balance ?? null,
    openingBalanceAsAt: newest?.asAt ?? null,
    confirmedCommitments,
    averageMonthlyInflow: cashflow.summary.averageMonthlyInflow || null,
    monthsObserved: cashflow.summary.monthsObserved,
    today,
  });
}

export type AccountingAuditEntry = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  previousValue: unknown;
  newValue: unknown;
  createdAt: string;
};

/**
 * Read the accounting audit trail.
 *
 * accounting_action_audit has been written since migration 005 — by transaction
 * edits, and now by tag changes, transfer decisions, recurring confirmations and
 * engagement updates — but nothing has ever read it back. A trail that cannot be
 * inspected is a log file, not an audit trail.
 */
export async function getAccountingAuditTrail(options: { entityId?: string; limit?: number } = {}): Promise<AccountingAuditEntry[]> {
  const context = await getWorkspaceContext();
  if (!context) return [];

  let query = context.supabase
    .from("accounting_action_audit")
    .select("id, action, entity_type, entity_id, previous_value, new_value, created_at")
    .eq("workspace_id", context.workspaceId)
    .order("created_at", { ascending: false })
    .limit(Math.min(options.limit ?? 200, 500));

  if (options.entityId) query = query.eq("entity_id", options.entityId);

  const { data, error } = await query;

  // A missing table must not break the page that shows it.
  if (error) {
    if (error.code !== "42P01") console.warn("[accounting] audit trail unreadable", error.message);
    return [];
  }

  return (data ?? []).map((row) => ({
    id: row.id as string,
    action: row.action as string,
    entityType: row.entity_type as string,
    entityId: row.entity_id as string,
    previousValue: row.previous_value ?? null,
    newValue: row.new_value ?? null,
    createdAt: row.created_at as string,
  }));
}
