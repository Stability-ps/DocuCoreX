// Local development must not run against the production database by accident.
//
// Until now .env.local and the production deployment resolved to the same
// Supabase project (docs/PRODUCTION_MIGRATION_READINESS.md, "Environment
// risk"), so a developer's test upload, a half-finished migration experiment or
// a QA cleanup script acted on customer data. This refuses to start `next dev`
// against the production project unless that is asked for explicitly.
//
// The project ref is not a secret: it is part of the public Supabase URL every
// browser receives.

export const PRODUCTION_SUPABASE_PROJECT_REF = "efprtqcpglsawifrsmcc";

export const ALLOW_PRODUCTION_DATABASE_FLAG = "DOCUCOREX_ALLOW_PRODUCTION_DATABASE";

type Env = Record<string, string | undefined>;

/** The project ref from a Supabase URL (https://<ref>.supabase.co), or null. */
export function supabaseProjectRef(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    const match = host.match(/^([a-z0-9]+)\.supabase\.(co|in)$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Null when this environment may use the database it is configured for, or the
 * reason it may not. Deployed runtimes (Vercel, Render) and production builds
 * are never refused: they are where production belongs.
 */
export function productionDatabaseRefusal(env: Env): string | null {
  const deployed = Boolean(env.VERCEL || env.RENDER || env.RENDER_SERVICE_ID);
  if (deployed || env.NODE_ENV === "production") return null;
  if (supabaseProjectRef(env.NEXT_PUBLIC_SUPABASE_URL) !== PRODUCTION_SUPABASE_PROJECT_REF) return null;
  if (env[ALLOW_PRODUCTION_DATABASE_FLAG] === "true") return null;
  return [
    "Refusing to start: NEXT_PUBLIC_SUPABASE_URL points at the PRODUCTION Supabase project",
    `(${PRODUCTION_SUPABASE_PROJECT_REF}) and this is not a deployment.`,
    "Point .env.local at a development project or a local Supabase stack (`supabase start`).",
    `If you really mean to work against production data, set ${ALLOW_PRODUCTION_DATABASE_FLAG}=true for this session.`,
  ].join(" ");
}
