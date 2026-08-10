import { NextResponse, after } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { bankDetectionHints, detectBankFromText } from "@/lib/accounting/engine/bank-detection";
import { isNoTransactionsFailure } from "@/lib/accounting/workerFailure";
import { getAccountingRunDetail } from "@/lib/accounting/server";
import { getWorkspaceContext } from "@/lib/server-documents";
import { runExtractionPipeline } from "@/lib/pdf/runExtractionPipeline";
import { computeFileHash } from "@/lib/pdf/extractionCache";
import { extractWithAzureDocumentIntelligence } from "@/lib/pdf/extractWithAzureDocumentIntelligence";
import { compareExtractions, decideShadowSample } from "@/lib/pdf/shadowComparison";
import { reconciliationConfidence } from "@/lib/accounting/confidence";
import { pdfLog } from "@/lib/pdf/log";
import { PROCESSING_STEP_LABELS, PROCESSING_STEP_PROGRESS, type ProcessingStep } from "@/lib/pdf/processingSteps";
import { buildWorkerInput, extractionProcessingMetadata } from "@/lib/pdf/workerHandoff";
import { buildWorkerEndpoint, createWorkerRequestId, getWorkerConfig, logWorkerStartupCheck } from "@/lib/system-worker-config";
import type { WorkspaceContext } from "@/lib/server-documents";
import type { AccountingRunDetail } from "@/lib/accounting/types";

// Auto-run the multi-parser extraction pipeline before the worker: analyse the
// PDF, choose the best source, persist the summary, and hand the worker the best
// extracted text (keeping the original PDF as a fallback). Fully defensive — any
// failure here falls back to the original worker path with a recorded warning.
type PipelineDebug = {
  selectedParser: string;
  parserMethod: string;
  ocrUsed: boolean;
  detectedPdfType: string;
  detectedBank: string;
  detectedBankConfidence: number;
  extractionConfidence: number;
  pdfjsTextLength: number;
  pdfplumberTextLength: number;
  ocrTextLength: number;
  mistralTextLength: number;
  azureTextLength: number;
  preExtractedTextLength: number;
  sampleText: string;
  reasonNoTransactions: string | null;
  ocr: Record<string, unknown> | null;
  mistral: Record<string, unknown> | null;
  azure: Record<string, unknown> | null;
  strategy: string;
  ocrEngine: string | null;
  verdict: string;
  ocrEngineComparison: unknown[];
  disagreements: unknown[];
  stages: unknown[];
};

