import { NextResponse } from "next/server";
import { processingJobs } from "@/lib/mock-repository";
import { isDemoAllowed, isSupabaseConfigured } from "@/lib/supabase";
import { getWorkspaceContext } from "@/lib/server-documents";

export async function GET() {
  if (!isSupabaseConfigured) {
    if (isDemoAllowed) {
      return NextResponse.json({ jobs: processingJobs, mode: "demo" });
    }
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  const context = await getWorkspaceContext().catch(() => null);
  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Explicitly scope jobs to this workspace via the joined document row, in
  // addition to RLS (defense-in-depth).
  const { data, error } = await context.supabase
    .from("processing_jobs")
    .select("*, documents!inner(workspace_id)")
    .eq("documents.workspace_id", context.workspaceId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    jobs: (data ?? []).map((job) => ({
      ...job,
      message: typeof job.message === "string" ? displayJobMessage(job.message) : job.message,
    })),
  });
}

function displayJobMessage(message: string) {
  return message.replace(/\s+·\s+conversion:[0-9a-f-]{36}\b/i, "");
}
