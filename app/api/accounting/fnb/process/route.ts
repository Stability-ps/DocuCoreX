import { NextResponse, after } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { detectBankProfile } from "@/lib/accounting/engine/registry";
import { getAccountingRunDetail } from "@/lib/accounting/server";
import { getWorkspaceContext } from "@/lib/server-documents";
import { runExtractionPipeline } from "@/lib/pdf/runExtractionPipeline";
import { computeFileHash } from "@/lib/pdf/extractionCache";
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
  extractionConfidence: number;
  pdfjsTextLength: number;
  pdfplumberTextLength: number;
  ocrTextLength: number;
  preExtractedTextLength: number;
  sampleText: string;
  reasonNoTransactions: string | null;
  ocr: Record<string, unknown> | null;
  stages: unknown[];
};

async function runPipelineBeforeWorker(
  context: WorkspaceContext,
  detail: AccountingRunDetail,
  options: { force: boolean; onStage: (step: ProcessingStep) => void },
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
      onStage: options.onStage,
    });
    const meta = extractionProcessingMetadata(pipeline);
    const workerInput = buildWorkerInput(pipeline);

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
        updated_at: new Date().toISOString(),
      })
      .eq("workspace_id", context.workspaceId)
      .eq("id", runId);
    if (updateError) {
      console.warn("[accounting/process] extraction metadata not persisted (migration 013 not applied?)", { runId, error: updateError.message });
    }

    const debug: PipelineDebug = {
      selectedParser: meta.selectedParser,
      parserMethod: meta.selectedParser,
      ocrUsed: meta.ocrUsed,
      detectedPdfType: meta.detectedPdfType,
      extractionConfidence: meta.extractionConfidence,
      pdfjsTextLength: pipeline.debug.pdfjsTextLength,
      pdfplumberTextLength: pipeline.debug.pdfplumberTextLength,
      ocrTextLength: pipeline.debug.ocrTextLength,
      preExtractedTextLength: pipeline.debug.preExtractedTextLength,
      sampleText: pipeline.debug.sampleText,
      reasonNoTransactions: pipeline.debug.reasonNoTransactions,
      ocr: pipeline.debug.ocr,
      stages: pipeline.debug.stages,
    };

    // Detailed log immediately before handing off to the worker.
    console.info("[accounting/process] extraction pipeline result", {
      runId,
      parserMethod: meta.selectedParser,
      ocrUsed: meta.ocrUsed,
      detectedPdfType: meta.detectedPdfType,
      extractionConfidence: meta.extractionConfidence,
      pdfjsTextLength: pipeline.debug.pdfjsTextLength,
      pdfplumberTextLength: pipeline.debug.pdfplumberTextLength,
      ocrTextLength: pipeline.debug.ocrTextLength,
      preExtractedTextLength: workerInput.preExtractedText.length,
      preExtractedTextSample: workerInput.preExtractedText.slice(0, 1000),
      transactionCandidates: workerInput.transactionCandidateCount,
      reasonNoTransactions: pipeline.debug.reasonNoTransactions,
      ocr: pipeline.debug.ocr,
    });

    // Hand the worker the best source; it keeps the original PDF as a fallback.
    const hints: Record<string, unknown> = {
      parser_method: meta.selectedParser,
      extraction_source: workerInput.parser,
      ocr_used: meta.ocrUsed,
      extraction_debug: debug,
    };
    if (workerInput.useProvidedText && workerInput.preExtractedText.trim()) {
      hints.pre_extracted_text = workerInput.preExtractedText;
    }
    return { hints, warning: null, debug };
  } catch (pipelineError) {
    const message = pipelineError instanceof Error ? pipelineError.message : String(pipelineError);
    console.warn("[accounting/process] extraction pipeline failed — using original worker path", { runId, error: message });
    return { hints: {}, warning: `Extraction pipeline error: ${message}`, debug: null };
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

  return `${detail || `Accounting worker returned HTTP ${input.status}.`} (endpoint: ${input.workerEndpoint}).${workerMetaSuffix}`;
}

const ACCOUNTING_WORKER_TIMEOUT_MS = 120_000;

// Allow the background work (after the response is sent) to run beyond the default
// so extraction + worker + reconciliation can finish off the request path.
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
    pre_extracted_text_length: pipelineDebug.preExtractedTextLength,
    sample_text: pipelineDebug.sampleText,
    reason_no_transactions: pipelineDebug.reasonNoTransactions,
    ocr: pipelineDebug.ocr,
    stages: pipelineDebug.stages,
  };
}

