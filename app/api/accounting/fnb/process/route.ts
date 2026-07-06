import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { detectBankProfile } from "@/lib/accounting/engine/registry";
import { getAccountingRunDetail } from "@/lib/accounting/server";
import { getWorkspaceContext } from "@/lib/server-documents";

type ProcessBody = {
  runId?: string;
  forceReprocess?: boolean;
};

type WorkerResponseBody = {
  detail?: unknown;
  error?: string;
  status?: string;
  worker?: unknown;
  [key: string]: unknown;
};

const defaultWorkerTimeoutMs = 8 * 60 * 1000;

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseDebugObject(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return asRecord(value);
}

function parseWorkerDebug(result: WorkerResponseBody) {
  const detail = asRecord(result.detail);
  const parserDebug = parseDebugObject(result.parser_debug ?? detail?.parser_debug);
  const ocrDebug = parseDebugObject(result.ocr_debug ?? detail?.ocr_debug);

  return {
    lastStep: typeof result.last_step === "string" ? result.last_step : typeof detail?.last_step === "string" ? detail.last_step : null,
    selectedParser:
      typeof result.parser_profile === "string"
        ? result.parser_profile
        : typeof detail?.parser_profile === "string"
          ? detail.parser_profile
          : null,
    detectedPdfType:
      typeof result.detected_pdf_type === "string"
        ? result.detected_pdf_type
        : typeof detail?.detected_pdf_type === "string"
          ? detail.detected_pdf_type
          : null,
    parserDebug,
    ocrDebug,
    requiresReview: Boolean(result.requires_review ?? detail?.requires_review ?? result.status === "review"),
  };
}

