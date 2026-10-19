// The scheduled backstop for document processing (vercel.json cron on
// GET /api/jobs/process).
//
// Processing is driven by the browser: the documents page polls
// /api/jobs/process for its active documents. A document whose uploader closed
// the tab therefore stayed queued until someone opened the page again. The cron
// was meant to catch those, but it called POST with no session, which a real
// backend answers 401, so it never processed anything.
//
// It now authenticates with CRON_SECRET (Vercel sends it as a bearer token),
// finds documents with queued/running generic jobs, and hands each to the
// conversion worker exactly as the browser's request would be handed on, minus
// the cookie: the worker resolves the document's workspace with the service role
// and decides for itself which jobs are claimable (stale "running" jobs only,
// accounting jobs never). Sequential and time-boxed, because the worker is a
// 512 MB instance and OCR can take most of a minute.

import { workerSecretMatches } from "@/lib/worker-secret";

export type CronAuth = "ok" | "unconfigured" | "invalid";

export function cronAuthorization(authorizationHeader: string | null, configuredSecret: string | undefined): CronAuth {
  if (!configuredSecret?.trim()) return "unconfigured";
  const token = authorizationHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
  return workerSecretMatches(token, configuredSecret) ? "ok" : "invalid";
}

export type SweepDeps = {
  findDocumentIds: (limit: number) => Promise<string[]>;
  dispatch: (documentId: string, timeoutMs: number) => Promise<{ ok: boolean; status: number }>;
  now?: () => number;
};

export type SweepResult = {
  candidates: number;
  dispatched: number;
  succeeded: number;
  failed: number;
  skippedForTime: number;
};

export const SWEEP_MAX_DOCUMENTS = 25;
// Leaves headroom under the route's 300 s maxDuration for the query and response.
export const SWEEP_BUDGET_MS = 240_000;
const PER_DOCUMENT_TIMEOUT_MS = 120_000;
const MIN_TIME_TO_START_MS = 30_000;

export async function runCronSweep(deps: SweepDeps, budgetMs = SWEEP_BUDGET_MS): Promise<SweepResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const ids = Array.from(new Set(await deps.findDocumentIds(SWEEP_MAX_DOCUMENTS)));
  const result: SweepResult = { candidates: ids.length, dispatched: 0, succeeded: 0, failed: 0, skippedForTime: 0 };

  for (const id of ids) {
    const remaining = budgetMs - (now() - started);
    if (remaining < MIN_TIME_TO_START_MS) {
      result.skippedForTime = ids.length - result.dispatched;
      break;
    }
    result.dispatched += 1;
    try {
      const outcome = await deps.dispatch(id, Math.min(PER_DOCUMENT_TIMEOUT_MS, remaining));
      if (outcome.ok) result.succeeded += 1;
      else result.failed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
