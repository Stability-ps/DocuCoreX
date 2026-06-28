import { NextResponse } from "next/server";
import { auditLogs } from "@/lib/mock-repository";
import { isAuthRequired } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  if (!supabase) {
    return NextResponse.json({ auditLogs, mode: "demo" });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !isAuthRequired) {
    return NextResponse.json({ auditLogs, mode: "demo" });
  }

  const { data, error } = await supabase
    .from("audit_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    if (!isAuthRequired) {
      return NextResponse.json({ auditLogs, mode: "demo" });
    }

    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ auditLogs: data });
}
