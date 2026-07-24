import test from "node:test";
import assert from "node:assert/strict";
import { validateExtraction, vatInclusive, sumField } from "../../lib/ocr/validate.ts";
import { pngDimensions, toPngDataUrl } from "../../lib/pdf/rasterizePdf.ts";

// ── Deterministic validation ─────────────────────────────────────────────────

test("validation: reconciling statement is Ready", () => {
  const r = validateExtraction({
    openingBalance: 1000,
    closingBalance: 1250,
    lineItems: [
      { credit: 500, debit: null },
      { debit: 250, credit: null },
    ],
  });
  assert.equal(r.status, "Ready");
  assert.equal(r.computedClosing, 1250);
  assert.equal(r.reconciliationDifference, 0);
  assert.equal(r.totalCredits, 500);
  assert.equal(r.totalDebits, 250);
});

test("validation: non-reconciling statement is Review Required", () => {
  const r = validateExtraction({
    openingBalance: 1000,
    closingBalance: 999,
    lineItems: [{ credit: 500, debit: null }, { debit: 250, credit: null }],
  });
  assert.equal(r.status, "Review Required");
  assert.equal(r.computedClosing, 1250);
  assert.ok(Math.abs(r.reconciliationDifference ?? 0) > 0);
});

test("validation: no transactions is Failed", () => {
  const r = validateExtraction({ openingBalance: 1000, closingBalance: 1000, lineItems: [] });
  assert.equal(r.status, "Failed");
});

test("validation: missing balance is Review Required (cannot reconcile)", () => {
  const r = validateExtraction({ openingBalance: 1000, closingBalance: null, lineItems: [{ debit: 10 }] });
  assert.equal(r.status, "Review Required");
});

test("VAT 15/115 on an inclusive amount", () => {
  assert.equal(vatInclusive(115, 15), 15);
  assert.equal(sumField([{ debit: 10 }, { debit: 5 }], "debit"), 15);
});

// ── Rasterizer pure helpers ──────────────────────────────────────────────────

test("pngDimensions reads IHDR width/height", () => {
  const png = new Uint8Array(24);
  const view = new DataView(png.buffer);
  view.setUint32(16, 1240); // width
  view.setUint32(20, 1754); // height
  assert.deepEqual(pngDimensions(png), { width: 1240, height: 1754 });
  assert.deepEqual(pngDimensions(new Uint8Array(4)), { width: 0, height: 0 });
});

test("toPngDataUrl builds a base64 data URL", () => {
  const url = toPngDataUrl(new Uint8Array([1, 2, 3]));
  assert.ok(url.startsWith("data:image/png;base64,"));
});
