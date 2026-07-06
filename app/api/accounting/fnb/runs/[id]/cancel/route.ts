import { NextResponse } from "next/server";
import { getAccountingRunDetail } from "@/lib/accounting/server";
import { getWorkspaceContext } from "@/lib/server-documents";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await getWorkspaceContext();
  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const detail = await getAccountingRunDetail(id);
  if (!detail) {
    return NextResponse.json({ error: "Accounting run not found." }, { status: 404 });
  }

  if (!["queued", "processing"].includes(detail.run.status)) {
    return NextResponse.json({ error: "Only queued or processing runs can be cancelled." }, { status: 409 });
  }

  const nowIso = new Date().toISOString();
  const reason = "Processing cancelled by user.";
  await context.supabase
    .from("accounting_statement_runs")
    .update({
      status: "cancelled",
      error: reason,
      processing_step: "Cancelled",
      updated_at: nowIso,
    })
    .eq("workspace_id", context.workspaceId)
    .eq("id", id);

  if (detail.run.processingJobId) {
    await context.supabase
      .from("processing_jobs")
      .update({
        status: "cancelled",
        progress: 100,
        message: reason,
        error: reason,
        updated_at: nowIso,
      })
      .eq("id", detail.run.processingJobId);
  }

  return NextResponse.json({ ok: true, status: "cancelled", runId: id });
}
