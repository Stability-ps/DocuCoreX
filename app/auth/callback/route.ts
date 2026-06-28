import { NextResponse } from "next/server";
import { getSiteUrl, isSupabaseConfigured } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { ensureUserWorkspace } from "@/lib/workspace-bootstrap";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const next = requestUrl.searchParams.get("next") || "/dashboard";

  if (!isSupabaseConfigured || !code) {
    return NextResponse.redirect(new URL(next, getSiteUrl()));
  }

  const supabase = await createSupabaseServerClient();

  await supabase?.auth.exchangeCodeForSession(code);
  const {
    data: { user },
  } = (await supabase?.auth.getUser()) ?? { data: { user: null } };

  if (user) {
    await ensureUserWorkspace(user);
  }

  return NextResponse.redirect(new URL(next, getSiteUrl()));
}
