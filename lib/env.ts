type Env = {
  NEXT_PUBLIC_SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  NEXT_PUBLIC_REQUIRE_AUTH?: string;
  NEXT_PUBLIC_SITE_URL?: string;
};

function optionalUrl(value: string | undefined, key: keyof Env) {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${key} must be a valid URL.`);
  }
}

function optionalString(value: string | undefined) {
  return value?.trim() || undefined;
}

export const env: Env = {
  NEXT_PUBLIC_SUPABASE_URL: optionalUrl(process.env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL"),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: optionalString(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  SUPABASE_SERVICE_ROLE_KEY: optionalString(process.env.SUPABASE_SERVICE_ROLE_KEY),
  NEXT_PUBLIC_REQUIRE_AUTH: optionalString(process.env.NEXT_PUBLIC_REQUIRE_AUTH),
  NEXT_PUBLIC_SITE_URL: optionalUrl(process.env.NEXT_PUBLIC_SITE_URL, "NEXT_PUBLIC_SITE_URL"),
};

export function requireSupabaseEnv() {
  const missing: string[] = [];

  if (!env.NEXT_PUBLIC_SUPABASE_URL) {
    missing.push("NEXT_PUBLIC_SUPABASE_URL");
  }

  if (!env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  return missing;
}
