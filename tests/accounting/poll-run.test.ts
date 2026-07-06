import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { pollRunUntilTerminal } = await import("@/lib/accounting/poll-run.ts");
const { deriveEffectiveRunStatus, isActiveRunStatus, isTerminalRunStatus } = await import("@/lib/accounting/run-status.ts");

test("active run status treats queued processing and pending as live states", () => {
  assert.equal(isActiveRunStatus("queued"), true);
  assert.equal(isActiveRunStatus("processing"), true);
  assert.equal(isActiveRunStatus("pending"), true);
  assert.equal(isActiveRunStatus("completed"), false);
  assert.equal(isActiveRunStatus("failed"), false);
});

test("terminal run status treats error as terminal", () => {
  assert.equal(isTerminalRunStatus("completed"), true);
  assert.equal(isTerminalRunStatus("review"), true);
  assert.equal(isTerminalRunStatus("failed"), true);
  assert.equal(isTerminalRunStatus("cancelled"), true);
  assert.equal(isTerminalRunStatus("error" as never), true);
});

test("deriveEffectiveRunStatus maps runtime error to failed", () => {
  assert.equal(deriveEffectiveRunStatus({ status: "error" as never }), "failed");
});

test("pollRunUntilTerminal keeps polling until the run reaches a terminal state", async () => {
  const originalFetch = globalThis.fetch;
  const ticks: Array<string | null> = [];
  let callCount = 0;

  globalThis.fetch = (async () => {
    callCount += 1;
    const payload =
      callCount === 1
        ? { run: { status: "processing", error: null, transactionCount: 0 }, transactions: [] }
        : { run: { status: "review", error: "Needs review", transactionCount: 0, requiresReview: true }, transactions: [] };

    return {
      ok: true,
      json: async () => payload,
    } as Response;
  }) as typeof fetch;

  try {
    const result = await pollRunUntilTerminal("run-1", {
      intervalMs: 0,
      timeoutMs: 50,
      onTick: (status) => ticks.push(status),
    });

    assert.equal(result.status, "review");
    assert.equal(result.error, "Needs review");
    assert.equal(result.timedOut, false);
    assert.deepEqual(ticks, ["processing", "review"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

