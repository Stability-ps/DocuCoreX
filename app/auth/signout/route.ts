import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export async function GET(request: Request) {
  const origin = new URL(request.url).origin;

  if (!isSupabaseConfigured) {
    return NextResponse.redirect(new URL("/login", origin));
  }

  const supabase = await createSupabaseServerClient();

  await supabase?.auth.signOut();

  return NextResponse.redirect(new URL("/login", origin));
}
