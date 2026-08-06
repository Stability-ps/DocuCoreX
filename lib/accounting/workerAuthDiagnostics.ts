// TEMPORARY (2026-08-06) — outbound half of a two-sided shared-secret comparison.
//
// The Vercel and Render dashboards both show a token with SHA-256 prefix
// 75e596d1b6be, yet the worker answers 401 "Invalid credentials." to that exact
// value. Dashboards show what was STORED; this shows what the runtime actually
// HOLDS. The two are not the same thing when a value carries an invisible
// character, or when the process has not restarted since the variable changed.
//
// REMOVE once the mismatch is identified. Kill switch without a deploy:
// WORKER_AUTH_DIAGNOSTICS=false.
//
// SECRET SAFETY — what may and may not be emitted.
//   emitted : full SHA-256 digest, length, presence
//   NEVER   : the token, any prefix or substring of it, the Authorization
//             header, or any encoding from which the value could be recovered
//
// A full unsalted digest is a permanent offline verification oracle for the
// value. That is acceptable here only because the token is ~256 bits of
// randomness, which is not brute-forceable. It would NOT be acceptable for a
// low-entropy or human-chosen secret.
import { createHash } from "node:crypto";

export type OutboundAuthDiagnostics = {
  event: "accounting_worker.auth_outbound";
  token_present: boolean;
  token_length: number;
  token_sha256: string | null;
  /** Length before trimming, so an invisible trailing character is visible as a delta. */
  token_raw_length: number;
  /** True when raw and trimmed differ — i.e. the stored value carries surrounding whitespace. */
  token_had_surrounding_whitespace: boolean;
  /** True when the trimmed token contains whitespace INSIDE it, which breaks Bearer parsing. */
  token_has_inner_whitespace: boolean;
  /** True when the token is not pure ASCII — a pasted homoglyph or zero-width char. */
  token_is_ascii: boolean;
  authorization_header_added: boolean;
  worker_endpoint: string;
  vercel_environment: string | null;
  vercel_deployment_id: string | null;
  vercel_commit: string | null;
};

/** Full SHA-256 of the exact bytes supplied. Null for an absent value. */
export function sha256(value: string | null | undefined): string | null {
  if (value == null) return null;
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Host only — never the path, which can carry identifiers. */
export function sanitizeEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "unparseable";
  }
}

export function diagnosticsEnabled(): boolean {
  return process.env.WORKER_AUTH_DIAGNOSTICS !== "false";
}

/**
 * Build the outbound diagnostic record.
 *
 * The digest is taken of the TRIMMED token — the exact bytes placed after
 * "Bearer " — so it is directly comparable with the worker's digest of what it
 * parsed out of the header. Digesting the raw value instead would make the two
 * sides differ whenever whitespace was present and tell us nothing about the
 * comparison that actually failed.
 */
export function buildOutboundDiagnostics(input: {
  rawToken: string | undefined;
  workerEndpoint: string;
}): OutboundAuthDiagnostics {
  const raw = input.rawToken ?? "";
  const trimmed = raw.trim();
  const present = trimmed.length > 0;
  return {
    event: "accounting_worker.auth_outbound",
    token_present: present,
    token_length: trimmed.length,
    token_sha256: present ? sha256(trimmed) : null,
    token_raw_length: raw.length,
    token_had_surrounding_whitespace: raw.length !== trimmed.length,
    token_has_inner_whitespace: /\s/.test(trimmed),
    token_is_ascii: /^[\x20-\x7e]*$/.test(trimmed),
    authorization_header_added: present,
    worker_endpoint: sanitizeEndpoint(input.workerEndpoint),
    vercel_environment: process.env.VERCEL_ENV ?? null,
    vercel_deployment_id: process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_URL ?? null,
    vercel_commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  };
}

/** Thrown before any worker call when the token is absent — never silently omitted. */
export class WorkerTokenMissingError extends Error {
  constructor() {
    super(
      "ACCOUNTING_WORKER_TOKEN is not set in this runtime, so no Authorization header can be sent. " +
        "This is a server configuration error — the request was not attempted.",
    );
    this.name = "WorkerTokenMissingError";
  }
}
