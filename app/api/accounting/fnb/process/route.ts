import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { detectBankProfile } from "@/lib/accounting/engine/registry";
import { getAccountingRunDetail } from "@/lib/accounting/server";
import { getWorkspaceContext } from "@/lib/server-documents";
import { runExtractionPipeline } from "@/lib/pdf/runExtractionPipeline";
import { buildWorkerInput, extractionProcessingMetadata } from "@/lib/pdf/workerHandoff";
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
};

async function runPipelineBeforeWorker(
  context: WorkspaceContext,
  detail: AccountingRunDetail,
): Promise<{ hints: Record<string, unknown>; warning: string | null; debug: PipelineDebug | null }> {
  const runId = detail.run.id;
  try {
    const { data: file, error } = await context.supabase.storage.from("documents").download(detail.run.sourceStoragePath);
    if (error || !file) {
      return { hints: {}, warning: `Extraction pipeline skipped: source unavailable (${error?.message ?? "no file"}).`, debug: null };
    }
    const buffer = new Uint8Array(await file.arrayBuffer());
    const pipeline = await runExtractionPipeline(buffer, detail.run.sourceStoragePath.split("/").pop() || "statement.pdf");
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

function getWorkerOrigin(workerUrl: string) {
  try {
    return new URL(workerUrl).origin;
  } catch {
    return "invalid-worker-url";
  }
}

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

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as ProcessBody;
  const runId = body.runId;

  if (!runId) {
    return NextResponse.json({ error: "runId is required." }, { status: 400 });
  }

  const workerUrl = process.env.ACCOUNTING_WORKER_URL;
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
      return NextResponse.json({ ok: true, skipped: true, reason: "already_processing" });
    }

    await context.supabase
      .from("accounting_statement_runs")
      .update({ status: "processing", error: null, updated_at: new Date().toISOString() })
      .eq("workspace_id", context.workspaceId)
      .eq("id", runId);

    if (detail.run.processingJobId) {
      await context.supabase
        .from("processing_jobs")
        .update({ status: "running", progress: 25, message: "Sending statement to accounting worker", updated_at: new Date().toISOString() })
        .eq("id", detail.run.processingJobId);
    }

    // Auto-run the extraction pipeline first (analysis → best source → persist).
    const { hints, warning: pipelineWarning, debug: pipelineDebug } = await runPipelineBeforeWorker(context, detail);

    const workerPayload = {
      run_id: runId,
      workspace_id: context.workspaceId,
      document_id: detail.run.documentId,
      processing_job_id: detail.run.processingJobId,
      storage_path: detail.run.sourceStoragePath,
      ...hints,
    };
    const parserProfile = detectBankProfile({ bank: detail.run.bank, fileName: detail.run.sourceStoragePath });

    console.info("[accounting/process] sending worker payload", {
      runId,
      workspaceId: context.workspaceId,
      documentId: detail.run.documentId,
      processingJobId: detail.run.processingJobId,
      storagePath: detail.run.sourceStoragePath,
      parserProfile,
      workerUrlConfigured: Boolean(workerUrl),
      workerOrigin: getWorkerOrigin(workerUrl),
    });

    const response = await fetch(`${workerUrl.replace(/\/$/, "")}/process-statement`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.ACCOUNTING_WORKER_TOKEN ? { Authorization: `Bearer ${process.env.ACCOUNTING_WORKER_TOKEN}` } : {}),
      },
      body: JSON.stringify(workerPayload),
    });

    const responseText = await response.text();
    let result: WorkerResponseBody = {};
    try {
      result = responseText ? (JSON.parse(responseText) as WorkerResponseBody) : {};
    } catch {
      result = { detail: responseText };
    }

    console.info("[accounting/process] worker response", {
      runId,
      status: response.status,
      ok: response.ok,
      body: result,
    });

    if (!response.ok) {
      let error = getWorkerError(result, responseText, response.status);
      // Do not hide the real reason behind "No FNB transactions could be parsed."
      // Surface the pipeline's actual finding (e.g. OCR produced no text).
      if (pipelineDebug?.reasonNoTransactions && /no fnb transactions|no transactions could be parsed/i.test(error)) {
        error = pipelineDebug.reasonNoTransactions;
      }
      await context.supabase
        .from("accounting_statement_runs")
        .update({ status: "failed", error, updated_at: new Date().toISOString() })
        .eq("workspace_id", context.workspaceId)
        .eq("id", runId);

      if (detail.run.processingJobId) {
        await context.supabase
          .from("processing_jobs")
          .update({ status: "failed", progress: 100, message: error, error, updated_at: new Date().toISOString() })
          .eq("id", detail.run.processingJobId);
      }

      return NextResponse.json(
        {
          error,
          workerStatus: response.status,
          workerDetail: result.detail ?? result,
          worker: result.worker ?? (result.detail && typeof result.detail === "object" ? (result.detail as { worker?: unknown }).worker : undefined),
          workerOrigin: getWorkerOrigin(workerUrl),
          workerRawBody: responseText.slice(0, 2000),
          // Parser debug so the real reason is visible, never hidden.
          parserDebug: pipelineDebug
            ? {
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
                // OCR engine diagnostics — never return the generic empty message
                // without these (task 8): ocr_endpoint, ocr_status, ocr_exit_code,
                // ocr_stderr_sample, sidecar_exists, sidecar_size, ocr_text_length.
                ocr: pipelineDebug.ocr,
              }
            : null,
          workerPayload: {
            runId,
            workspaceId: context.workspaceId,
            documentId: detail.run.documentId,
            processingJobId: detail.run.processingJobId,
            storagePath: detail.run.sourceStoragePath,
          },
        },
        { status: response.status },
      );
    }

    await recordAuditLog({
      action: "accounting_extraction_completed",
      entityType: "accounting_run",
      entityId: runId,
      metadata: { bank: detail.run.bank, parserProfile, worker: "fastapi" },
    });

    return NextResponse.json({ ok: true, result, pipelineWarning });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to process accounting statement." },
      { status: 500 },
    );
  }
}
