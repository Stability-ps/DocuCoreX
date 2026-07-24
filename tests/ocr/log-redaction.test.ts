import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// Static guards: the OCR/PDF pipeline must never log extracted/OCR document text.
// Only content-free diagnostics (ids, counts, durations, status, safe codes) allowed.

test("extractWithOcr does NOT log the OCR'd document text", () => {
  const src = read("lib/pdf/extractWithOcr.ts");
  // The removed leak: `sample: combinedText...` in the ocr_finished log.
  assert.doesNotMatch(src, /sample:\s*combinedText/);
  assert.doesNotMatch(src, /pdfLog\([^)]*combinedText\.trim\(\)\.slice/s);
  // Safe count is retained.
  assert.match(src, /textLength:\s*combinedText\.trim\(\)\.length/);
});

test("runExtractionPipeline debug carries no document text (sampleText blanked)", () => {
  const src = read("lib/pdf/runExtractionPipeline.ts");
  assert.doesNotMatch(src, /sampleText:\s*assembled\.merged\.combinedText/);
  assert.doesNotMatch(src, /combinedText\.slice\(0, 1000\)/);
  assert.match(src, /sampleText:\s*""/);
});

test("native extractor logs emit only char counts, never text", () => {
  for (const f of ["lib/pdf/extractWithPdfjs.ts", "lib/pdf/extractWithPdfplumber.ts"]) {
    const src = read(f);
    // pdfLog lines must not embed the combinedText itself.
    assert.doesNotMatch(src, /pdfLog\([^)]*sample[^)]*combinedText/s);
    assert.match(src, /chars:\s*combinedText\.length/);
  }
});

test("the OCR routing decision log is content-free (counts + reason only)", () => {
  const src = read("lib/pdf/runExtractionPipeline.ts");
  assert.match(src, /route\.ocr_decision/);
  // Logs char COUNTS and the decision reason, not text.
  assert.match(src, /pdfjsChars, pdfplumberChars, nativeChars/);
});