async function runPipelineBeforeWorker(
  context: WorkspaceContext,
  detail: AccountingRunDetail,
  options: { force: boolean; enhancedOcr?: boolean; onStage: (step: ProcessingStep) => void },
): Promise<{ hints: Record<string, unknown>; warning: string | null; debug: PipelineDebug | null }> {
  const runId = detail.run.id;
  try {
    const { data: file, error } = await context.supabase.storage.from("documents").download(detail.run.sourceStoragePath);
    if (error || !file) {
      return { hints: {}, warning: `Extraction pipeline skipped: source unavailable (${error?.message ?? "no file"}).`, debug: null };
    }
    const buffer = new Uint8Array(await file.arrayBuffer());
    // Cache identity: same document + identical bytes reuses the prior extraction
    // (incl. OCR text) unless this is a Force reprocess (Req 3).
    const fileHash = computeFileHash(buffer);
    const pipeline = await runExtractionPipeline(buffer, detail.run.sourceStoragePath.split("/").pop() || "statement.pdf", {
      documentId: detail.run.documentId,
      fileHash,
      force: options.force,
      enhancedOcr: options.enhancedOcr,
      // Explicit, though it is also the default: this path IS a bank statement,
      // so completeness and reconciliation must gate acceptance.
      expect: "bank_statement",
      onStage: options.onStage,
    });
    const meta = extractionProcessingMetadata(pipeline);
    const workerInput = buildWorkerInput(pipeline);
    // Which bank issued this statement, decided from the extracted text — the
    // merged best source across pdfjs / pdfplumber / Azure / Mistral. The worker
    // re-detects from its own text; sending this lets it see both verdicts,
    // because the two sides do not always read the same characters.
    const bankDetection = detectBankFromText(workerInput.preExtractedText);

    // Persist the pipeline summary (separate update so a missing migration never
    // blocks worker processing — the metadata is simply not stored until applied).
    const { error: updateError } = await context.supabase
      .from("accounting_statement_runs")
      .update({
        parser_method: meta.selectedParser,
        extraction_confidence: meta.extractionConfidence,
        detected_pdf_type: meta.detectedPdfType,
        ocr_used: meta.ocrUsed,
        route_reason: pipeline.routeReason,
        extraction_warnings: meta.warnings,
        validation_status: meta.validationStatus,
        reconciliation_difference: meta.reconciliationDifference,
        missing_transaction_count: meta.missingTransactionCount,
        requires_review: pipeline.requiresReview,
        // Migration 017 — engine provenance. Written in the same best-effort
        // update; a missing migration warns and processing continues.
        ocr_engine: meta.ocrEngine,
        extraction_strategy: meta.strategy,
        acceptance_verdict: meta.verdict,
        ocr_engine_comparison: meta.ocrEngineComparison,
        updated_at: new Date().toISOString(),
      })
      .eq("workspace_id", context.workspaceId)
      .eq("id", runId);
    if (updateError) {
      console.warn("[accounting/process] extraction metadata not persisted (migration 013/017 not applied?)", { runId, error: updateError.message });
      // Retry without the migration-017 columns so the 013/014 metadata still lands.
      await context.supabase
        .from("accounting_statement_runs")
        .update({
          parser_method: meta.selectedParser,
          extraction_confidence: meta.extractionConfidence,
          detected_pdf_type: meta.detectedPdfType,
          ocr_used: meta.ocrUsed,
          route_reason: pipeline.routeReason,
          extraction_warnings: meta.warnings,
          validation_status: meta.validationStatus,
          reconciliation_difference: meta.reconciliationDifference,
          missing_transaction_count: meta.missingTransactionCount,
          requires_review: pipeline.requiresReview,
          updated_at: new Date().toISOString(),
        })
        .eq("workspace_id", context.workspaceId)
        .eq("id", runId);
    }

    const debug: PipelineDebug = {
      selectedParser: meta.selectedParser,
      parserMethod: meta.selectedParser,
      ocrUsed: meta.ocrUsed,
      detectedPdfType: meta.detectedPdfType,
      detectedBank: bankDetection.profileId,
      detectedBankConfidence: bankDetection.confidence,
      extractionConfidence: meta.extractionConfidence,
      pdfjsTextLength: pipeline.debug.pdfjsTextLength,
      pdfplumberTextLength: pipeline.debug.pdfplumberTextLength,
      ocrTextLength: pipeline.debug.ocrTextLength,
      mistralTextLength: pipeline.debug.mistralTextLength,
      azureTextLength: pipeline.debug.azureTextLength,
      preExtractedTextLength: pipeline.debug.preExtractedTextLength,
      sampleText: pipeline.debug.sampleText,
      reasonNoTransactions: pipeline.debug.reasonNoTransactions,
      ocr: pipeline.debug.ocr,
      mistral: pipeline.debug.mistral,
      azure: pipeline.debug.azure,
      strategy: pipeline.strategy,
      ocrEngine: pipeline.ocrEngine,
      verdict: pipeline.verdict,
      ocrEngineComparison: pipeline.ocrEngineComparison,
      disagreements: pipeline.selection.disagreements,
      stages: pipeline.debug.stages,
    };

    // Detailed log immediately before handing off to the worker.
    console.info("[accounting/process] extraction pipeline result", {
      runId,
      strategy: pipeline.strategy,
      parserMethod: meta.selectedParser,
      verdict: pipeline.verdict,
      ocrUsed: meta.ocrUsed,
      ocrEngine: pipeline.ocrEngine,
      ocrEngineComparison: pipeline.ocrEngineComparison,
      detectedPdfType: meta.detectedPdfType,
      extractionConfidence: meta.extractionConfidence,
      pdfjsTextLength: pipeline.debug.pdfjsTextLength,
      pdfplumberTextLength: pipeline.debug.pdfplumberTextLength,
      ocrTextLength: pipeline.debug.ocrTextLength,
      mistralTextLength: pipeline.debug.mistralTextLength,
      azureTextLength: pipeline.debug.azureTextLength,
      preExtractedTextLength: workerInput.preExtractedText.length,
      transactionCandidates: workerInput.transactionCandidateCount,
      structuredRowCount: workerInput.structuredRowCount ?? 0,
      structuredProvider: workerInput.structuredProvider ?? null,
      detectedBank: bankDetection.profileId,
      detectedBankConfidence: bankDetection.confidence,
      detectedBankReason: bankDetection.reason,
      detectedBankEvidence: bankDetection.evidence,
      reasonNoTransactions: pipeline.debug.reasonNoTransactions,
      disagreements: pipeline.selection.disagreements.map((d) => d.field),
      ocr: pipeline.debug.ocr,
      mistral: pipeline.debug.mistral,
      azure: pipeline.debug.azure,
    });

    // Hand the worker the best source; it keeps the original PDF as a fallback.
    const hints: Record<string, unknown> = {
      parser_method: meta.selectedParser,
      extraction_source: workerInput.parser,
      ocr_used: meta.ocrUsed,
      extraction_debug: debug,
      // Always sent, `unknown` included: the worker must be able to tell "this
      // side looked and found nothing" from "this side is an older deploy that
      // did not look at all", which arrives as null.
      ...bankDetectionHints(bankDetection),
    };
    if (workerInput.useProvidedText && workerInput.preExtractedText.trim()) {
      hints.pre_extracted_text = workerInput.preExtractedText;
    }
    if (workerInput.preExtractedRows && workerInput.preExtractedRows.length > 0) {
      hints.extraction_format_version = workerInput.extractionFormatVersion;
      hints.pre_extracted_rows = workerInput.preExtractedRows;
      hints.structured_provider = workerInput.structuredProvider;
      hints.structured_row_continuity = workerInput.structuredRowContinuity;
      hints.structured_page_count = workerInput.structuredPageCount;
      hints.structured_row_count = workerInput.structuredRowCount;
      hints.structured_diagnostics = workerInput.structuredDiagnostics;
    }
    return { hints, warning: null, debug };
  } catch (pipelineError) {
    const message = pipelineError instanceof Error ? pipelineError.message : String(pipelineError);
    console.warn("[accounting/process] extraction pipeline failed — using original worker path", { runId, error: message });
    return { hints: {}, warning: `Extraction pipeline error: ${message}`, debug: null };
  }
}

// Shadow mode (Phase C). Opt-IN: set ACCOUNTING_SHADOW_AZURE=true to enable.
// Default off so nothing changes until the observation is deliberately started.
const SHADOW_AZURE_ENABLED = process.env.ACCOUNTING_SHADOW_AZURE === "true";

