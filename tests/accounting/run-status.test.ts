// "queued" means uploaded and waiting for someone to ask for processing; it
// does not mean work is underway.
//
// server.ts:504 inserts the run as "queued" at UPLOAD, and the process route
// only moves it to "processing" when work actually starts — uploading is not
// the same act as asking for processing. Conflating the two produced a
// production report of a "stuck pipeline": a run nobody had processed showed a
// "Processing… waiting for the latest accounting results." banner and a
// pipeline frozen on "Detecting PDF type", while the UI polled it 102 times
// waiting for a transition that could never come. Nothing was stuck. Nothing
// had been started.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

register("../pdf/alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { isActiveRunStatus, isRunInFlight, isRunAwaitingProcessing, isTerminalRunStatus } = await import(
  "@/lib/accounting/run-status.ts"
);

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

test("a queued run is NOT in flight", () => {
  assert.equal(isRunInFlight("queued"), false, "an upload nobody has processed is not work in progress");
  assert.equal(isRunAwaitingProcessing("queued"), true);
});

test("a processing run is in flight", () => {
  assert.equal(isRunInFlight("processing"), true);
  assert.equal(isRunAwaitingProcessing("processing"), false);
});

test("queued is still active and still non-terminal", () => {
  // The lifecycle answer is unchanged: a queued run is not finished, so
  // cancelling it is legitimate and pollers must not treat it as done.
  assert.equal(isActiveRunStatus("queued"), true);
  assert.equal(isTerminalRunStatus("queued"), false);
});

test("terminal states are neither in flight nor awaiting processing", () => {
  for (const status of ["completed", "failed", "review", "cancelled"]) {
    assert.equal(isRunInFlight(status), false, status);
    assert.equal(isRunAwaitingProcessing(status), false, status);
    assert.equal(isTerminalRunStatus(status), true, status);
  }
});

test("the processing banner and pipeline are driven by in-flight, not active", () => {
  const ui = read("components/accounting/accounting-intelligence.tsx");
  // The live-refresh state decides both the "Processing…" banner and whether
  // polling continues. Driving it from isActiveRunStatus is the regression.
  assert.doesNotMatch(
    ui,
    /setLiveRefreshState\(isActiveRunStatus/,
    "the processing banner must not treat a queued upload as work in progress",
  );
  assert.match(ui, /setLiveRefreshState\(isRunInFlight/);
  assert.match(ui, /isRunInFlight\(detail\.run\.status\) \? \(/, "the Processing in progress panel is gated on real work");
});

test("a queued run offers the explicit Process action", () => {
  const ui = read("components/accounting/accounting-intelligence.tsx");
  assert.match(ui, /isRunAwaitingProcessing\(detail\.run\.status\)/, "queued runs get their own state");
  assert.match(ui, /Ready to process/, "and say what they are waiting for");
});

// ── Job ownership ───────────────────────────────────────────────────────────
//
// Once the worker accepts a job it owns the outcome. The caller's timeout,
// disconnect or after() ending must not turn finished work into a failure —
// which is exactly what happened at 254s while extraction had succeeded.

const { isRunStalled, STALE_PROGRESS_THRESHOLD_MS } = await import("@/lib/accounting/run-status.ts");

test("a run with no acceptance is never stalled", () => {
  // Dispatch never completed, so there is nothing to be stalled — this is a
  // dispatch failure, which the caller owns and reports directly.
  assert.equal(isRunStalled("processing", null, null, Date.now()), false);
});

test("an accepted run that stopped moving is stalled", () => {
  const now = Date.now();
  const longAgo = new Date(now - STALE_PROGRESS_THRESHOLD_MS - 60_000).toISOString();
  assert.equal(isRunStalled("processing", longAgo, longAgo, now), true);
});

test("progress writes keep a slow statement out of the stalled state", () => {
  const now = Date.now();
  const acceptedLongAgo = new Date(now - STALE_PROGRESS_THRESHOLD_MS - 600_000).toISOString();
  const movedRecently = new Date(now - 30_000).toISOString();
  assert.equal(isRunStalled("processing", acceptedLongAgo, movedRecently, now), false);
});

test("only in-flight runs can be stalled", () => {
  const now = Date.now();
  const longAgo = new Date(now - STALE_PROGRESS_THRESHOLD_MS - 60_000).toISOString();
  for (const status of ["queued", "completed", "failed", "review", "cancelled"]) {
    assert.equal(isRunStalled(status, longAgo, longAgo, now), false, status);
  }
});

test("an accepted job is never failed by the caller", () => {
  const route = read("app/api/accounting/fnb/process/route.ts");
  assert.match(route, /if \(jobAccepted\) \{/, "failRun must bail once the worker owns the job");
  assert.match(route, /not failing an accepted job/);
  assert.match(route, /kind: "accepted"/, "202 is a distinct outcome from synchronous success");
});

test("dispatch goes to the dispatch endpoint and claims the run", () => {
  const route = read("app/api/accounting/fnb/process/route.ts");
  assert.match(route, /buildWorkerEndpoint\(workerUrl, "\/process-statement\/dispatch"\)/);
  assert.match(route, /active_job_id: detail\.run\.processingJobId/, "the run must claim the job before dispatch");
  assert.match(route, /job_accepted_at: new Date\(\)\.toISOString\(\)/, "acceptance is recorded");
});

test("worker writes are fenced and stale ones rejected", () => {
  const worker = read("workers/accounting_worker/main.py");
  assert.match(worker, /class StaleJobError/);
  assert.match(worker, /query\.eq\("active_job_id", job_id\)/, "updates are conditional on owning the run");
  assert.match(worker, /worker\.run_update_rejected_stale_job/, "a rejected write is logged, not swallowed");
  assert.match(worker, /@app\.post\("\/process-statement\/dispatch", status_code=202\)/);
  assert.match(worker, /@app\.post\("\/process-statement"\)/, "the synchronous endpoint stays available");
});
