import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { isClassified, summarizeAccountingCoverage, summarizeStatementIntegrity } = await import(
  "@/lib/accounting/integrity.ts"
);
type AccountingTransaction = import("@/lib/accounting/types.ts").AccountingTransaction;

let counter = 0;
function txn(overrides: Partial<AccountingTransaction> = {}): AccountingTransaction {
  counter += 1;
  return {
    id: `t-${counter}`,
    runId: "run-1",
    workspaceId: "ws-1",
    transactionDate: "2025-04-01",
    description: "PAYMENT",
    debitAmount: 100,
    creditAmount: null,
    runningBalance: null,
    bankCharge: false,
    accountCategory: "Repairs & Maintenance",
    vatTreatment: "standard",
    supportedByInvoice: false,
    notes: "",
    confidence: 70,
    reviewStatus: "ready",
    classificationSource: "deterministic",
    classificationStrength: null,
    classificationConfidence: 95,
    classificationReason: null,
    normalizedMerchant: null,
    sourcePage: 1,
    sourceRow: counter,
    rawText: null,
    createdAt: "2025-04-01T00:00:00Z",
    updatedAt: "2025-04-01T00:00:00Z",
    ...overrides,
  } as AccountingTransaction;
}

/** The real statement's shape: fully extracted, reconciled, mostly unclassified. */
function realStatement(classifiedRows: number, totalRows = 615): AccountingTransaction[] {
  return Array.from({ length: totalRows }, (_, index) =>
    index < classifiedRows
      ? txn()
      : txn({ classificationSource: "unresolved", accountCategory: "Suspense / Review Required", classificationConfidence: null }),
  );
}

test("a reconciled statement stays fully intact however little is classified", () => {
  // The defect this exists to prevent: 615 of 615 rows read, every balance
  // continuous, difference R0.00 — reported as 67% extracted, because 426 rows
  // awaited an accounting decision.
  const integrity = summarizeStatementIntegrity({
    transactions: realStatement(189),
    reconciliationDifference: 0,
    extractionConfidence: 100,
  });

  assert.equal(integrity.transactionCount, 615);
  assert.equal(integrity.withSourceRow, 615);
  assert.equal(integrity.sourceRowComplete, true);
  assert.equal(integrity.reconciled, true);
  assert.equal(integrity.extractionConfidence, 100, "unresolved rows must not touch this");
});

test("classifying fewer rows moves coverage and leaves integrity untouched", () => {
  const inputs = { reconciliationDifference: 0, extractionConfidence: 100 };

  const many = summarizeStatementIntegrity({ transactions: realStatement(400), ...inputs });
  const few = summarizeStatementIntegrity({ transactions: realStatement(50), ...inputs });
  assert.deepEqual(many, few, "integrity is identical regardless of classification");

  assert.ok(
    summarizeAccountingCoverage(realStatement(400)).coveragePercent! >
      summarizeAccountingCoverage(realStatement(50)).coveragePercent!,
    "coverage moves with classification",
  );
});

test("unresolved rows are excluded from classified confidence", () => {
  // An average that includes "I don't know" is not a confidence.
  const rows = [
    txn({ classificationConfidence: 90 }),
    txn({ classificationConfidence: 80 }),
    txn({ classificationSource: "unresolved", accountCategory: "Uncategorised", classificationConfidence: 10 }),
    txn({ classificationSource: "unresolved", accountCategory: "Uncategorised", classificationConfidence: null }),
  ];
  const coverage = summarizeAccountingCoverage(rows);

  assert.equal(coverage.classifiedConfidence, 85, "mean of 90 and 80 only");
  assert.equal(coverage.classified, 2);
  assert.equal(coverage.unresolved, 2);
  assert.equal(coverage.coveragePercent, 50);
});

test("nothing classified reports null, not zero", () => {
  const coverage = summarizeAccountingCoverage(realStatement(0, 10));
  assert.equal(coverage.classifiedConfidence, null, "absent is honest; 0 reads as classified badly");
  assert.equal(coverage.coveragePercent, 0);
});

