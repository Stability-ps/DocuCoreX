// Central, pure resolution of the app's data-access mode.
//
// SECURITY INVARIANT (P0 data isolation):
//   When a real Supabase project is configured, demo/mock data must be
//   completely unreachable. Demo mode only exists for local development with
//   NO Supabase backend. This guarantees that a misconfigured environment
//   (e.g. NODE_ENV not "production", or NEXT_PUBLIC_REQUIRE_AUTH unset) can
//   never cause one user to be served another user's (or seeded demo) data.
//
// This function is pure so it can be unit-tested exhaustively — see
// tests/security/access-mode.test.mjs.

export type AccessFlagInput = {
  /** True when both NEXT_PUBLIC_SUPABASE_URL and _ANON_KEY are present. */
  supabaseConfigured: boolean;
  nodeEnv?: string;
  requireAuth?: string;
  enableDemo?: string;
};

export type AccessFlags = {
  isProduction: boolean;
  isAuthRequired: boolean;
  isDemoAllowed: boolean;
};

export function computeAccessFlags(input: AccessFlagInput): AccessFlags {
  const isProduction = input.nodeEnv === "production";

  // Auth is required in production unless explicitly disabled; in development it
  // is opt-in. It is ALSO always required whenever Supabase is configured — a
  // real backend must never serve unauthenticated data.
  const isAuthRequired = input.supabaseConfigured
    ? true
    : isProduction
      ? input.requireAuth !== "false"
      : input.requireAuth === "true";

  // Demo mode is ONLY ever allowed when there is no real backend configured.
  // This is the linchpin of data isolation: no Supabase → in-memory demo store;
  // Supabase present → demo is impossible, period.
  const isDemoAllowed =
    !input.supabaseConfigured && !isProduction && input.enableDemo === "true";

  return { isProduction, isAuthRequired, isDemoAllowed };
}
