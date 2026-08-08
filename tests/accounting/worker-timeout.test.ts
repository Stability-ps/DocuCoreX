// The accounting worker request budget.
//
// Two defects, fixed in sequence. First the route aborted the worker at 120s
// inside a 300s window, so statements that had not failed — only run longer than
// an arbitrary limit — were reported as timeouts (#71). Raising the ceiling to
// 280s then exposed the real problem: 300s covers the WHOLE request, and
// pre-extraction plus two worker calls could exceed it, at which point the
// platform kills the function before any AbortController fires and the failure
// arrives with no diagnosable message.
//
// The stages now share one deadline. These guard that arrangement — that a call
// takes the smaller of its ceiling and the remaining budget, that an exhausted
// budget fails with a message instead of a doomed request, and that the total
// cannot outlive maxDuration.
//
// Source-level assertions, matching how this route's constants are guarded in
// export.test.ts. They prove the wiring; they do not execute an abort. That
// would mean extracting the fetch into an injectable helper — a refactor, not a
// timeout change.
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

const workerCeilingMs = () => number(/const ACCOUNTING_WORKER_TIMEOUT_MS = ([0-9_]+);/, "ACCOUNTING_WORKER_TIMEOUT_MS");
const budgetMs = () => number(/const ACCOUNTING_REQUEST_BUDGET_MS = ([0-9_]+);/, "ACCOUNTING_REQUEST_BUDGET_MS");
const minSliceMs = () => number(/const ACCOUNTING_MIN_WORKER_SLICE_MS = ([0-9_]+);/, "ACCOUNTING_MIN_WORKER_SLICE_MS");
const maxDurationS = () => number(/export const maxDuration = (\d+);/, "maxDuration");

test("the worker request is allowed well beyond the old 120s ceiling", () => {
  assert.equal(workerCeilingMs(), 280_000);
  assert.ok(workerCeilingMs() > 120_000, "the 120s ceiling is what this route was fixed to stop imposing");
});

test("the whole request budget fits inside the function's lifetime", () => {
  const lifetimeMs = maxDurationS() * 1000;
  assert.equal(maxDurationS(), 300);
  assert.ok(
    budgetMs() < lifetimeMs,
    `budget ${budgetMs()}ms must stay under maxDuration ${lifetimeMs}ms, or the platform kills the function ` +
      "before any abort fires and the failure is undiagnosable",
  );
  assert.ok(lifetimeMs - budgetMs() >= 15_000, "leave at least 15s for response handling and cleanup");
});

test("a worker call takes the smaller of its ceiling and the remaining budget", () => {
  // The heart of it. Without the min(), two 280s calls fit in a 300s window on
  // paper and not in reality.
  assert.match(route, /const deadlineAt = Date\.now\(\) \+ ACCOUNTING_REQUEST_BUDGET_MS;/, "one deadline per request");
  assert.match(route, /const remainingBudgetMs = \(\) => deadlineAt - Date\.now\(\);/);
  assert.match(
    route,
    /const sliceMs = Math\.min\(ACCOUNTING_WORKER_TIMEOUT_MS, remainingBudgetMs\(\)\);/,
    "the call must be bounded by what is left, not only by its own ceiling",
  );
  assert.match(route, /setTimeout\(\(\) => controller\.abort\(\), sliceMs\)/, "the abort uses the granted slice");
  assert.match(route, /signal: controller\.signal,/);
  assert.match(route, /clearTimeout\(timer\)/, "the timer must be cleared so a fast response does not leak it");
});

test("an exhausted budget fails with a message rather than a doomed request", () => {
  assert.match(route, /if \(sliceMs < ACCOUNTING_MIN_WORKER_SLICE_MS\)/, "refuses to dispatch without a usable slice");
  assert.match(route, /budget exhausted/, "logs the exhaustion distinctly from a worker timeout");
  assert.match(route, /kind: "unreachable"/, "returns an outcome the caller can act on");
  assert.ok(minSliceMs() > 0 && minSliceMs() < budgetMs(), "the floor must be a real slice of the budget");
});

test("the reported timeout is the slice granted, not the ceiling", () => {
  // On a retry, or after slow pre-extraction, they differ. Reporting the ceiling
  // would send someone hunting for a timeout that never applied.
  assert.match(route, /timed out after \$\{Math\.round\(sliceMs \/ 1000\)\}s/);
  assert.doesNotMatch(
    route,
    /timed out after \$\{ACCOUNTING_WORKER_TIMEOUT_MS \/ 1000\}s/,
    "must not report the ceiling as though it were the applied timeout",
  );
});

test("no stray 120s literal remains in the route", () => {
  const stray = route.match(/\b120_?000\b/g) ?? [];
  assert.deepEqual(stray, [], `route still contains a 120s constant: ${stray.join(", ")}`);

  const literalAborts = route.match(/setTimeout\([^)]*abort[^)]*,\s*\d/g) ?? [];
  assert.deepEqual(literalAborts, [], `abort timer with a literal delay: ${literalAborts.join(", ")}`);
});
