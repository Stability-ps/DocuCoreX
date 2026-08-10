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

test("a successful process response starts polling despite a stale immediate refresh", () => {
  const processRun = ui.slice(ui.indexOf("async function processRun"), ui.indexOf("async function cancelRun"));
  assert.match(processRun, /fetch\("\/api\/accounting\/fnb\/process"/);
  assert.match(processRun, /if \(!response\.ok\)/);
  assert.match(processRun, /setMessage\("Processing your statement\."\)/);
  assert.match(processRun, /await refreshAccountingData\(runId, \{ silent: true \}\)\.catch/);
  assert.match(processRun, /const outcome = await pollRunUntilTerminal/);
  assert.doesNotMatch(processRun, /Processing was not accepted by the server/);
  assert.match(processRun, /catch \(processError\)[\s\S]*setLiveRefreshState\("idle"\)[\s\S]*setMessage\(""\)/);
  assert.match(processRun, /finally \{[\s\S]*setBusy\(""\)/);
});

test("an existing ledger cannot make a newly accepted reprocess look completed", () => {
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
  assert.doesNotMatch(ui, /selectionMode|Done Selecting/);
  assert.match(ui, /aria-label="Select visible statements"/);
  assert.match(ui, /aria-label=\{`Select \$\{runDisplayTitle\(run\)\} for combined workbook`\}/);
  assert.match(ui, /detail\.transactions\.length \? \(/);
  assert.equal((ui.match(/Upload Statement/g) ?? []).length >= 1, true);
  assert.doesNotMatch(ui, /Upload Statements/);
  assert.doesNotMatch(ui, /FNB bank statements/);
});

test("statement actions live inside the statements box", () => {
  const statementRunsStart = ui.indexOf("<StatementRuns");
  const statementRunsCall = ui.slice(statementRunsStart, statementRunsStart + 5000);
  assert.match(statementRunsCall, /selectionActions=\{selectedRunIds\.length/);
  assert.match(statementRunsCall, /Process All/);
  assert.match(statementRunsCall, />Delete</);
  assert.match(statementRunsCall, /disabled=\{!selectedRunIds\.length \|\| busy === "delete"\}/);
});

test("statement selection checkboxes remain permanently visible", () => {
  assert.doesNotMatch(ui, /selectionMode/);
  assert.match(ui, /aria-label="Select visible statements"/);
  assert.match(ui, /aria-label=\{`Select \$\{runDisplayTitle\(run\)\} for combined workbook`\}/);
});
