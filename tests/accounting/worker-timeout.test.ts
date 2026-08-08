// The accounting worker request budget.
//
// Production aborted /api/accounting/fnb/process at 120s while the function was
// allowed 300s, so statements that had not failed — only taken longer than an
// arbitrary limit — were reported as worker timeouts. These guard the corrected
// budget and, more importantly, the RELATIONSHIP between the two numbers, which
// is what actually matters: a worker timeout at or above maxDuration means
// Vercel kills the function before the AbortController can produce a diagnosable
// error.
//
// These are source-level assertions, matching how the rest of this route's
// constants are guarded in export.test.ts. They prove the constant is wired into
// the abort and that nothing else governs the worker fetch; they do not execute
// the abort. Doing that would mean extracting the fetch from the route handler
// into an injectable helper, which is a refactor rather than a timeout change.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const route = readFileSync(join(root, "app/api/accounting/fnb/process/route.ts"), "utf8");

function number(pattern: RegExp, label: string) {
  const match = route.match(pattern);
  assert.ok(match, `${label} not found in the route`);
  return Number(match[1].replace(/_/g, ""));
}

const workerTimeoutMs = () => number(/const ACCOUNTING_WORKER_TIMEOUT_MS = ([0-9_]+);/, "ACCOUNTING_WORKER_TIMEOUT_MS");
const maxDurationS = () => number(/export const maxDuration = (\d+);/, "maxDuration");

test("the worker request is allowed well beyond the old 120s ceiling", () => {
  assert.equal(workerTimeoutMs(), 280_000);
  assert.ok(workerTimeoutMs() > 120_000, "the 120s ceiling is what this route was fixed to stop imposing");
});

test("the worker timeout leaves headroom inside the function's own lifetime", () => {
  const budgetMs = maxDurationS() * 1000;
  assert.equal(maxDurationS(), 300);
  assert.ok(
    workerTimeoutMs() < budgetMs,
    `worker timeout ${workerTimeoutMs()}ms must stay under maxDuration ${budgetMs}ms, or Vercel kills the ` +
      "function before the AbortController fires and the failure is undiagnosable",
  );
  assert.ok(
    budgetMs - workerTimeoutMs() >= 15_000,
    "leave at least 15s for response handling and cleanup after the worker returns",
  );
});

test("the configured timeout is the one that aborts the worker fetch", () => {
  // Not just "a timeout exists" — the constant must be the value driving the
  // abort, and the fetch must actually carry that controller's signal.
  assert.match(route, /const controller = new AbortController\(\);/);
  assert.match(route, /setTimeout\(\(\) => controller\.abort\(\), ACCOUNTING_WORKER_TIMEOUT_MS\)/);
  assert.match(route, /signal: controller\.signal,/);
  assert.match(route, /clearTimeout\(timer\)/, "the timer must be cleared so a fast response does not leak it");
});

test("no second, lower timeout governs the worker request", () => {
  // The regression this file exists for was a single hardcoded ceiling. A stray
  // 120s anywhere in this route would reintroduce it silently.
  const stray = route.match(/\b120_?000\b/g) ?? [];
  assert.deepEqual(stray, [], `route still contains a 120s constant: ${stray.join(", ")}`);

  // Any other abort timer in this file must also be driven by a named constant
  // rather than a literal, so it cannot quietly undercut the budget.
  const literalAborts = route.match(/setTimeout\([^)]*abort[^)]*,\s*\d/g) ?? [];
  assert.deepEqual(literalAborts, [], `abort timer with a literal delay: ${literalAborts.join(", ")}`);
});
