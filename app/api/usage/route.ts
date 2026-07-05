import { NextResponse } from "next/server";
import { usageSummary } from "@/lib/mock-repository";
import { isDemoAllowed, isSupabaseConfigured } from "@/lib/supabase";
import { getWorkspaceContext } from "@/lib/server-documents";

export async function GET() {
  // Demo mode only exists when there is no Supabase backend at all.
  if (!isSupabaseConfigured) {
    if (isDemoAllowed) {
      return NextResponse.json({ usage: usageSummary, mode: "demo" });
    }
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  const context = await getWorkspaceContext().catch(() => null);
  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await context.supabase
    .from("usage_counters")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .order("period_start", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "Usage counters not found" }, { status: 404 });
  }

  return NextResponse.json({ usage: data });
}