/**
 * Re-run Azure Document Intelligence against a statement the pipeline ALREADY
 * accepted, compare the two extractions, and record the result.
 *
 * Purely observational. Called after the workbook exists, wrapped so that any
 * failure — Azure down, comparison bug, missing migration — is logged and
 * discarded. It returns nothing and mutates no run field.
 */
async function runShadowComparison(context: WorkspaceContext, detail: AccountingRunDetail, pipelineDebug: PipelineDebug | null): Promise<void> {
  if (!SHADOW_AZURE_ENABLED) return;
  const runId = detail.run.id;
  try {
    // Only meaningful when the pipeline actually ran and produced a winner. If
    // Azure already ran in the ladder there is nothing to shadow.
    if (!pipelineDebug || pipelineDebug.ocrEngine === "azure_di") {
      pdfLog("shadow.skipped", { runId, reason: pipelineDebug ? "azure already ran in the ladder" : "no pipeline result" });
      return;
    }

    const { data: file, error } = await context.supabase.storage.from("documents").download(detail.run.sourceStoragePath);
    if (error || !file) return;
    const buffer = new Uint8Array(await file.arrayBuffer());
    const fileName = detail.run.sourceStoragePath.split("/").pop() || "statement.pdf";

    // Re-derive the adopted extraction from the SAME cached pipeline result the
    // run used, so the comparison baseline is exactly what shipped.
    const adopted = await runExtractionPipeline(buffer, fileName, {
      documentId: detail.run.documentId,
      fileHash: computeFileHash(buffer),
      expect: "bank_statement",
    });

    // Sampling gate — only spend an Azure call where it could realistically help.
    const reconConfidence = reconciliationConfidence(adopted.validation);
    const sampleDecision = decideShadowSample({
      extractionConfidence: adopted.selection.confidence,
      reconciliationConfidence: reconConfidence,
      reconciliationDifference: adopted.validation?.difference ?? null,
      missingTransactionCount: adopted.validation?.missingTransactionCount ?? null,
      merged: adopted.merged,
      // Extraction-level review ONLY. The worker's per-transaction review flags
      // are classification decisions Azure cannot influence.
      extractionRequiresReview: !adopted.accepted,
    });

    const baseRow = {
      workspace_id: context.workspaceId,
      run_id: runId,
      document_id: detail.run.documentId,
      current_provider: adopted.parserMethod,
      extraction_confidence: adopted.selection.confidence,
      reconciliation_confidence: reconConfidence,
      reconciliation_difference: adopted.validation?.difference ?? null,
    };

    if (!sampleDecision.sample) {
      // Record the skip — a skipped run is evidence too — and never call Azure.
      pdfLog("shadow.skipped_by_gate", { runId, reason: sampleDecision.reason });
      const { error: skipError } = await context.supabase.from("extraction_shadow_comparisons").insert({
        ...baseRow,
        azure_available: false,
        would_azure_have_been_better: false,
        shadow_skipped: true,
        shadow_skip_reason: sampleDecision.reason,
        reason: "Skipped by the sampling gate — Azure not called.",
        metrics: [],
      });
      if (skipError) console.warn("[accounting/shadow] skip not recorded (migration 018/020 not applied?)", { runId, error: skipError.message });
      return;
    }

    const started = Date.now();
    const azure = await extractWithAzureDocumentIntelligence(buffer, fileName);
    const durationMs = Date.now() - started;

    const comparison = compareExtractions(adopted.merged, azure, adopted.parserMethod);
    pdfLog("shadow.comparison", {
      runId,
      currentProvider: comparison.currentProvider,
      azureAvailable: comparison.azureAvailable,
      wouldAzureHaveBeenBetter: comparison.wouldAzureHaveBeenBetter,
      reason: comparison.reason,
      sampleReason: sampleDecision.reason,
      score: comparison.score,
      durationMs,
    });

    const { error: insertError } = await context.supabase.from("extraction_shadow_comparisons").insert({
      ...baseRow,
      current_provider: comparison.currentProvider,
      shadow_skipped: false,
      sample_reason: sampleDecision.reason,
      azure_available: comparison.azureAvailable,
      would_azure_have_been_better: comparison.wouldAzureHaveBeenBetter,
      reason: comparison.reason,
      metrics: comparison.metrics,
      score: comparison.score,
      azure_debug: (azure?.metadata?._azureDebug as Record<string, unknown> | undefined) ?? null,
      azure_duration_ms: durationMs,
    });
    if (insertError) {
      console.warn("[accounting/shadow] comparison not persisted (migration 018 not applied?)", { runId, error: insertError.message });
    }
  } catch (shadowError) {
    // Never surface: the run has already succeeded.
    console.warn("[accounting/shadow] comparison failed — run unaffected", {
      runId,
      error: shadowError instanceof Error ? shadowError.message : String(shadowError),
    });
  }
}

type ProcessBody = {
  runId?: string;
  // Set by manual Re-process to rerun extraction even if a job is in flight or the
  // run already completed. Auto-processing after upload leaves this false.
  reprocess?: boolean;
};

type WorkerResponseBody = {
  detail?: unknown;
  error?: string;
  status?: string;
  worker?: unknown;
  [key: string]: unknown;
};

