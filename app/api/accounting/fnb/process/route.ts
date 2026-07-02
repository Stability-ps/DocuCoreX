import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { detectBankProfile } from "@/lib/accounting/engine/registry";
import { getAccountingRunDetail } from "@/lib/accounting/server";
import { getWorkspaceContext } from "@/lib/server-documents";

type ProcessBody = {
  runId?: string;
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

    const workerPayload = {
      run_id: runId,
      workspace_id: context.workspaceId,
      document_id: detail.run.documentId,
      processing_job_id: detail.run.processingJobId,
      storage_path: detail.run.sourceStoragePath,
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
      const error = getWorkerError(result, responseText, response.status);
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

    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to process accounting statement." },
      { status: 500 },
    );
  }
}
