import { createHash, timingSafeEqual } from "node:crypto";

export const WORKER_SECRET_HEADER = "x-docucorex-worker-secret";

/**
 * Constant-time check of the conversion worker's shared secret.
 *
 * `provided === configured` returns as soon as the first byte differs, which
 * leaks how much of a guess was right through response timing. Both sides are
 * hashed first so timingSafeEqual always compares 32 bytes: it throws on unequal
 * lengths, and comparing digests also hides the secret's length. Both sides are
 * trimmed, as the comparisons this replaces were.
 *
 * An empty or missing configured secret never matches: callers must fail closed.
 */
export function workerSecretMatches(provided: string | null | undefined, configured: string | null | undefined): boolean {
  const expected = configured?.trim();
  const candidate = provided?.trim();
  if (!expected || !candidate) return false;
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(candidate), digest(expected));
}

export function requestCarriesWorkerSecret(request: Request): boolean {
  return workerSecretMatches(request.headers.get(WORKER_SECRET_HEADER), process.env.CONVERSION_WORKER_SECRET);
}
