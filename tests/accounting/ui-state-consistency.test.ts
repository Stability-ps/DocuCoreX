import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ui = readFileSync(join(root, "components/accounting/accounting-intelligence.tsx"), "utf8");
const processingSteps = readFileSync(join(root, "components/accounting/processing-steps.tsx"), "utf8");
const failedPanel = readFileSync(join(root, "components/accounting/failed-run-panel.tsx"), "utf8");

test("queued presentation cannot be overridden by optimistic local processing state", () => {
  assert.doesNotMatch(ui, /function applyRunRefreshState/);
  assert.doesNotMatch(ui, /setLiveRefreshState\("processing"\)/);
  assert.match(ui, /Ready to process/);
  assert.match(ui, /Processing has not started yet\./);
  assert.match(ui, /Process Statement/);
  assert.match(ui, /Process this statement to extract transactions\./);
});

test("processing uses a truthful stage-based progress bar without numeric percentages", () => {
  assert.match(processingSteps, /role="progressbar"/);
  assert.match(processingSteps, /aria-valuetext/);
  assert.match(processingSteps, /Finalising your statement/);
  assert.match(processingSteps, /animate-pulse/);
  assert.doesNotMatch(processingSteps, /\d+%/);
  assert.doesNotMatch(ui, /Refreshing latest results/);
});

test("non-statement mismatch panel prioritises upload\/view actions instead of retry loops", () => {
  assert.match(failedPanel, /mismatch\.isMismatch \?/);
  assert.match(failedPanel, /Upload another statement/);
  assert.match(failedPanel, /View document/);
  assert.match(failedPanel, /Technical details/);
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

test("every statement row keeps its upload date and time visible", () => {
  assert.match(ui, /`Uploaded \$\{compactDateTime\(run\.createdAt\)\}`/);
  assert.match(ui, /cleanStatementLabel\(run\.accountNumber\) \|\| cleanStatementLabel\(run\.companyName\)/);
});

test("the selected statement keeps real metadata, metrics, and the PDF beside transactions", () => {
  assert.match(ui, /statementPeriodLabel\(detail\.run\)/);
  assert.match(ui, /cleanStatementLabel\(detail\.run\.bank\)/);
  assert.match(ui, /grid-cols-5/);
  assert.match(ui, /lg:grid-cols-\[minmax\(0,36fr\)_minmax\(0,64fr\)\]/);
  assert.match(ui, /<DocumentViewer/);
  assert.match(ui, /sourceUrl=\{`\/api\/accounting\/fnb\/runs\/\$\{detail\.run\.id\}\/source`\}/);
  assert.match(ui, /onShowInStatement=\{showTransactionInStatement\}/);
  assert.match(ui, /onShowInStatement\?\.\(transaction\.sourcePage\)/);
  assert.doesNotMatch(ui, /boundingBox|fakeHighlight/);
});

test("the bank statement page follows the approved compact workspace hierarchy", () => {
  // The two assertions that stood here required the upload panel to default to
  // COLLAPSED and the "Show upload options" control to exist. Both were removed
  // deliberately: collapsed rendered the whole panel `sr-only`, so the drop
  // target, the description and the guidance were invisible to sighted users
  // unless they found a control that only appeared on wide screens.
  //
  // The rest of the hierarchy this test protects is unchanged, and the upload
  // panel's absence of a toggle is now asserted positively in format.test.ts.
  assert.match(ui, /activeModule === "bank-statements"/);
  assert.match(ui, /grid-cols-5 divide-x divide-slate-100/);
  assert.match(ui, /overflow-hidden rounded-lg border border-slate-200 bg-white/);
  assert.doesNotMatch(ui, /bg-gradient-to-r from-navy-950/);
  assert.match(ui, /visibleMessage[\s\S]*grid items-start gap-3 xl:grid-cols-\[320px_minmax\(0,1fr\)\]/);
});
