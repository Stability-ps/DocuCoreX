import { NextResponse } from "next/server";
import { databaseErrorResponse } from "@/lib/api-errors";
import { auditLogs } from "@/lib/mock-repository";
import { isDemoAllowed, isSupabaseConfigured } from "@/lib/supabase";
import { getWorkspaceContext } from "@/lib/server-documents";

export async function GET() {
  // Demo mode only exists when there is no Supabase backend at all.
  if (!isSupabaseConfigured) {
    if (isDemoAllowed) {
      return NextResponse.json({ auditLogs, mode: "demo" });
    }
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  const context = await getWorkspaceContext().catch(() => null);
  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await context.supabase
    .from("audit_logs")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    return databaseErrorResponse("docucorex.audit_logs.list_failed", error, { message: "Unable to load audit logs." });
  }

  return NextResponse.json({ auditLogs: data ?? [] });
}