function getWorkerError(result: WorkerResponseBody, responseText: string, status: number) {
  if (typeof result.error === "string" && result.error) {
    return result.error;
  }

  if (typeof result.detail === "string" && result.detail) {
    return result.detail;
  }

  if (Array.isArray(result.detail)) {
    return result.detail
      .map((item) => {
        if (item && typeof item === "object") {
          const record = item as { loc?: unknown; msg?: unknown; type?: unknown };
          const loc = Array.isArray(record.loc) ? record.loc.join(".") : "field";
          return `${loc}: ${String(record.msg ?? record.type ?? "Invalid value")}`;
        }
        return String(item);
      })
      .join("; ");
  }

  if (result.detail && typeof result.detail === "object") {
    return JSON.stringify(result.detail);
  }

  if (responseText.trim()) {
    return `Accounting worker returned HTTP ${status}: ${responseText.slice(0, 800)}`;
  }

  return `Accounting worker returned HTTP ${status} without an error body. Check Render worker logs for this run.`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function describeWorkerVersion(worker: unknown) {
  const record = asRecord(worker);
  if (!record) return null;
  const service = typeof record.service === "string" ? record.service : null;
  const commit = typeof record.commit === "string" ? record.commit : null;
  const serviceId = typeof record.render_service_id === "string" ? record.render_service_id : null;
  if (!service && !commit && !serviceId) return null;
  return { service, commit, serviceId };
}

function normalizeWorkerFailure(input: {
  status: number;
  message: string;
  workerUrl: string;
  workerEndpoint: string;
  worker: unknown;
}) {
  const detail = input.message.trim();
  const isNotFound = input.status === 404 && (detail === "Not Found" || detail.toLowerCase() === "not found");
  const workerMeta = describeWorkerVersion(input.worker);
  const workerMetaSuffix = workerMeta
    ? ` Worker reported service=${workerMeta.service ?? "unknown"} commit=${workerMeta.commit ?? "unknown"} service_id=${workerMeta.serviceId ?? "unknown"}.`
    : "";

  if (isNotFound) {
    return `Accounting worker endpoint not found at ${input.workerEndpoint}. ACCOUNTING_WORKER_URL is misconfigured (current: ${input.workerUrl}).${workerMetaSuffix}`;
  }

  // The worker's auth fails closed, so these two statuses mean a configuration
  // mismatch, not a bad statement. Say so — otherwise an operator reads
  // "Invalid credentials" on an upload screen and goes looking at the PDF.
  if (input.status === 503 && /not configured for authenticated access/i.test(detail)) {
    return `Accounting worker has no ACCOUNTING_WORKER_TOKEN configured, so it is refusing all requests. Set it on the worker service.${workerMetaSuffix}`;
  }
  if (input.status === 401) {
    return `Accounting worker rejected our credentials. ACCOUNTING_WORKER_TOKEN must be set to the same value here and on the worker service.${workerMetaSuffix}`;
  }

  return `${detail || `Accounting worker returned HTTP ${input.status}.`} (endpoint: ${input.workerEndpoint}).${workerMetaSuffix}`;
}

// The CEILING for a single worker call. The real limit is whatever remains of
// the request budget below — a call gets min(this, remaining), so the first
// attempt cannot starve the Enhanced-OCR retry and no attempt can outlive the
// function.
//
// It was 120s, which aborted the worker less than half way into the window the
// function is allowed: production showed /api/accounting/fnb/process giving up
// on a statement that had not failed, only taken longer than an arbitrary
// limit. All three Render services are Starter and always-on, so this was never
// a cold-start workaround.
const ACCOUNTING_WORKER_TIMEOUT_MS = 280_000;

// Everything in one request shares maxDuration: pre-extraction, the worker call,
// and — on the Enhanced-OCR fallback — a second pipeline run and a second worker
// call. Bounding each stage independently cannot prevent the total exceeding the
// function's lifetime, so the stages are measured against one deadline instead.
//
// 280s of the 300s below, leaving ~20s for response handling and cleanup. When a
// stage starts, it gets what is left; when too little is left to be worth
// starting, it fails with a diagnosable message rather than being killed
// mid-flight by the platform.
const ACCOUNTING_REQUEST_BUDGET_MS = 280_000;

// Below this there is no point dispatching to the worker: the statement cannot
// realistically parse in the time left, and a doomed request costs the worker
// real work and returns nothing.
const ACCOUNTING_MIN_WORKER_SLICE_MS = 20_000;
// Every document is analysed before extraction, so the pipeline now runs by
// default. The strategy keeps this affordable: a genuine digital statement takes
// the "native" path and never calls OCR. Set ACCOUNTING_PRE_EXTRACT=false to
// restore the previous bypass as an emergency kill switch.
const ACCOUNTING_PRE_EXTRACT_ENABLED = process.env.ACCOUNTING_PRE_EXTRACT !== "false";
// Safety net: when the Python worker cannot parse any transactions the document
// is almost certainly scanned, so re-run with Enhanced OCR and retry once.
const ACCOUNTING_OCR_FALLBACK_ENABLED = process.env.ACCOUNTING_OCR_FALLBACK !== "false";

// Allow the background work (after the response is sent) to run beyond the default
// so extraction + worker + reconciliation can finish off the request path.
//
// 300s is the budget for EVERYTHING in this request, not just the worker call:
//   1. runExtractionPipeline pre-extraction (on by default; OCR, Mistral and
//      Azure each carry their own 120s ceiling)
//   2. callWorker — min(ACCOUNTING_WORKER_TIMEOUT_MS, budget remaining)
//   3. on the Enhanced-OCR fallback, a second pipeline run AND a second
//      callWorker, taking what is left
// The stages share one deadline (ACCOUNTING_REQUEST_BUDGET_MS, set when the
// background work starts), so time spent earlier shortens what later stages may
// take and the total cannot outlive the function. Before that, each stage was
// bounded independently and 280 + 280 could exceed 300 — the platform killed the
// function mid-flight and the failure arrived with no diagnosable message.
export const maxDuration = 300;

function toParserDebug(pipelineDebug: PipelineDebug | null) {
  if (!pipelineDebug) return null;
  return {
    selected_parser: pipelineDebug.selectedParser,
    detected_pdf_type: pipelineDebug.detectedPdfType,
    ocr_used: pipelineDebug.ocrUsed,
    extraction_confidence: pipelineDebug.extractionConfidence,
    pdfjs_text_length: pipelineDebug.pdfjsTextLength,
    pdfplumber_text_length: pipelineDebug.pdfplumberTextLength,
    ocr_text_length: pipelineDebug.ocrTextLength,
    mistral_text_length: pipelineDebug.mistralTextLength,
    azure_text_length: pipelineDebug.azureTextLength,
    pre_extracted_text_length: pipelineDebug.preExtractedTextLength,
    sample_text: pipelineDebug.sampleText,
    reason_no_transactions: pipelineDebug.reasonNoTransactions,
    ocr: pipelineDebug.ocr,
    mistral: pipelineDebug.mistral,
    azure: pipelineDebug.azure,
    extraction_strategy: pipelineDebug.strategy,
    ocr_engine: pipelineDebug.ocrEngine,
    acceptance_verdict: pipelineDebug.verdict,
    ocr_engine_comparison: pipelineDebug.ocrEngineComparison,
    disagreements: pipelineDebug.disagreements,
    stages: pipelineDebug.stages,
  };
}

// All heavy work — extraction pipeline (PDF.js / pdfplumber / OCR), the accounting
// worker call, reconciliation and status updates — runs HERE, after the HTTP
// response has already been returned. Nothing below blocks the user's request.
async function processStatementInBackground(
  context: WorkspaceContext,
  detail: AccountingRunDetail,
  workerUrl: string,
  runId: string,
  jobId: string | null,
  force: boolean,
) {

  // One deadline for the whole request. Every stage measures against it, so
  // pre-extraction spending time necessarily shortens what the worker call may
  // take, and a first attempt that runs long leaves the retry a smaller slice
  // rather than pushing the function past its lifetime.
  const deadlineAt = Date.now() + ACCOUNTING_REQUEST_BUDGET_MS;
  const remainingBudgetMs = () => deadlineAt - Date.now();

  // Report the current processing step so the UI can show it with an elapsed
  // timer. Writes the human label to the run (processing_step) and mirrors it to
  // the processing job's message/progress. Best-effort: a missing column (Req:
  // migration 014 not yet applied) or transient error never blocks processing.
  const updateStep = (step: ProcessingStep) => {
    const label = PROCESSING_STEP_LABELS[step];
    const progress = PROCESSING_STEP_PROGRESS[step];
    void context.supabase
      .from("accounting_statement_runs")
      .update({ processing_step: label, updated_at: new Date().toISOString() })
      .eq("workspace_id", context.workspaceId)
      .eq("id", runId)
      .then(({ error }) => {
        if (error) console.warn("[accounting/process] processing_step not persisted (migration 014 not applied?)", { runId, step: label, error: error.message });
      });
    if (jobId) {
      // Same reason as above: this reports PROGRESS during pre-extraction and
      // must not touch status, which is the worker's claim.
      void context.supabase
        .from("processing_jobs")
        .update({ progress, message: label, updated_at: new Date().toISOString() })
        .eq("id", jobId)
        .then(() => undefined);
    }
  };

  // The key parser-debug fields (parser_method, detected_pdf_type, ocr_used,
  // validation_status, reconciliation_difference, requires_review, route_reason)
  // are persisted on the run by runPipelineBeforeWorker; here we set the failure
  // reason and log the full parserDebug.
  const failRun = async (error: string, parserDebug: ReturnType<typeof toParserDebug>) => {
    // THE OWNERSHIP RULE. Once the worker has accepted the job, this function no
    // longer decides the run's fate — the worker does, and it writes its own
    // terminal state. Marking the run failed here is exactly the defect this
    // change exists to remove: extraction finished, the caller stopped waiting,
    // and finished work was recorded as a failure.
    if (jobAccepted) {
      console.info("[accounting/process] not failing an accepted job", { runId, error });
      return;
    }
    console.warn("[accounting/process] marking run failed", { runId, error, parserDebug });
    const nowIso = new Date().toISOString();
    // Persist the full parser/OCR debug alongside the failure so the workspace can
    // show the real reason (not just "Failed 0%"). Best-effort: if migration 015
    // (parser_debug) is not yet applied, retry the essential status/error update
    // without it so the run is still correctly marked failed.
    const { error: failError } = await context.supabase
      .from("accounting_statement_runs")
      .update({ status: "failed", error, parser_debug: parserDebug ?? null, processing_step: "Stuck / Needs retry", updated_at: nowIso })
      .eq("workspace_id", context.workspaceId)
      .eq("id", runId);
    if (failError) {
      console.warn("[accounting/process] parser_debug not persisted (migration 015 not applied?)", { runId, error: failError.message });
      await context.supabase
        .from("accounting_statement_runs")
        .update({ status: "failed", error, processing_step: "Stuck / Needs retry", updated_at: nowIso })
        .eq("workspace_id", context.workspaceId)
        .eq("id", runId);
    }
    if (jobId) {
      await context.supabase
        .from("processing_jobs")
        .update({ status: "failed", progress: 100, message: error, error, updated_at: new Date().toISOString() })
        .eq("id", jobId);
    }
  };

  // Dispatch, not synchronous processing. The worker validates, claims the job
  // and answers 202; everything after that belongs to it. /process-statement is
  // unchanged for any caller that still wants to wait.
  const workerEndpoint = buildWorkerEndpoint(workerUrl, "/process-statement/dispatch");

  // Set once the worker has accepted. From that point this function must never
  // write a terminal state: its own timeout, disconnect or after() ending is no
  // longer the run's problem. Guarded inside failRun so no path can miss it.
  let jobAccepted = false;

  // One attempt at the accounting worker. Returns a discriminated outcome so the
  // caller can decide whether an OCR-backed retry is worthwhile.
  type WorkerOutcome =
    | { kind: "accepted" }
    | { kind: "ok" }
    | { kind: "failed"; status: number; error: string }
    | { kind: "unreachable"; error: string };

  const callWorker = async (hints: Record<string, unknown>): Promise<WorkerOutcome> => {
    const workerPayload = {
      run_id: runId,
      workspace_id: context.workspaceId,
      document_id: detail.run.documentId,
      processing_job_id: jobId,
      storage_path: detail.run.sourceStoragePath,
      ...hints,
    };
    const requestId = createWorkerRequestId("acct_process");
    console.info("docucorex.accounting.worker.request", {
      requestId,
      resolvedAccountingWorkerUrl: workerUrl,
      endpoint: workerEndpoint,
      runId,
      // The parser is chosen by the worker from the statement text; there is
      // nothing to declare here that would not be a guess.
      declaredBank: detail.run.bank,
    });

    // The ceiling, or whatever is left of the request budget — whichever is
    // smaller. Refuse outright when the remainder is too small to be useful:
    // dispatching costs the worker a full parse and returns nothing, and the
    // caller gets a message it can act on instead of a killed function.
    const sliceMs = Math.min(ACCOUNTING_WORKER_TIMEOUT_MS, remainingBudgetMs());
    if (sliceMs < ACCOUNTING_MIN_WORKER_SLICE_MS) {
      const message =
        `Ran out of processing time before the accounting worker could be called ` +
        `(${Math.max(0, Math.round(remainingBudgetMs() / 1000))}s left of a ` +
        `${ACCOUNTING_REQUEST_BUDGET_MS / 1000}s budget). The statement was not processed.`;
      console.error("[accounting/process] budget exhausted", { requestId, endpoint: workerEndpoint, runId, message });
      return { kind: "unreachable", error: message };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), sliceMs);
    let response: Response;
    let responseText: string;
    try {
      response = await fetch(workerEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.ACCOUNTING_WORKER_TOKEN ? { Authorization: `Bearer ${process.env.ACCOUNTING_WORKER_TOKEN}` } : {}),
        },
        body: JSON.stringify(workerPayload),
        signal: controller.signal,
      });
      responseText = await response.text();
    } catch (fetchError) {
      const aborted = fetchError instanceof Error && fetchError.name === "AbortError";
      // Report the slice actually granted, not the ceiling — on a retry, or
      // after slow pre-extraction, they differ, and the ceiling would send
      // someone hunting for a timeout that never applied.
      const message = aborted ? `Accounting worker timed out after ${Math.round(sliceMs / 1000)}s.` : `Accounting worker unreachable: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`;
      console.error("[accounting/process] worker fetch failed", { requestId, endpoint: workerEndpoint, runId, message });
      return { kind: "unreachable", error: message };
    } finally {
      clearTimeout(timer);
    }

    let result: WorkerResponseBody = {};
    try {
      result = responseText ? (JSON.parse(responseText) as WorkerResponseBody) : {};
    } catch {
      result = { detail: responseText };
    }
    console.info("docucorex.accounting.worker.response", { requestId, endpoint: workerEndpoint, runId, status: response.status, ok: response.ok });

    if (response.status === 202) {
      // Covers both "we scheduled it" and "it was already running". Either way
      // the worker owns the run from here, and the caller must not fail it.
      jobAccepted = true;
      const alreadyRunning = Boolean(asRecord(result)?.already_running);
      if (alreadyRunning) {
        console.info("[accounting/process] job already running on the worker", { runId, jobId });
      }
      return { kind: "accepted" };
    }

    if (response.ok) {
      // A 2xx that is not 202 means the worker processed synchronously — the old
      // contract. Kept so a worker deployed before the dispatch endpoint still
      // works rather than failing every run during a rollout.
      updateStep("reconciling");
      return { kind: "ok" };
    }

    const error = normalizeWorkerFailure({
      status: response.status,
      message: getWorkerError(result, responseText, response.status),
      workerUrl,
      workerEndpoint,
      worker: result.worker ?? asRecord(result.detail)?.worker ?? null,
    });
    return { kind: "failed", status: response.status, error };
  };

  let pipelineDebug: PipelineDebug | null = null;
  try {
    // 1. Analyse + extract. EVERY document is analysed; the strategy decides how
    // much work follows — a genuine digital statement takes the native path and
    // never calls OCR. ACCOUNTING_PRE_EXTRACT=false is the emergency bypass.
    const { hints, debug } = ACCOUNTING_PRE_EXTRACT_ENABLED
      ? await runPipelineBeforeWorker(context, detail, { force, onStage: updateStep })
      : { hints: {}, debug: null };
    pipelineDebug = debug;
    updateStep("parsing");

    // 2. Accounting worker.
    let outcome = await callWorker(hints);

    // 2b. Safety net: the worker found nothing parseable, which for a bank
    // statement almost always means it is scanned. Re-run the pipeline with
    // Enhanced OCR (forcing the secondary engine) and give the worker the
    // recovered text once. Skipped when pre-extraction already ran with OCR and
    // still produced nothing usable, so this can never loop.
    if (
      outcome.kind === "failed" &&
      ACCOUNTING_OCR_FALLBACK_ENABLED &&
      isNoTransactionsFailure(outcome.status, outcome.error) &&
      !pipelineDebug?.ocrUsed
    ) {
      console.warn("[accounting/process] worker parsed no transactions — retrying with Enhanced OCR", {
        runId,
        status: outcome.status,
        previousStrategy: pipelineDebug?.strategy ?? null,
      });
      updateStep("ocr");
      const retry = await runPipelineBeforeWorker(context, detail, { force: true, enhancedOcr: true, onStage: updateStep });
      pipelineDebug = retry.debug ?? pipelineDebug;
      if (Object.keys(retry.hints).length > 0) {
        updateStep("parsing");
        outcome = await callWorker(retry.hints);
      }
    }

    if (outcome.kind === "accepted") {
      // Handover complete. Progress, results and the terminal state now come
      // from the worker's own Supabase writes, which the UI already polls for.
      //
      // The shadow comparison below is deliberately NOT run here: it reads the
      // finished run, and nothing is finished yet. It stays on the synchronous
      // path rather than being given incomplete data to compare.
      console.info("[accounting/process] worker accepted job", { runId, jobId });
      // The handover, recorded. Also the reference point for stale-progress
      // detection: accepted long ago with no movement means recoverable by
      // explicit Reprocess — never an automatic retry, which could duplicate
      // work a still-running worker is about to commit.
      await context.supabase
        .from("accounting_statement_runs")
        .update({ job_accepted_at: new Date().toISOString() })
        .eq("id", runId)
        .eq("workspace_id", context.workspaceId);
      await recordAuditLog({
        action: "accounting_extraction_dispatched",
        entityType: "accounting_run",
        entityId: runId,
        metadata: {
          bank: detail.run.bank,
          detectedBank: pipelineDebug?.detectedBank ?? null,
          worker: "fastapi",
          jobId,
        },
      });
      return;
    }

    if (outcome.kind !== "ok") {
      let error = outcome.error;
      // Do not hide the real reason behind "No FNB transactions could be parsed."
      if (pipelineDebug?.reasonNoTransactions && /no fnb transactions|no transactions could be parsed/i.test(error)) {
        error = pipelineDebug.reasonNoTransactions;
      }
      console.warn("[accounting/process] worker failed", { runId, error, parserDebug: toParserDebug(pipelineDebug) });
      await failRun(error, toParserDebug(pipelineDebug));
      return;
    }

    // 3. Success — the worker has written the run result. Record the audit log.
    await recordAuditLog({
      action: "accounting_extraction_completed",
      entityType: "accounting_run",
      entityId: runId,
      metadata: {
        bank: detail.run.bank,
        detectedBank: pipelineDebug?.detectedBank ?? null,
        worker: "fastapi",
        extractionStrategy: pipelineDebug?.strategy ?? null,
        ocrEngine: pipelineDebug?.ocrEngine ?? null,
        acceptanceVerdict: pipelineDebug?.verdict ?? null,
      },
    });

    // 4. Shadow mode (Phase C) — OBSERVATIONAL ONLY.
    //
    // Runs strictly AFTER the workbook has been generated and the run persisted,
    // so it can never influence the exported output, the acceptance verdict or
    // the transactions. Fully swallowed: a shadow failure must never fail a run
    // that has already succeeded.
    await runShadowComparison(context, detail, pipelineDebug);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to process accounting statement.";
    console.error("[accounting/process] background failure", { runId, message });
    await failRun(message, toParserDebug(pipelineDebug));
  }
}

