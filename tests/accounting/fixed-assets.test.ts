import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { disposalEntry, monthlyDepreciationCharge, type FixedAsset } from "../../lib/accounting/fixed-assets.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migration = readFileSync(join(root, "supabase/migrations/042_accounting_fixed_assets.sql"), "utf8");
const sql = migration.replace(/--[^\n]*/g, "");

const asset = (over: Partial<FixedAsset> = {}) => ({
  cost: 120000,
  residualValue: 0,
  depreciationMethod: "straight_line" as const,
  usefulLifeMonths: 60,
  depreciationRatePercent: null as number | null,
  acquisitionDate: "2026-01-01",
  disposalDate: null as string | null,
  ...over,
});

// ── Straight line ────────────────────────────────────────────────────────────

test("straight line charges cost-less-residual over the useful life, evenly", () => {
  const a = asset({ cost: 120000, residualValue: 0, usefulLifeMonths: 60 });
  assert.equal(monthlyDepreciationCharge(a, 0, "2026-01-31"), 2000);
  assert.equal(monthlyDepreciationCharge(a, 2000, "2026-02-28"), 2000);
});

test("straight line stops exactly at residual value, never below it", () => {
  const a = asset({ cost: 120000, residualValue: 0, usefulLifeMonths: 60 });
  // 59 months already charged: 118000 accumulated, 2000 remaining.
  assert.equal(monthlyDepreciationCharge(a, 118000, "2027-12-31"), 2000);
  // Fully depreciated: nothing left to charge, even if called again.
  assert.equal(monthlyDepreciationCharge(a, 120000, "2028-01-31"), 0);
});

test("residual value shrinks the depreciable base, not just the final charge", () => {
  const a = asset({ cost: 120000, residualValue: 20000, usefulLifeMonths: 50 });
  assert.equal(monthlyDepreciationCharge(a, 0, "2026-01-31"), 2000); // (120000-20000)/50
});

// ── Reducing balance ──────────────────────────────────────────────────────────

test("reducing balance charges a percentage of opening net book value", () => {
  const a = asset({ depreciationMethod: "reducing_balance", usefulLifeMonths: null, depreciationRatePercent: 20, cost: 100000, residualValue: 0 });
  // 20%/12 of 100000
  assert.equal(monthlyDepreciationCharge(a, 0, "2026-01-31"), Math.round(((100000 * 0.2) / 12) * 100) / 100);
});

test("reducing balance never charges below residual value even after many months", () => {
  const a = asset({ depreciationMethod: "reducing_balance", usefulLifeMonths: null, depreciationRatePercent: 50, cost: 10000, residualValue: 1000 });
  // Almost everything already charged — only 1 remaining before residual.
  assert.equal(monthlyDepreciationCharge(a, 8999, "2030-01-31"), 1);
});

// ── Method and lifecycle gates ────────────────────────────────────────────────

test("method 'none' never charges anything", () => {
  const a = asset({ depreciationMethod: "none", usefulLifeMonths: null, depreciationRatePercent: null });
  assert.equal(monthlyDepreciationCharge(a, 0, "2026-06-30"), 0);
});

test("an asset acquired after the month-end is not charged yet", () => {
  const a = asset({ acquisitionDate: "2026-07-15" });
  assert.equal(monthlyDepreciationCharge(a, 0, "2026-06-30"), 0);
});

test("an asset already disposed before the month-end is not charged", () => {
  const a = asset({ disposalDate: "2026-05-10" });
  assert.equal(monthlyDepreciationCharge(a, 0, "2026-06-30"), 0);
});

// ── Disposal ──────────────────────────────────────────────────────────────────

test("disposal at exactly net book value produces neither a gain nor a loss", () => {
  const entry = disposalEntry({ cost: 50000, accumulatedDepreciation: 30000, proceeds: 20000 });
  assert.equal(entry.gain, 0);
  assert.equal(entry.loss, 0);
});

test("proceeds above net book value are a gain", () => {
  const entry = disposalEntry({ cost: 50000, accumulatedDepreciation: 30000, proceeds: 25000 });
  assert.equal(entry.gain, 5000);
  assert.equal(entry.loss, 0);
});

test("proceeds below net book value are a loss", () => {
  const entry = disposalEntry({ cost: 50000, accumulatedDepreciation: 30000, proceeds: 15000 });
  assert.equal(entry.loss, 5000);
  assert.equal(entry.gain, 0);
});

test("the disposal entry always balances: debits equal credits", () => {
  for (const proceeds of [0, 10000, 20000, 30000]) {
    const entry = disposalEntry({ cost: 50000, accumulatedDepreciation: 30000, proceeds });
    const debits = entry.accumulatedDepreciationDebit + entry.proceedsDebit + entry.loss;
    const credits = entry.costCredit + entry.gain;
    assert.equal(Math.round(debits * 100), Math.round(credits * 100));
  }
});

test("a scrapped asset (zero proceeds) is a full loss of its remaining net book value", () => {
  const entry = disposalEntry({ cost: 50000, accumulatedDepreciation: 30000, proceeds: 0 });
  assert.equal(entry.loss, 20000);
  assert.equal(entry.proceedsDebit, 0);
});

// ── The migration itself ─────────────────────────────────────────────────────

test("an asset and its own accumulated-depreciation account must differ", () => {
  assert.match(sql, /accounting_fixed_assets_distinct_accounts check \(asset_account_id <> accumulated_depreciation_account_id\)/);
});

test("a depreciation movement is unique per asset per calendar month", () => {
  assert.match(sql, /accounting_asset_movements_one_depreciation_per_month/);
  assert.match(sql, /where movement_type = 'depreciation'/);
});

test("net book value and accumulated depreciation are derived from postings, not stored columns", () => {
  const registerFn = sql.slice(sql.indexOf("function public.accounting_fixed_asset_register"));
  assert.match(registerFn, /join public\.accounting_postings p/);
  assert.doesNotMatch(sql, /accumulated_depreciation numeric.*not null.*default/i);
});

test("disposal is accepted as a journal type alongside depreciation", () => {
  const check = sql.slice(sql.indexOf("accounting_journals_journal_type_check\n  check"));
  assert.match(check, /'depreciation', 'disposal'/);
});
