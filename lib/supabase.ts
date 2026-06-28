import { createBrowserClient } from "@supabase/ssr";
import { env } from "@/lib/env";

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);
export const isProduction = process.env.NODE_ENV === "production";
export const isAuthRequired = isProduction ? process.env.NEXT_PUBLIC_REQUIRE_AUTH !== "false" : process.env.NEXT_PUBLIC_REQUIRE_AUTH === "true";
export const isDemoAllowed = !isProduction && process.env.NEXT_PUBLIC_ENABLE_DEMO_MODE === "true";

export const supabase = isSupabaseConfigured
  ? createBrowserClient(supabaseUrl as string, supabaseAnonKey as string)
  : null;

export function getSiteUrl() {
  return process.env.NEXT_PUBLIC_SITE_URL || "http://127.0.0.1:3000";
}