test("a broken reconciliation is reported as broken", () => {
  const broken = summarizeStatementIntegrity({
    transactions: realStatement(600),
    reconciliationDifference: -1250.44,
    extractionConfidence: 72,
  });
  assert.equal(broken.reconciled, false);
  assert.equal(broken.reconciliationDifference, -1250.44);

  // A cent of float noise is not a failure to reconcile.
  const rounding = summarizeStatementIntegrity({
    transactions: realStatement(600),
    reconciliationDifference: 0.004,
    extractionConfidence: 100,
  });
  assert.equal(rounding.reconciled, true);
});

test("missing source rows show up in integrity, not in coverage", () => {
  const rows = [...realStatement(5, 10)];
  rows[0] = txn({ sourceRow: null });
  rows[1] = txn({ sourceRow: null });

  const integrity = summarizeStatementIntegrity({
    transactions: rows,
    reconciliationDifference: 0,
    extractionConfidence: 88,
  });
  assert.equal(integrity.withSourceRow, 8);
  assert.equal(integrity.sourceRowComplete, false, "an incomplete read is an extraction finding");
});

test("provenance alone does not make a row classified", () => {
  // A row can carry a real source while its category is still a review bucket:
  // classified by mechanism, undecided in substance. PR #59 established the
  // same principle for AI declines.
  assert.equal(isClassified(txn({ classificationSource: "ai", accountCategory: "Groceries" })), true);
  assert.equal(
    isClassified(txn({ classificationSource: "ai", accountCategory: "Suspense / Review Required" })),
    false,
    "a review bucket is not an accounting decision",
  );
  assert.equal(isClassified(txn({ classificationSource: "unresolved" })), false);
  assert.equal(isClassified(txn({ classificationSource: null })), false);
});

test("evidence grades are counted separately, not blended", () => {
  const rows = [
    txn({ classificationSource: "deterministic" }),
    txn({ classificationSource: "deterministic" }),
    txn({ classificationSource: "learned_rule" }),
    txn({ classificationSource: "ai" }),
    txn({ classificationSource: "manual" }),
    txn({ classificationSource: "unresolved", accountCategory: "Uncategorised" }),
  ];
  const coverage = summarizeAccountingCoverage(rows);
  assert.deepEqual(coverage.evidence, { deterministic: 2, learned_rule: 1, ai: 1, manual: 1 });
  assert.equal(coverage.classified, 5);
});

test("unresolved value states the size of the open question", () => {
  const rows = [
    txn({ debitAmount: 2_000_000, classificationSource: "unresolved", accountCategory: "Uncategorised" }),
    txn({ creditAmount: 500, debitAmount: null, classificationSource: "unresolved", accountCategory: "Uncategorised" }),
    txn({ debitAmount: 999 }),
  ];
  const coverage = summarizeAccountingCoverage(rows);
  // The R2m anonymous transfer is exactly the row that must stay visible.
  assert.equal(coverage.unresolvedValue, 2_000_500);
  assert.equal(coverage.unresolved, 2);
});

test("an empty run reports nulls rather than fabricated scores", () => {
  const coverage = summarizeAccountingCoverage([]);
  assert.equal(coverage.coveragePercent, null);
  assert.equal(coverage.classifiedConfidence, null);
  assert.equal(coverage.transactionCount, 0);
});

test("the worker no longer writes the classification mean into extraction_accuracy", () => {
  const worker = readFileSync("workers/accounting_worker/main.py", "utf8");
  assert.ok(
    /"extraction_accuracy": extraction_confidence,/.test(worker),
    "extraction_accuracy must carry the extraction score",
  );
  assert.ok(
    !/"extraction_accuracy": round\(avg_confidence, 2\)/.test(worker),
    "and must not carry the classification mean",
  );
  // The deprecated column keeps its historical value, so existing readers see
  // exactly what they saw before.
  assert.ok(/"confidence": round\(avg_confidence, 2\)/.test(worker), "the deprecated field is unchanged");
  assert.ok(
    /"classification_confidence": classification_confidence_value,/.test(worker),
    "classification confidence comes from classified rows only",
  );
});
