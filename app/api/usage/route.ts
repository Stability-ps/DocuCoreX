import { NextResponse } from "next/server";
import { usageSummary } from "@/lib/mock-repository";
import { isDemoAllowed } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  if (!supabase && isDemoAllowed) {
    return NextResponse.json({ usage: usageSummary, mode: "demo" });
  }

  if (!supabase) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && isDemoAllowed) {
    return NextResponse.json({ usage: usageSummary, mode: "demo" });
  }

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("usage_counters")
    .select("*")
    .order("period_start", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    if (isDemoAllowed) {
      return NextResponse.json({ usage: usageSummary, mode: "demo" });
    }

    return NextResponse.json({ error: error?.message ?? "Usage counters not found" }, { status: 500 });
  }

  return NextResponse.json({ usage: data });
}
