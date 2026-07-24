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

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    // A workspace with no usage row yet is a valid, empty state — return a zeroed
    // summary (200) so the dashboard/settings render 0s instead of logging a 404.
    const now = new Date().toISOString();
    return NextResponse.json({
      usage: {
        periodStart: now,
        periodEnd: now,
        documentsUploaded: 0,
        pagesProcessed: 0,
        ocrCreditsUsed: 0,
        ocrCreditsRemaining: 0,
        storageBytes: 0,
        exportsCreated: 0,
      },
    });
  }

  return NextResponse.json({ usage: data });
}
