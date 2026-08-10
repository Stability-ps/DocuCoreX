import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ui = readFileSync(join(root, "components/accounting/accounting-intelligence.tsx"), "utf8");

test("queued presentation cannot be overridden by optimistic local processing state", () => {
  assert.doesNotMatch(ui, /function applyRunRefreshState/);
  assert.doesNotMatch(ui, /setLiveRefreshState\("processing"\)/);
  assert.match(ui, /Ready to process/);
  assert.match(ui, /Processing has not started yet\./);
  assert.match(ui, /Process Statement/);
  assert.match(ui, /Process this statement to extract transactions\./);
});

test("process lifecycle begins only after the refreshed server state is in flight", () => {
  const processRun = ui.slice(ui.indexOf("async function processRun"), ui.indexOf("async function cancelRun"));
  assert.match(processRun, /fetch\("\/api\/accounting\/fnb\/process"/);
  assert.match(processRun, /const acceptedDetail = await refreshAccountingData/);
  assert.match(processRun, /if \(!isRunInFlight\(acceptedStatus\)\)/);
  assert.match(processRun, /setMessage\("Processing your statement\."\)/);
  assert.ok(
    processRun.indexOf("setMessage(\"Processing your statement.\")") > processRun.indexOf("if (!isRunInFlight(acceptedStatus))"),
    "the processing message must follow server acceptance",
  );
  assert.match(processRun, /catch \(processError\)[\s\S]*setLiveRefreshState\("idle"\)[\s\S]*setMessage\(""\)/);
  assert.match(processRun, /finally \{[\s\S]*setBusy\(""\)/);
});

test("an existing ledger cannot make a newly accepted reprocess look completed", () => {
  assert.match(ui, /const acceptedStatus = acceptedDetail[\s\S]*deriveEffectiveRunStatus/);
  const runStatus = readFileSync(join(root, "lib/accounting/run-status.ts"), "utf8");
  assert.match(runStatus, /if \(status === "processing"\) return "processing"/);
});

test("refreshing is short lived and clears even when refresh throws", () => {
  const refresh = ui.slice(ui.indexOf("async function refreshAccountingData"), ui.indexOf("// Keep upload-queue"));
  assert.match(refresh, /setLiveRefreshState\("refreshing"\)/);
  assert.match(refresh, /finally \{[\s\S]*setLiveRefreshState\("idle"\)/);
  assert.doesNotMatch(refresh, /"processing"/);
});

test("queued metrics are unknown rather than fake zero or calculating values", () => {
  assert.match(ui, /const awaiting = isRunAwaitingProcessing/);
  assert.match(ui, /label: "Review", value: noCalculatedRows \? "—"/);
  assert.doesNotMatch(ui, /Confidence: Calculating/);
});

test("processing exposes cancel but not retry controls", () => {
  const processingPanel = ui.slice(ui.indexOf("{isRunInFlight(selectedEffectiveStatus)"), ui.indexOf("{selectedEffectiveStatus === \"review\""));
  assert.match(processingPanel, /Cancel processing/);
  assert.doesNotMatch(processingPanel, />\s*Retry\s*</);
  assert.doesNotMatch(processingPanel, /Force Reprocess/);
});

test("bulk selection and transaction tools are explicit", () => {
  assert.match(ui, /selectionMode \? "Done Selecting" : "Select"/);
  assert.match(ui, /\{selectionMode \? <input/);
  assert.match(ui, /detail\.transactions\.length \? \(/);
  assert.equal((ui.match(/Upload Statement/g) ?? []).length >= 1, true);
  assert.doesNotMatch(ui, /Upload Statements/);
  assert.doesNotMatch(ui, /FNB bank statements/);
});

test("the whole statement row toggles selection while select mode is active", () => {
  assert.match(ui, /onClick=\{\(\) => \(selectionMode \? onToggleSelected\(run\.id\) : onSelect\(run\.id\)\)\}/);
  assert.match(ui, /if \(selectionMode\) onToggleSelected\(run\.id\);[\s\S]*else onSelect\(run\.id\);/);
  assert.match(ui, /aria-pressed=\{selectionMode \? selectedRunIds\.includes\(run\.id\) : undefined\}/);
});
