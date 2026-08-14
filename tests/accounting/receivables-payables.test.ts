import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ageingAnchorDate, daysOverdue, isOverdue, type OpenItem } from "../../lib/accounting/receivables-payables.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migration = readFileSync(join(root, "supabase/migrations/043_accounting_receivables_and_payables.sql"), "utf8");
const sql = migration.replace(/--[^\n]*/g, "");

const item = (over: Partial<Pick<OpenItem, "postingDate" | "dueDate">> = {}) => ({
  postingDate: "2026-10-01",
  dueDate: null as string | null,
  ...over,
});

// ── Ageing anchor ─────────────────────────────────────────────────────────────

test("the due date governs ageing when stated", () => {
  assert.equal(ageingAnchorDate(item({ dueDate: "2026-10-15" })), "2026-10-15");
});

test("the posting date is the fallback when there is no due date", () => {
  assert.equal(ageingAnchorDate(item({ dueDate: null })), "2026-10-01");
});

test("days overdue is measured from the anchor date, and is negative before it's due", () => {
  assert.equal(daysOverdue(item({ dueDate: "2026-10-01" }), "2026-10-31"), 30);
  assert.equal(daysOverdue(item({ dueDate: "2026-11-15" }), "2026-10-31"), -15);
  assert.equal(daysOverdue(item({ dueDate: "2026-10-31" }), "2026-10-31"), 0);
});

test("isOverdue is false on the due date itself, true the day after", () => {
  assert.equal(isOverdue(item({ dueDate: "2026-10-31" }), "2026-10-31"), false);
  assert.equal(isOverdue(item({ dueDate: "2026-10-30" }), "2026-10-31"), true);
});

// ── The migration itself: the guarantees the UI depends on ──────────────────

test("a line to the AR control account is refused without a customer", () => {
  const fn = sql.slice(sql.indexOf("function public.accounting_post_journal"));
  assert.match(fn, /must name a customer/);
  assert.match(fn, /must name a supplier/);
});

test("AR is debit/credit and AP is credit/debit — opposite pairs, not copies", () => {
  const ar = sql.slice(sql.indexOf("function public.accounting_allocate_ar"), sql.indexOf("function public.accounting_allocate_ap"));
  const ap = sql.slice(sql.indexOf("function public.accounting_allocate_ap"));
  assert.match(ar, /the invoice posting must be a debit/);
  assert.match(ar, /the receipt posting must be a credit/);
  assert.match(ap, /the bill posting must be a credit/);
  assert.match(ap, /the payment posting must be a debit/);
});

test("allocation amount is capped by both sides' unallocated remainder, not just one", () => {
  const fn = sql.slice(sql.indexOf("function public.accounting_allocate_ar"), sql.indexOf("function public.accounting_allocate_ap"));
  assert.match(fn, /exceeds the invoice''s unallocated balance/);
  assert.match(fn, /exceeds the receipt''s unallocated balance/);
});

test("allocations are not append-only — no update/delete guard trigger exists for them", () => {
  assert.doesNotMatch(sql, /accounting_ar_allocations_are_append_only/);
  assert.doesNotMatch(sql, /accounting_ap_allocations_are_append_only/);
  assert.doesNotMatch(sql, /accounting_ar_allocations_no_delete/);
  assert.doesNotMatch(sql, /accounting_ap_allocations_no_delete/);
});

test("customer and supplier tags use a nullable composite FK, so an untagged line is unaffected", () => {
  assert.match(sql, /foreign key \(customer_id, company_id\) references public\.accounting_customers \(id, company_id\)/);
  assert.match(sql, /foreign key \(supplier_id, company_id\) references public\.accounting_suppliers \(id, company_id\)/);
});

test("open items and ageing are computed from postings and allocations, not a stored balance", () => {
  const openItemsFn = sql.slice(sql.indexOf("function public.accounting_ar_open_items"), sql.indexOf("function public.accounting_ar_unallocated_receipts"));
  assert.match(openItemsFn, /from public\.accounting_postings p/);
  assert.match(openItemsFn, /accounting_ar_allocations/);
});
