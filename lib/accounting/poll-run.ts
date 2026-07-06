import type { AccountingRunStatus } from "@/lib/accounting/types";
import { deriveEffectiveRunStatus, isTerminalRunStatus } from "@/lib/accounting/run-status";

// Terminal states — polling stops here: "completed", "failed", "review", "cancelled".
// (See lib/accounting/run-status.ts for the shared terminal set.)

export type PollRunResult = { status: AccountingRunStatus | null; error: string | null; timedOut: boolean };

type RunDetailResponse = {
  run?: {
    status?: AccountingRunStatus;
    error?: string | null;
    transactionCount?: number | null;
    requiresReview?: boolean | null;
    validationStatus?: string | null;
  };
  transactions?: unknown[];
};

// Polls the run detail endpoint until the run reaches a terminal state (or the
// timeout elapses). Processing happens in the background on the server, so the UI
// polls instead of holding the request open. We stop as soon as the run is
// *effectively* terminal — transactions written, review flagged, or validation
// resolved — even if the status row still reads "processing" (status-sync Req 1).
// Defensive: transient fetch errors are ignored and retried.
export async function pollRunUntilTerminal(
  runId: string,
  options: { intervalMs?: number; timeoutMs?: number; onTick?: (status: AccountingRunStatus | null) => void } = {},
): Promise<PollRunResult> {
  const intervalMs = options.intervalMs ?? 3000;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    try {
      const response = await fetch(`/api/accounting/fnb/runs/${runId}`, { cache: "no-store" });
      if (response.ok) {
        const data = (await response.json().catch(() => ({}))) as RunDetailResponse;
        const run = data.run ?? null;
        const txCount = Array.isArray(data.transactions) ? data.transactions.length : undefined;
        const effective = run ? deriveEffectiveRunStatus(run, txCount) : null;
        options.onTick?.(effective);
        if (isTerminalRunStatus(effective)) {
          return { status: effective, error: run?.error ?? null, timedOut: false };
        }
      }
    } catch {
      // Ignore transient errors and keep polling until the deadline.
    }
  }
  return { status: null, error: null, timedOut: true };
}
