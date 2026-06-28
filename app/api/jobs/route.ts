import { NextResponse } from "next/server";
import { processingJobs } from "@/lib/mock-repository";
import { isAuthRequired } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  if (!supabase) {
    return NextResponse.json({ jobs: processingJobs, mode: "demo" });
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if ((userError || !user) && !isAuthRequired) {
    return NextResponse.json({ jobs: processingJobs, mode: "demo" });
  }

  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("processing_jobs")
    .select("*, documents!inner(workspace_id)")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    if (!isAuthRequired) {
      return NextResponse.json({ jobs: processingJobs, mode: "demo" });
    }

    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ jobs: data });
}
