import test from "node:test";
import assert from "node:assert/strict";
import { importBatchStatus, importTypeLabel } from "../../lib/accounting/import-history.ts";

test("a batch where every group was valid is complete", () => {
  assert.equal(importBatchStatus({ totalGroups: 10, validGroups: 10 }), "complete");
});

test("a batch with zero valid groups is failed, not partial", () => {
  assert.equal(importBatchStatus({ totalGroups: 5, validGroups: 0 }), "failed");
});

test("a batch with some but not all groups valid is partial", () => {
  assert.equal(importBatchStatus({ totalGroups: 200, validGroups: 193 }), "partial");
});

test("an empty batch (zero groups) counts as complete, not failed", () => {
  // 0 valid === 0 total, so the "every group valid" check is what fires —
  // there's no meaningful sense in which an empty import "failed".
  assert.equal(importBatchStatus({ totalGroups: 0, validGroups: 0 }), "complete");
});

test("importTypeLabel falls back to the raw value for anything unrecognised", () => {
  assert.equal(importTypeLabel("chart_of_accounts"), "Chart of accounts");
  assert.equal(importTypeLabel("journals"), "Journals");
  assert.equal(importTypeLabel("something_else"), "something_else");
});
