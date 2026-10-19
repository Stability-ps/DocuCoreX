import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { getExternalProcessing } from "@/lib/privacy/external-processing";
import { getWorkspaceContext } from "@/lib/server-documents";

// The workspace's choice about sending documents to external AI providers
// (docs/EXTERNAL_DATA_FLOWS.md, migration 051). Any member may read it; only the
// workspace owner may change it. RLS enforces the same: the owner-only check
// here exists to give a clear 403 instead of a silent no-op.

async function isWorkspaceOwner(context: NonNullable<Awaited<ReturnType<typeof getWorkspaceContext>>>) {
  const { data } = await context.supabase.from("workspaces").select("owner_id").eq("id", context.workspaceId).maybeSingle();
  return (data as { owner_id?: string } | null)?.owner_id === context.userId;
}

export async function GET() {
  const context = await getWorkspaceContext().catch(() => null);
  if (!context) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const decision = await getExternalProcessing(context.supabase, context.workspaceId);
  return NextResponse.json({
    externalAiProcessing: decision.allowed ? "allowed" : "blocked",
    source: decision.source,
    canChange: await isWorkspaceOwner(context),
  });
}

export async function PUT(request: Request) {
  const context = await getWorkspaceContext().catch(() => null);
  if (!context) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { externalAiProcessing?: unknown };
  const value = body.externalAiProcessing;
  if (value !== "allowed" && value !== "blocked") {
    return NextResponse.json({ error: "externalAiProcessing must be \"allowed\" or \"blocked\"." }, { status: 400 });
  }
  if (!(await isWorkspaceOwner(context))) {
    return NextResponse.json({ error: "Only the workspace owner can change this setting.", code: "FORBIDDEN" }, { status: 403 });
  }

  const { error } = await context.supabase.from("workspace_privacy_settings").upsert(
    {
      workspace_id: context.workspaceId,
      external_ai_processing: value,
      updated_by: context.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id" },
  );
  if (error) {
    const notMigrated = error.code === "PGRST205" || error.code === "42P01";
    return NextResponse.json(
      { error: notMigrated ? "This setting is not available yet." : "Unable to save the setting." },
      { status: notMigrated ? 503 : 500 },
    );
  }

  await recordAuditLog({
    action: "external_ai_processing_changed",
    entityType: "workspace",
    entityId: context.workspaceId,
    metadata: { externalAiProcessing: value },
  });
  return NextResponse.json({ externalAiProcessing: value, source: "setting", canChange: true });
}
