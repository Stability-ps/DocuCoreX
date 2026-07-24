import test from "node:test";
import assert from "node:assert/strict";
import { decideOcrNeed, READABLE_MIN_CHARS } from "../../lib/pdf/ocrDecision.ts";
import { resolveJobAction } from "../../lib/ocr/jobAction.ts";

const base = {
  kind: "weak-text",
  pdfjsChars: 169,
  nativeChars: 169,
  nativeTransactions: 0,
  coverage: 1,
  pageCount: 1,
  confidence: 94,
  scannedFastPath: false,
  skipOcrFastPath: false,
};

// ── Evidence-based OCR routing ───────────────────────────────────────────────

test("the 169-char clean digital PDF no longer triggers OCR (the fix)", () => {
  const d = decideOcrNeed({ ...base });
  assert.equal(d.needsOcr, false);
  assert.match(d.reason, /readable digital text layer/);
});

test("transaction count alone never forces OCR when text is readable", () => {
  // 0 transactions but a clean text layer → still no OCR.
  assert.equal(decideOcrNeed({ ...base, nativeTransactions: 0 }).needsOcr, false);
});

test("genuinely scanned PDF triggers OCR", () => {
  assert.equal(decideOcrNeed({ ...base, scannedFastPath: true }).needsOcr, true);
  assert.equal(decideOcrNeed({ ...base, kind: "scanned", pdfjsChars: 3, nativeChars: 3, coverage: 0 }).needsOcr, true);
});

test("strong digital text layer (>500 chars) skips OCR", () => {
  assert.equal(decideOcrNeed({ ...base, skipOcrFastPath: true }).needsOcr, false);
});

test("low page coverage triggers OCR even with some text", () => {
  assert.equal(decideOcrNeed({ ...base, coverage: 0.3, nativeChars: 120 }).needsOcr, true);
});

test("very sparse text triggers OCR", () => {
  assert.equal(decideOcrNeed({ ...base, nativeChars: 10, pdfjsChars: 10 }).needsOcr, true);
});

test("readable-text boundary at READABLE_MIN_CHARS", () => {
  assert.equal(decideOcrNeed({ ...base, nativeChars: READABLE_MIN_CHARS, coverage: 0.6 }).needsOcr, false);
});

// ── Idempotency ──────────────────────────────────────────────────────────────

test("completed result is reused (no new job)", () => {
  assert.equal(resolveJobAction({ hasCompletedResult: true, activeJobId: null, force: false }), "reuse");
});

test("an in-flight job is attached to, never duplicated", () => {
  assert.equal(resolveJobAction({ hasCompletedResult: false, activeJobId: "job-1", force: false }), "attach");
});

test("no result and no active job creates one", () => {
  assert.equal(resolveJobAction({ hasCompletedResult: false, activeJobId: null, force: false }), "create");
});

test("explicit reprocess always creates fresh work", () => {
  assert.equal(resolveJobAction({ hasCompletedResult: true, activeJobId: "job-1", force: true }), "create");
});
