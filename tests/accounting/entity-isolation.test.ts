import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Migration 037 exists because Stage 4B executed migration 036 against a real
 * PostgreSQL 16 instance and four controls did not behave as the SQL read.
 *
 * These assertions guard the corrections. They are text assertions over the
 * migration — the behavioural proof is the executed battery recorded in
 * docs/STAGE_4B_DATABASE_VERIFICATION.md — so their job is narrow: stop a later
 * edit from quietly removing a fix whose absence took a live database to find.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migration = readFileSync(join(root, "supabase/migrations/037_accounting_entity_isolation.sql"), "utf8");
const sql = migration.replace(/--[^\n]*/g, "");

test("an accounting line may only use an account of its own entity", () => {
  // FOUND IN EXECUTION: an Entity A journal posted against an Entity B account
  // and produced a posting whose company_id and account.company_id disagreed.
  // Composite foreign keys, so the rule holds for the service role and for any
  // future caller, not only for code that remembers to check.
  assert.match(sql, /accounting_accounts_id_company_key unique \(id, company_id\)/);
  for (const table of ["accounting_journal_lines", "accounting_postings"]) {
    assert.match(
      sql,
      new RegExp(`alter table public\\.${table}[\\s\\S]{0,200}foreign key \\(account_id, company_id\\)[\\s\\S]{0,120}references public\\.accounting_accounts \\(id, company_id\\)`),
      `${table} must be constrained to its own entity's accounts`,
    );
  }
});

test("the ledger has exactly one door", () => {
  // FOUND IN EXECUTION: postings refused UPDATE and DELETE but accepted a
  // direct INSERT, so one statement could add a single leg and put the trial
  // balance out of balance without a journal, a balance check or a period check.
  assert.match(sql, /create trigger accounting_postings_gate\s+before insert on public\.accounting_postings/);
  assert.match(sql, /accounting_postings_only_via_gate/);
  assert.match(sql, /docucorex\.ledger_gate/);
  // Transaction-local, so the gate cannot leak into a later statement.
  assert.match(sql, /set_config\('docucorex\.ledger_gate', 'open', true\)/);
  assert.match(sql, /set_config\('docucorex\.ledger_gate', '', true\)/);
});

test("concurrent posting of one journal is serialised by a row lock", () => {
  // FOUND IN EXECUTION: two simultaneous calls both read status 'draft', both
  // passed every check and both inserted. A R1,000,000 journal became
  // R2,000,000 across four posting rows. FOR UPDATE makes the second caller
  // wait and then see 'posted'.
  const post = sql.slice(sql.indexOf("function public.accounting_post_journal"));
  assert.match(post, /from public\.accounting_journals\s+where id = target_journal\s+for update/);
});

test("deleting a source transaction does not become impossible", () => {
  // FOUND IN EXECUTION: source_transaction_id is ON DELETE SET NULL so the
  // ledger survives, but SET NULL is an UPDATE and the append-only trigger
  // refused every UPDATE — so any statement referenced by a posting could never
  // be deleted at all. The carve-out permits exactly that transition.
  const guard = sql.slice(sql.indexOf("function public.accounting_postings_are_append_only"));
  assert.match(guard, /old\.source_transaction_id is not null/);
  assert.match(guard, /new\.source_transaction_id is null/);
  // Narrow: every field carrying accounting meaning must be unchanged.
  for (const field of ["company_id", "journal_id", "account_id", "posting_date", "debit", "credit"]) {
    assert.match(guard, new RegExp(`new\\.${field}\\s+is not distinct from old\\.${field}`), `${field} must be compared`);
  }
  // And the general refusal still stands.
  assert.match(guard, /raise exception[\s\S]{0,160}append-only/);
});

test("the carve-out cannot become a general update path", () => {
  // If the guard ever returns NEW without comparing the accounting fields, a
  // posting becomes editable and the ledger stops being a ledger.
  const guard = sql.slice(
    sql.indexOf("function public.accounting_postings_are_append_only"),
    sql.indexOf("function public.accounting_journal_lines_frozen_once_posted"),
  );
  const returns = guard.match(/return new;/g) ?? [];
  assert.equal(returns.length, 1, "there must be exactly one permitted UPDATE path");
});

test("the corrective migration is non-destructive", () => {
  assert.doesNotMatch(sql, /drop table/i);
  assert.doesNotMatch(sql, /truncate/i);
  assert.doesNotMatch(sql, /delete from/i);
  for (const drop of sql.match(/drop (constraint|trigger|policy)[^;]*/gi) ?? []) {
    assert.match(drop, /if exists/i, `"${drop.trim()}" must be guarded with IF EXISTS`);
  }
});
