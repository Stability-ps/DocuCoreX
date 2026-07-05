import { createBrowserClient } from "@supabase/ssr";
import { env } from "@/lib/env";
import { computeAccessFlags } from "@/lib/access-mode";

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

const accessFlags = computeAccessFlags({
  supabaseConfigured: isSupabaseConfigured,
  nodeEnv: process.env.NODE_ENV,
  requireAuth: process.env.NEXT_PUBLIC_REQUIRE_AUTH,
  enableDemo: process.env.NEXT_PUBLIC_ENABLE_DEMO_MODE,
});

export const isProduction = accessFlags.isProduction;
// Auth is required whenever Supabase is configured (never serve unauthenticated
// data from a real backend) and in production by default.
export const isAuthRequired = accessFlags.isAuthRequired;
// Demo/mock data is ONLY reachable when there is NO Supabase backend configured.
// With Supabase present this is always false, so no user can ever fall back to
// the shared in-memory demo store.
export const isDemoAllowed = accessFlags.isDemoAllowed;

export const supabase = isSupabaseConfigured
  ? createBrowserClient(supabaseUrl as string, supabaseAnonKey as string)
  : null;

export function getSiteUrl() {
  return process.env.NEXT_PUBLIC_SITE_URL || "http://127.0.0.1:3000";
}
