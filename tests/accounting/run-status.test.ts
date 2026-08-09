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
