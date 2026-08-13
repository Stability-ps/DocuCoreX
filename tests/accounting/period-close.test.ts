import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lockBlockedReason, readinessNotes, type PeriodReadiness } from "../../lib/accounting/period-close.ts";
import { auditActionLabel, auditEntityLabel, isReversalAction } from "../../lib/accounting/audit-trail.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migration = readFileSync(join(root, "supabase/migrations/041_accounting_period_close_and_audit.sql"), "utf8");
const sql = migration.replace(/--[^\n]*/g, "");

const readiness = (over: Partial<PeriodReadiness> = {}): PeriodReadiness => ({
  unpostedJournalCount: 0,
  openReconciliationCount: 0,
  vatPeriodStatus: null,
  ...over,
});

// ── Lock readiness ───────────────────────────────────────────────────────────

test("a lock is blocked by unposted journals in range", () => {
  assert.equal(lockBlockedReason(readiness({ unpostedJournalCount: 3 })), "3 unposted journals dated in this period — post or remove them first.");
  assert.match(lockBlockedReason(readiness({ unpostedJournalCount: 1 }))!, /^1 unposted journal /);
});

test("a lock with nothing outstanding is not blocked", () => {
  assert.equal(lockBlockedReason(readiness()), null);
});

test("open reconciliations and a filed VAT period are informational, never blocking", () => {
  assert.equal(lockBlockedReason(readiness({ openReconciliationCount: 5, vatPeriodStatus: "locked" })), null);
  const notes = readinessNotes(readiness({ openReconciliationCount: 2, vatPeriodStatus: "submitted" }));
  assert.equal(notes.length, 2);
  assert.match(notes[0], /2 bank reconciliations/);
  assert.match(notes[1], /submitted/);
});

test("readinessNotes is empty when there is nothing to mention", () => {
  assert.deepEqual(readinessNotes(readiness()), []);
});

// ── Audit trail labels ───────────────────────────────────────────────────────

test("known actions and entity types get a human label; unknown ones fall back to the raw value", () => {
  assert.equal(auditActionLabel("period_locked"), "Period locked");
  assert.equal(auditActionLabel("something_new"), "something_new");
  assert.equal(auditEntityLabel("accounting_vat_period"), "VAT period");
  assert.equal(auditEntityLabel("unknown_entity"), "unknown_entity");
});

test("only the undo-shaped actions are flagged as reversals", () => {
  assert.equal(isReversalAction("journal_reversed"), true);
  assert.equal(isReversalAction("period_reopened"), true);
  assert.equal(isReversalAction("journal_posted"), false);
  assert.equal(isReversalAction("period_locked"), false);
});

// ── The migration itself: the guarantees the UI and tests above depend on ───

test("accounting_audit_events is append-only for update and delete", () => {
  const guard = sql.slice(sql.indexOf("function public.accounting_audit_events_are_append_only"));
  assert.match(guard, /raise exception/);
  assert.match(sql, /before update on public\.accounting_audit_events/);
  assert.match(sql, /before delete on public\.accounting_audit_events/);
});

test("only a select policy exists for accounting_audit_events — no direct insert path for users", () => {
  const policySection = sql.slice(sql.indexOf("alter table public.accounting_audit_events enable row level security"));
  const policies = policySection.match(/create policy[^;]*/gi) ?? [];
  assert.equal(policies.length, 1);
  assert.match(policies[0], /for select/i);
});

test("reopening a period requires a non-empty reason", () => {
  const fn = sql.slice(sql.indexOf("function public.accounting_reopen_period"));
  assert.match(fn, /reason is null or length\(trim\(reason\)\) = 0/);
});

test("locking checks for unposted journals before soft-closing does not", () => {
  const fn = sql.slice(
    sql.indexOf("function public.accounting_close_period"),
    sql.indexOf("function public.accounting_reopen_period"),
  );
  const lockedBranch = fn.indexOf("if target_status = 'locked' then");
  assert.ok(lockedBranch > -1);
  // The count is only ever COMPUTED inside the locked branch — a soft close
  // never queries accounting_journals at all.
  assert.doesNotMatch(fn.slice(0, lockedBranch), /select count\(\*\) into draft_count/);
  assert.match(fn.slice(lockedBranch), /select count\(\*\) into draft_count/);
});
