import test from "node:test";
import assert from "node:assert/strict";
import type { AccountingStatementRun } from "../../lib/accounting/types.ts";
import { mergeAccountingRunProgress, normalizeAccountingProcessingStage } from "../../lib/accounting/processing-stage.ts";

function run(overrides: Partial<AccountingStatementRun>): AccountingStatementRun {
  return {
    id: "run-1", workspaceId: "workspace-1", documentId: null, processingJobId: null, activeJobId: "job-a",
    bank: "Bank", statementType: "bank_statement", status: "processing", companyName: null, accountNumber: null,
    statementPeriodStart: null, statementPeriodEnd: null, openingBalance: null, closingBalance: null, transactionCount: 0,
    bankChargesTotal: 0, sourceStoragePath: "source.pdf", workbookStoragePath: null, extractionProvider: "hybrid",
    confidences: { extraction: null, classification: null, reconciliation: null }, confidence: 0, error: null,
    createdAt: "2026-08-10T12:30:00Z", updatedAt: "2026-08-10T12:30:00Z", ...overrides,
  };
}

test("a late polling response cannot move the same job backwards", () => {
  const newer = run({ processingStep: "Classifying transactions", updatedAt: "2026-08-10T12:30:15Z" });
  const older = run({ processingStep: "Parsing transactions", updatedAt: "2026-08-10T12:30:10Z" });
  assert.equal(mergeAccountingRunProgress(newer, older).processingStep, "Classifying transactions");
});

test("a new active job can restart, while a late prior-job update is ignored", () => {
  const oldJob = run({ activeJobId: "job-a", processingStep: "Reconciling", updatedAt: "2026-08-10T12:30:15Z" });
  const newJob = run({ activeJobId: "job-b", processingStep: "Detecting document", updatedAt: "2026-08-10T12:31:00Z" });
  const acceptedNewJob = mergeAccountingRunProgress(oldJob, newJob);
  assert.equal(acceptedNewJob.processingStep, "Detecting document");
  const lateOldJob = run({ activeJobId: "job-a", processingStep: "Generating workbook", updatedAt: "2026-08-10T12:30:30Z" });
  assert.equal(mergeAccountingRunProgress(acceptedNewJob, lateOldJob).activeJobId, "job-b");
  assert.equal(mergeAccountingRunProgress(acceptedNewJob, lateOldJob).processingStep, "Detecting document");
});

test("OCR is normalized as extraction, not a primary lifecycle stage", () => {
  assert.equal(normalizeAccountingProcessingStage("Running OCR"), "extracting");
  assert.equal(normalizeAccountingProcessingStage("Using native text layer"), "extracting");
});
