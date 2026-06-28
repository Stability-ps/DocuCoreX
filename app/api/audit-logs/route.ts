import { NextResponse } from "next/server";
import { auditLogs } from "@/lib/mock-repository";
import { isDemoAllowed } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  if (!supabase && isDemoAllowed) {
    return NextResponse.json({ auditLogs, mode: "demo" });
  }

  if (!supabase) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && isDemoAllowed) {
    return NextResponse.json({ auditLogs, mode: "demo" });
  }

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("audit_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    if (isDemoAllowed) {
      return NextResponse.json({ auditLogs, mode: "demo" });
    }

    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ auditLogs: data });
}