async function markRunFailed(input: {
  runId: string;
  workspaceId: string;
  processingJobId: string | null;
  message: string;
  context: Awaited<ReturnType<typeof getWorkspaceContext>>;
  workerDetail?: unknown;
  workerStatus?: number;
  parserProfile?: string | null;
}) {
  const { context, runId, workspaceId, processingJobId, message, workerDetail, workerStatus, parserProfile } = input;
  if (!context) return;
  const now = new Date().toISOString();
  const detail = asRecord(workerDetail);

  await context.supabase
    .from("accounting_statement_runs")
    .update({
      status: "failed",
      error: message,
      error_message: message,
      last_step: "failed",
      selected_parser: parserProfile ?? (typeof detail?.parser_profile === "string" ? detail.parser_profile : null),
      detected_pdf_type: typeof detail?.detected_pdf_type === "string" ? detail.detected_pdf_type : null,
      parser_debug: parseDebugObject(detail?.parser_debug) ?? {},
      ocr_debug: parseDebugObject(detail?.ocr_debug) ?? {},
      requires_review: false,
      updated_at: now,
    })
    .eq("workspace_id", workspaceId)
    .eq("id", runId);

  if (processingJobId) {
    await context.supabase
      .from("processing_jobs")
      .update({
        status: "failed",
        progress: 100,
        message: workerStatus ? `${message} (Worker HTTP ${workerStatus})` : message,
        error: message,
        updated_at: now,
      })
      .eq("id", processingJobId);
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as ProcessBody;
  const runId = body.runId;
  const forceReprocess = Boolean(body.forceReprocess);

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

  let context: Awaited<ReturnType<typeof getWorkspaceContext>> = null;
  let processingJobId: string | null = null;

  try {
    context = await getWorkspaceContext();
    if (!context) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const detail = await getAccountingRunDetail(runId);
    if (!detail) {
      return NextResponse.json({ error: "Accounting run not found." }, { status: 404 });
    }

    processingJobId = detail.run.processingJobId;
    const now = new Date().toISOString();
    await context.supabase
      .from("accounting_statement_runs")
      .update({
        status: "processing",
        error: null,
        error_message: null,
        last_step: "request_received",
        parser_debug: {},
        ocr_debug: {},
        requires_review: false,
        updated_at: now,
      })
      .eq("workspace_id", context.workspaceId)
      .eq("id", runId);

    if (processingJobId) {
      await context.supabase
        .from("processing_jobs")
        .update({ status: "running", progress: 25, message: "Sending statement to accounting worker", updated_at: now })
        .eq("id", processingJobId);
    }

    const workerPayload = {
      run_id: runId,
      workspace_id: context.workspaceId,
      document_id: detail.run.documentId,
      processing_job_id: processingJobId,
      storage_path: detail.run.sourceStoragePath,
      force_reprocess: forceReprocess,
    };
    const parserProfile = detectBankProfile({ bank: detail.run.bank, fileName: detail.run.sourceStoragePath });

    console.info("[accounting/process] sending worker payload", {
      runId,
      workspaceId: context.workspaceId,
      documentId: detail.run.documentId,
      processingJobId,
      storagePath: detail.run.sourceStoragePath,
      parserProfile,
      forceReprocess,
      workerUrlConfigured: Boolean(workerUrl),
      workerOrigin: getWorkerOrigin(workerUrl),
    });

    const timeoutMs = Number(process.env.ACCOUNTING_WORKER_TIMEOUT_MS || defaultWorkerTimeoutMs);
    const workerController = new AbortController();
    const workerTimeout = setTimeout(() => workerController.abort("accounting-worker-timeout"), timeoutMs);
    const response = await fetch(`${workerUrl.replace(/\/$/, "")}/process-statement`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.ACCOUNTING_WORKER_TOKEN ? { Authorization: `Bearer ${process.env.ACCOUNTING_WORKER_TOKEN}` } : {}),
      },
      body: JSON.stringify(workerPayload),
      signal: workerController.signal,
    }).finally(() => clearTimeout(workerTimeout));

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
      const error = getWorkerError(result, responseText, response.status);
      await markRunFailed({
        runId,
        workspaceId: context.workspaceId,
        processingJobId,
        message: error,
        context,
        workerDetail: result.detail ?? result,
        workerStatus: response.status,
        parserProfile,
      });

      return NextResponse.json(
        {
          error,
          workerStatus: response.status,
          workerDetail: result.detail ?? result,
          worker: result.worker ?? (result.detail && typeof result.detail === "object" ? (result.detail as { worker?: unknown }).worker : undefined),
          workerOrigin: getWorkerOrigin(workerUrl),
          workerRawBody: responseText.slice(0, 2000),
          workerPayload: {
            runId,
            workspaceId: context.workspaceId,
            documentId: detail.run.documentId,
            processingJobId,
            storagePath: detail.run.sourceStoragePath,
            forceReprocess,
          },
        },
        { status: response.status },
      );
    }

    const workerDebug = parseWorkerDebug(result);
    await context.supabase
      .from("accounting_statement_runs")
      .update({
        last_step: workerDebug.lastStep ?? "completed",
        selected_parser: workerDebug.selectedParser,
        detected_pdf_type: workerDebug.detectedPdfType,
        parser_debug: workerDebug.parserDebug ?? {},
        ocr_debug: workerDebug.ocrDebug ?? {},
        requires_review: workerDebug.requiresReview,
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq("workspace_id", context.workspaceId)
      .eq("id", runId);

    await recordAuditLog({
      action: "accounting_extraction_completed",
      entityType: "accounting_run",
      entityId: runId,
      metadata: { bank: detail.run.bank, parserProfile, forceReprocess, worker: "fastapi" },
    });

    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to process accounting statement.";
    const timeoutError = message.toLowerCase().includes("aborted") || message.toLowerCase().includes("timeout");
    if (context) {
      await markRunFailed({
        runId,
        workspaceId: context.workspaceId,
        processingJobId,
        message: timeoutError ? "Accounting worker timed out while processing this statement." : message,
        context,
      });
    }
    return NextResponse.json(
      { error: timeoutError ? "Accounting worker timed out while processing this statement." : message },
      { status: timeoutError ? 504 : 500 },
    );
  }
}
