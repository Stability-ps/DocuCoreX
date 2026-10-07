import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { sectionsToXlsx, sectionToCsv } = await import("@/lib/accounting/export.ts");
type ExportSection = Parameters<typeof sectionToCsv>[0];

// The accounting pack summed money in floating point and wrote the raw result.
// A production export (release audit, 2026-10-07) stored the trial-balance debit
// total as 118250.44999999998 against credits of 118250.45, the variance as
// -1.4551915228366852e-11, the expected closing balance as 97430.79999999999 and
// output VAT as 15423.971739130435. The 2-decimal number format hid it on screen,
// but Excel compares and pastes the stored value. Money must be written as cents.

const money = (v: number) => ({ v, num: true, fmt: "money" as const });

const section: ExportSection = {
  id: "trial-balance",
  label: "Trial Balance",
  sheet: "Trial Balance",
  rows: [
    [{ v: "Totals" }, money(118250.44999999998), money(118250.45), money(-1.4551915228366852e-11)],
    [{ v: "Expected closing" }, money(97430.79999999999)],
    [{ v: "Output VAT" }, money(15423.971739130435)],
    [{ v: "Half cent rounds up" }, money(1.005), money(-1.005)],
    [{ v: "Count" }, { v: 18, num: true, fmt: "int" }, { v: 0.4567, num: true, fmt: "percent" }],
  ],
};

const sheetXml = new TextDecoder().decode(sectionsToXlsx([section]));
const values = [...sheetXml.matchAll(/<v>([^<]*)<\/v>/g)].map((match) => match[1]);

test("money cells store the cents they display, not floating-point residue", () => {
  assert.deepEqual(values.slice(0, 3), ["118250.45", "118250.45", "0"], "trial-balance totals must be equal and the variance exactly zero");
  assert.equal(values[3], "97430.8");
  assert.equal(values[4], "15423.97", "VAT is stored to the cent");
});

test("rounding is half-up on cents, symmetric for negatives", () => {
  assert.deepEqual(values.slice(5, 7), ["1.01", "-1.01"]);
});

test("integer and percent cells are not rounded as money", () => {
  assert.deepEqual(values.slice(7, 9), ["18", "0.4567"]);
});

test("the CSV export writes money to exactly two decimals", () => {
  const csv = sectionToCsv(section).split("\n");
  assert.equal(csv[0], "Totals,118250.45,118250.45,0.00");
  assert.equal(csv[1], "Expected closing,97430.80");
  assert.equal(csv[2], "Output VAT,15423.97");
  assert.equal(csv[4], "Count,18,0.4567");
});
