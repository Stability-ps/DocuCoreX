// Rows built from extracted document text (lib/document-conversion-engine.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("../pdf/alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { textRows } = await import("@/lib/document-conversion-engine.ts");

test("amounts with thousands separators stay in one cell", () => {
  // Production, 2026-10-08: "Subtotal 1,090.00" became cells "1" and "090.00".
  assert.deepEqual(textRows("Subtotal                 1,090.00\nTotal Due (ZAR)          1,253.50"), [
    ["Subtotal                 1,090.00"],
    ["Total Due (ZAR)          1,253.50"],
  ]);
});

test("prose keeps its commas", () => {
  assert.deepEqual(textRows("12 Main Road, Cape Town, 8001"), [["12 Main Road, Cape Town, 8001"]]);
});

test("tab-separated table cells still become columns", () => {
  assert.deepEqual(textRows("Description\tQty\tAmount\nToner\t1\t1,250.00"), [
    ["Description", "Qty", "Amount"],
    ["Toner", "1", "1,250.00"],
  ]);
});
