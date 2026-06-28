import { NextResponse } from "next/server";
import { getSiteUrl, isSupabaseConfigured } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export async function GET() {
  if (!isSupabaseConfigured) {
    return NextResponse.redirect(new URL("/login", getSiteUrl()));
  }

  const supabase = await createSupabaseServerClient();

  await supabase?.auth.signOut();

  return NextResponse.redirect(new URL("/login", getSiteUrl()));
}
