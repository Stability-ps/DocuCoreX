import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { getAccountingRunDetail } from "@/lib/accounting/server";
import { getWorkspaceContext } from "@/lib/server-documents";

type ProcessBody = {
  runId?: string;
};

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

    const response = await fetch(`${workerUrl.replace(/\/$/, "")}/process-fnb-statement`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.ACCOUNTING_WORKER_TOKEN ? { Authorization: `Bearer ${process.env.ACCOUNTING_WORKER_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        run_id: runId,
        workspace_id: context.workspaceId,
        document_id: detail.run.documentId,
        processing_job_id: detail.run.processingJobId,
        storage_path: detail.run.sourceStoragePath,
      }),
    });

    const result = (await response.json().catch(() => ({}))) as { error?: string; status?: string };

    if (!response.ok) {
      const error = result.error ?? "Accounting worker failed to process the statement.";
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

      return NextResponse.json({ error }, { status: response.status });
    }

    await recordAuditLog({
      action: "accounting_extraction_completed",
      entityType: "accounting_run",
      entityId: runId,
      metadata: { bank: "FNB South Africa", worker: "fastapi" },
    });

    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to process accounting statement." },
      { status: 500 },
    );
  }
}
