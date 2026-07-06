import type { AccountingRunStatus } from "@/lib/accounting/types";

// Terminal states — polling stops here.
const TERMINAL: AccountingRunStatus[] = ["completed", "failed", "review", "cancelled"];

export type PollRunResult = { status: AccountingRunStatus | null; error: string | null; timedOut: boolean };

// Polls the run status endpoint until the run reaches a terminal state (or the
// timeout elapses). Processing now happens in the background on the server, so the
// UI polls instead of holding the request open. Defensive: transient fetch errors
// are ignored and retried.
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
        const data = (await response.json().catch(() => ({}))) as { run?: { status?: AccountingRunStatus; error?: string | null } };
        const status = data.run?.status ?? null;
        options.onTick?.(status);
        if (status && TERMINAL.includes(status)) {
          return { status, error: data.run?.error ?? null, timedOut: false };
        }
      }
    } catch {
      // Ignore transient errors and keep polling until the deadline.
    }
  }
  return { status: null, error: null, timedOut: true };
}