export async function POST(request: Request) {
  await logWorkerStartupCheck();
  const body = (await request.json().catch(() => ({}))) as ProcessBody;
  const runId = body.runId;

  if (!runId) {
    return NextResponse.json({ error: "runId is required." }, { status: 400 });
  }

  const workerUrl = getWorkerConfig().accountingWorkerUrl;
  if (!workerUrl) {
    return NextResponse.json(
      { error: "Accounting worker is not configured. Set ACCOUNTING_WORKER_URL to process FNB statements." },
      { status: 503 },
    );
  }

  try {
    const context = await getWorkspaceContext();
    if (!context) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const detail = await getAccountingRunDetail(runId);
    if (!detail) {
      return NextResponse.json({ error: "Accounting run not found." }, { status: 404 });
    }

    // Duplicate-job protection: never start a second extraction for a run that is
    // already processing (unless this is an explicit manual re-process).
    //
    // This gates on run.status, so a re-dispatch while the status has not yet
    // been written — or has already moved on — sends the SAME processing_job_id
    // again. That happened in production: job f1d9d778 for run 1ee084e3 was
    // dispatched at 16:23 and again at 16:42, both answered 202. active_job_id
    // does not catch it, because both requests carry the same id and therefore
    // both satisfy the fence.
    //
    // The worker now claims the job atomically (queued -> running on
    // processing_jobs) and answers already_running without scheduling a second
    // pipeline, so correctness does not depend on this check. It stays as the
    // cheap first line: not sending a doomed dispatch is better than having one
    // rejected.
    if (detail.run.status === "processing" && !body.reprocess) {
      return NextResponse.json({ ok: true, skipped: true, reason: "already_processing", status: "processing", runId, jobId: detail.run.processingJobId ?? null });
    }

    // A processing job is one execution attempt, not a permanent identity for a
    // statement run. Reusing a completed/failed job made Force Reprocess
    // unclaimable; reusing a running job made it return "already running" without
    // scheduling replacement work. Allocate a fresh queued job before changing
    // the run, so the old attempt can be fenced out by a different active_job_id.
    let processingJobId = detail.run.processingJobId;
    if (body.reprocess) {
      const { data: replacementJob, error: replacementJobError } = await context.supabase
        .from("processing_jobs")
        .insert({
          document_id: detail.run.documentId,
          type: "extraction",
          status: "queued",
          progress: 0,
          message: "Accounting reprocessing queued",
        })
        .select("id")
        .single();
      if (replacementJobError || !replacementJob) {
        return NextResponse.json(
          { error: replacementJobError?.message ?? "Unable to create a replacement accounting job." },
          { status: 500 },
        );
      }
      processingJobId = replacementJob.id;
    }

    if (!processingJobId) {
      return NextResponse.json({ error: "Accounting run has no processing job." }, { status: 409 });
    }

    // Mark queued/processing so the UI can start polling immediately. Stamp the
    // start time + first step so the UI stepper/elapsed timer can begin. Best
    // effort on the new columns — the update must not fail if migration 014 is
    // not yet applied, so retry without them on error.
    const nowIso = new Date().toISOString();
    // The previous ledger is NOT deleted here, and that is the whole point.
    //
    // This used to delete every transaction on the run before starting, then
    // hand off to a worker that takes about eleven minutes on a 37-page
    // statement. For those eleven minutes the run had no ledger at all, and any
    // failure in them — worker timeout, model outage, Render cold start, a
    // deploy landing mid-flight, an extraction fault — left it that way
    // permanently. failRun marks the run failed; it does not put 615
    // transactions back.
    //
    // The delete was also unnecessary. The worker already clears the run's
    // transactions immediately before inserting the replacement, AFTER every
    // extraction, classification and validation stage has succeeded. That makes
    // reprocessing idempotent on its own, and it narrows the window in which no
    // ledger exists from eleven minutes to the few milliseconds between a
    // delete and an insert against the same table.
    //
    // So the old generation stays readable until a new one is ready to take its
    // place. transaction_count and workbook_storage_path are kept for the same
    // reason: a run that still has 615 transactions must not advertise zero,
    // and a reviewer refreshing mid-reprocess should see the statement they had
    // rather than an empty one.
    const { error: markError } = await context.supabase
      .from("accounting_statement_runs")
      .update({
        status: "processing",
        // Claim the run for THIS attempt before anyone dispatches. Every worker
        // write is fenced on this value, so a job superseded by a later Force
        // Reprocess matches zero rows and cannot overwrite the newer attempt.
        // job_superseded_at records that a previous job was retired; a rejected
        // stale write afterwards is the fence working, not a fault.
        processing_job_id: processingJobId,
        active_job_id: processingJobId,
        job_accepted_at: null,
        job_superseded_at: body.reprocess ? new Date().toISOString() : null,
        error: null,
        transaction_count: detail.run.transactionCount,
        workbook_storage_path: detail.run.workbookStoragePath,
        parser_method: null,
        extraction_confidence: null,
        detected_pdf_type: null,
        ocr_used: null,
        route_reason: null,
        extraction_warnings: [],
        validation_status: null,
        reconciliation_difference: null,
        missing_transaction_count: null,
        requires_review: null,
        parser_debug: null,
        ocr_engine: null,
        extraction_strategy: null,
        acceptance_verdict: null,
        ocr_engine_comparison: null,
        processing_step: PROCESSING_STEP_LABELS.detecting,
        processing_started_at: nowIso,
        updated_at: nowIso,
      })
      .eq("workspace_id", context.workspaceId)
      .eq("id", runId);
    if (markError) {
      const { error: fallbackMarkError } = await context.supabase
        .from("accounting_statement_runs")
        .update({
          // Same reasoning as the primary update above: the previous
          // generation stays intact and correctly described until a
          // replacement is ready to take its place.
          status: "processing",
          processing_job_id: processingJobId,
          error: null,
          transaction_count: detail.run.transactionCount,
          workbook_storage_path: detail.run.workbookStoragePath,
          updated_at: nowIso,
        })
        .eq("workspace_id", context.workspaceId)
        .eq("id", runId);
      if (fallbackMarkError) {
        if (body.reprocess) {
          await context.supabase
            .from("processing_jobs")
            .update({
              status: "failed",
              progress: 100,
              message: "Could not attach replacement job to statement run",
              error: fallbackMarkError.message,
              updated_at: new Date().toISOString(),
            })
            .eq("id", processingJobId);
        }
        return NextResponse.json({ error: fallbackMarkError.message }, { status: 500 });
      }
    }

    if (processingJobId) {
      // Deliberately does NOT set status. The worker claims a job by moving it
      // queued -> running (#80), and that claim is the only thing preventing two
      // pipelines on one run. Marking it running here pre-empted the claim: by
      // dispatch time the job was already running with a fresh heartbeat, so it
      // was neither claimable nor reclaimable, every dispatch was answered
      // already_running, and NOTHING was ever scheduled. Production stopped
      // processing entirely.
      //
      // status belongs to the worker. progress and message are progress
      // reporting and stay here — and the touched updated_at is honest, because
      // pre-extraction genuinely is work.
      await context.supabase
        .from("processing_jobs")
        .update({ progress: 10, message: "Queued for extraction", updated_at: new Date().toISOString() })
        .eq("id", processingJobId);
    }

    // Run the extraction + worker call AFTER responding — never on the request path.
    // `reprocess` (Force reprocess) bypasses the extraction cache.
    after(() => processStatementInBackground(context, detail, workerUrl, runId, processingJobId, Boolean(body.reprocess)));

    // Return immediately (well under the 25s initial-response limit).
    return NextResponse.json({ ok: true, status: "processing", runId, jobId: processingJobId });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to process accounting statement." },
      { status: 500 },
    );
  }
}
