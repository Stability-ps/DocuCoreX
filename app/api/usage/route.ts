import { NextResponse } from "next/server";
import { usageSummary } from "@/lib/mock-repository";
import { isAuthRequired } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  if (!supabase) {
    return NextResponse.json({ usage: usageSummary, mode: "demo" });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !isAuthRequired) {
    return NextResponse.json({ usage: usageSummary, mode: "demo" });
  }

  const { data, error } = await supabase
    .from("usage_counters")
    .select("*")
    .order("period_start", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    if (!isAuthRequired) {
      return NextResponse.json({ usage: usageSummary, mode: "demo" });
    }

    return NextResponse.json({ error: error?.message ?? "Usage counters not found" }, { status: 500 });
  }

  return NextResponse.json({ usage: data });
}
