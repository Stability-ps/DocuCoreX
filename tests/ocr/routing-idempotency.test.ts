import test from "node:test";
import assert from "node:assert/strict";
import { decideOcrNeed, READABLE_MIN_CHARS } from "../../lib/pdf/ocrDecision.ts";
import { resolveJobAction } from "../../lib/ocr/jobAction.ts";

const base = {
  kind: "weak-text",
  pdfjsChars: 169,
  pdfplumberChars: 169,
  nativeTransactions: 0,
  coverage: 1,
  pageCount: 1,
  confidence: 94,
  skipOcrFastPath: false,
};

// ── Evidence-based OCR routing ───────────────────────────────────────────────

test("the 169-char clean digital PDF no longer triggers OCR (the fix)", () => {
  const d = decideOcrNeed({ ...base });
  assert.equal(d.needsOcr, false);
  assert.match(d.reason, /readable digital text layer/);
});

test("transaction count alone never forces OCR when text is readable", () => {
  assert.equal(decideOcrNeed({ ...base, nativeTransactions: 0 }).needsOcr, false);
});

test("pdfplumber recovers readable text when PDF.js fails → skip OCR (Preview root-cause fix)", () => {
  // PDF.js returned nothing (runtime hiccup) but pdfplumber read the text layer.
  const d = decideOcrNeed({ ...base, pdfjsChars: 0, pdfplumberChars: 169, coverage: 0, kind: "scanned" });
  assert.equal(d.needsOcr, false);
  assert.match(d.reason, /recovered by pdfplumber/);
});

test("genuinely scanned PDF (both extractors empty) triggers OCR", () => {
  assert.equal(decideOcrNeed({ ...base, kind: "scanned", pdfjsChars: 0, pdfplumberChars: 0, coverage: 0 }).needsOcr, true);
  assert.equal(decideOcrNeed({ ...base, pdfjsChars: 3, pdfplumberChars: 3, coverage: 0 }).needsOcr, true);
});

test("strong digital text layer (>500 chars) skips OCR", () => {
  assert.equal(decideOcrNeed({ ...base, skipOcrFastPath: true }).needsOcr, false);
});

test("PDF.js text with low page coverage still triggers OCR (multi-page guard)", () => {
  assert.equal(decideOcrNeed({ ...base, pdfjsChars: 120, pdfplumberChars: 0, coverage: 0.3 }).needsOcr, true);
});

test("very sparse text (both extractors) triggers OCR", () => {
  assert.equal(decideOcrNeed({ ...base, pdfjsChars: 10, pdfplumberChars: 10 }).needsOcr, true);
});

test("readable-text boundary at READABLE_MIN_CHARS", () => {
  assert.equal(decideOcrNeed({ ...base, pdfjsChars: READABLE_MIN_CHARS, pdfplumberChars: 0, coverage: 0.6 }).needsOcr, false);
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
