import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase-server";

// Rate limits shared by every server instance (migration 050).
//
// lib/rate-limit.ts counts in a per-process Map, so on Vercel each function
// instance had its own allowance. These limits are counted in Postgres through
// consume_rate_limit, which only the service role may call.
//
// If the shared counter is unavailable (no service-role key, the migration not
// yet applied, a network error) the call falls back to the per-process limiter:
// the protection of today, never none and never a refused request.

export const RATE_LIMITS = {
  // Unauthenticated, keyed by client IP.
  signin: { limit: 10, windowSeconds: 15 * 60 },
  signup: { limit: 5, windowSeconds: 60 * 60 },
  // Keyed by workspace once signed in, by IP before that.
  upload: { limit: 30, windowSeconds: 60 },
  signedUpload: { limit: 30, windowSeconds: 60 },
  // The document list polls this for up to 5 active documents every 2.5 s, about
  // 120 calls a minute per open tab, so the ceiling sits well above that. It
  // exists to stop a runaway client or script, not to shape normal use.
  processJobs: { limit: 600, windowSeconds: 60 },
  // These can call paid providers (Azure, Mistral, OpenAI) on every request.
  ocr: { limit: 60, windowSeconds: 60 },
  extraction: { limit: 60, windowSeconds: 60 },
  pdfAnalyze: { limit: 60, windowSeconds: 60 },
  accountingProcess: { limit: 30, windowSeconds: 60 },
  ai: { limit: 20, windowSeconds: 60 },
  search: { limit: 120, windowSeconds: 60 },
  apiKeyCreate: { limit: 10, windowSeconds: 60 * 60 },
} as const;

export type RateLimitName = keyof typeof RATE_LIMITS;

export type RateLimitIdentity = { workspaceId?: string | null; request?: Request };

export type RateLimitDecision = { ok: boolean; retryAfterMs: number; source: "shared" | "local" };

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};

export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * The counter key. Holds a truncated SHA-256 of the identifier, never the raw IP
 * address or workspace id: the table is operational data and should not become
 * a log of who connected from where.
 */
export function rateLimitKey(name: RateLimitName, identity: RateLimitIdentity): string {
  const [scope, value] = identity.workspaceId
    ? ["ws", identity.workspaceId]
    : ["ip", identity.request ? clientIp(identity.request) : "unknown"];
  const digest = createHash("sha256").update(`${scope}:${value}`).digest("hex").slice(0, 32);
  return `${name}:${scope}:${digest}`;
}

let warnedUnavailable = false;
let serviceClient: RpcClient | null | undefined;

function defaultClient(): RpcClient | null {
  if (serviceClient === undefined) serviceClient = createSupabaseServiceRoleClient();
  return serviceClient;
}

export async function consumeRateLimit(
  name: RateLimitName,
  identity: RateLimitIdentity,
  client: RpcClient | null = defaultClient(),
): Promise<RateLimitDecision> {
  const { limit, windowSeconds } = RATE_LIMITS[name];
  const key = rateLimitKey(name, identity);

  if (client) {
    try {
      const { data, error } = await client.rpc("consume_rate_limit", {
        p_key: key,
        p_limit: limit,
        p_window_seconds: windowSeconds,
      });
      const row = Array.isArray(data) ? (data[0] as { allowed?: unknown; retry_after_ms?: unknown } | undefined) : undefined;
      if (!error && row && typeof row.allowed === "boolean") {
        return { ok: row.allowed, retryAfterMs: Number(row.retry_after_ms) || 0, source: "shared" };
      }
      warnUnavailable(error?.code ?? (error ? "rpc_error" : "unexpected_shape"));
    } catch (error) {
      warnUnavailable(error instanceof Error ? error.name : "rpc_threw");
    }
  }

  const local = checkRateLimit(key, { limit, windowMs: windowSeconds * 1000 });
  return { ...local, source: "local" };
}

/**
 * Enforce a limit inside a route: returns a 429 response to send, or null to
 * carry on. The response never says which identifier was limited.
 */
export async function enforceRateLimit(
  name: RateLimitName,
  identity: RateLimitIdentity,
  message = "Too many requests. Try again in a moment.",
  client: RpcClient | null = defaultClient(),
): Promise<NextResponse | null> {
  const decision = await consumeRateLimit(name, identity, client);
  if (decision.ok) return null;
  console.warn("docucorex.rate_limit.exceeded", {
    limit: name,
    scope: identity.workspaceId ? "workspace" : "ip",
    source: decision.source,
  });
  return NextResponse.json(
    { error: message, code: "RATE_LIMITED" },
    { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))) } },
  );
}

// Once per process: the fallback is safe, but it should not be silent.
function warnUnavailable(reason: string) {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  console.warn("docucorex.rate_limit.shared_unavailable", { reason, fallback: "per-process" });
}