// All heavy work — extraction pipeline (PDF.js / pdfplumber / OCR), the accounting
// worker call, reconciliation and status updates — runs HERE, after the HTTP
// response has already been returned. Nothing below blocks the user's request.
async function processStatementInBackground(context: WorkspaceContext, detail: AccountingRunDetail, workerUrl: string, runId: string, force: boolean) {
  const jobId = detail.run.processingJobId;

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
      void context.supabase
        .from("processing_jobs")
        .update({ status: "running", progress, message: label, updated_at: new Date().toISOString() })
        .eq("id", jobId)
        .then(() => undefined);
    }
  };

  // The key parser-debug fields (parser_method, detected_pdf_type, ocr_used,
  // validation_status, reconciliation_difference, requires_review, route_reason)
  // are persisted on the run by runPipelineBeforeWorker; here we set the failure
  // reason and log the full parserDebug.
  const failRun = async (error: string, parserDebug: ReturnType<typeof toParserDebug>) => {
    console.warn("[accounting/process] marking run failed", { runId, error, parserDebug });
    const nowIso = new Date().toISOString();
    // Persist the full parser/OCR debug alongside the failure so the workspace can
    // show the real reason (not just "Failed 0%"). Best-effort: if migration 015
    // (parser_debug) is not yet applied, retry the essential status/error update
    // without it so the run is still correctly marked failed.
    const { error: failError } = await context.supabase
      .from("accounting_statement_runs")
      .update({ status: "failed", error, parser_debug: parserDebug ?? null, updated_at: nowIso })
      .eq("workspace_id", context.workspaceId)
      .eq("id", runId);
    if (failError) {
      console.warn("[accounting/process] parser_debug not persisted (migration 015 not applied?)", { runId, error: failError.message });
      await context.supabase
        .from("accounting_statement_runs")
        .update({ status: "failed", error, updated_at: nowIso })
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

  let pipelineDebug: PipelineDebug | null = null;
  try {
    // 1. Extraction pipeline (best-source + persist). Defensive: never throws.
    // The pipeline reports "Detecting PDF type" / "Running OCR"; the later
    // "Parsing transactions" / "Reconciling" steps are reported around the worker.
    const { hints, debug } = await runPipelineBeforeWorker(context, detail, { force, onStage: updateStep });
    pipelineDebug = debug;
    updateStep("parsing");

    const workerPayload = {
      run_id: runId,
      workspace_id: context.workspaceId,
      document_id: detail.run.documentId,
      processing_job_id: jobId,
      storage_path: detail.run.sourceStoragePath,
      ...hints,
    };
    const parserProfile = detectBankProfile({ bank: detail.run.bank, fileName: detail.run.sourceStoragePath });
    const requestId = createWorkerRequestId("acct_process");
    const workerEndpoint = buildWorkerEndpoint(workerUrl, "/process-statement");
    console.info("docucorex.accounting.worker.request", {
      requestId,
      resolvedAccountingWorkerUrl: workerUrl,
      endpoint: workerEndpoint,
      runId,
      parserProfile,
    });

    // 2. Accounting worker (timeout-protected so it cannot hang the function).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ACCOUNTING_WORKER_TIMEOUT_MS);
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
      const message = aborted ? `Accounting worker timed out after ${ACCOUNTING_WORKER_TIMEOUT_MS / 1000}s.` : `Accounting worker unreachable: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`;
      console.error("[accounting/process] worker fetch failed", { requestId, endpoint: workerEndpoint, runId, message });
      await failRun(message, toParserDebug(pipelineDebug));
      return;
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

    if (response.ok) updateStep("reconciling");

    if (!response.ok) {
      let error = getWorkerError(result, responseText, response.status);
      error = normalizeWorkerFailure({
        status: response.status,
        message: error,
        workerUrl,
        workerEndpoint,
        worker: result.worker ?? asRecord(result.detail)?.worker ?? null,
      });
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
      metadata: { bank: detail.run.bank, parserProfile, worker: "fastapi" },
    });
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
    if (detail.run.status === "processing" && !body.reprocess) {
      return NextResponse.json({ ok: true, skipped: true, reason: "already_processing", status: "processing", runId, jobId: detail.run.processingJobId ?? null });
    }

    // Mark queued/processing so the UI can start polling immediately. Stamp the
    // start time + first step so the UI stepper/elapsed timer can begin. Best
    // effort on the new columns — the update must not fail if migration 014 is
    // not yet applied, so retry without them on error.
    const nowIso = new Date().toISOString();
    const { error: markError } = await context.supabase
      .from("accounting_statement_runs")
      .update({
        status: "processing",
        error: null,
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
        processing_step: PROCESSING_STEP_LABELS.detecting,
        processing_started_at: nowIso,
        updated_at: nowIso,
      })
      .eq("workspace_id", context.workspaceId)
      .eq("id", runId);
    if (markError) {
      await context.supabase
        .from("accounting_statement_runs")
        .update({ status: "processing", error: null, updated_at: nowIso })
        .eq("workspace_id", context.workspaceId)
        .eq("id", runId);
    }

    if (detail.run.processingJobId) {
      await context.supabase
        .from("processing_jobs")
        .update({ status: "running", progress: 10, message: "Queued for extraction", updated_at: new Date().toISOString() })
        .eq("id", detail.run.processingJobId);
    }

    // Run the extraction + worker call AFTER responding — never on the request path.
    // `reprocess` (Force reprocess) bypasses the extraction cache.
    after(() => processStatementInBackground(context, detail, workerUrl, runId, Boolean(body.reprocess)));

    // Return immediately (well under the 25s initial-response limit).
    return NextResponse.json({ ok: true, status: "processing", runId, jobId: detail.run.processingJobId ?? null });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to process accounting statement." },
      { status: 500 },
    );
  }
}
