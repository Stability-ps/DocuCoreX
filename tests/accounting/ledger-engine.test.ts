import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migration = readFileSync(join(root, "supabase/migrations/036_accounting_ledger_and_journals.sql"), "utf8");

/** SQL with comments stripped, so assertions test the schema and not its prose. */
const sql = migration.replace(/--[^\n]*/g, "");

const postFunction = sql.slice(sql.indexOf("function public.accounting_post_journal"), sql.indexOf("function public.accounting_reverse_journal"));

test("a journal cannot post unless debits equal credits", () => {
  // The rule the whole ledger rests on. Asserted on the posting function
  // because that is the only path into accounting_postings.
  assert.match(postFunction, /if total_debit <> total_credit then/);
  assert.match(postFunction, /raise exception/);
  assert.match(postFunction, /does not balance/);
});

test("balance is an exact equality, never a tolerance", () => {
  // numeric(18,2) is exact. If this ever becomes abs(diff) < something, a
  // ledger acquires a legal amount of drift per journal, and the drift
  // accumulates silently. Guard the shape, not just today's behaviour.
  assert.doesNotMatch(postFunction, /abs\s*\(\s*total_debit\s*-\s*total_credit\s*\)/i);
  assert.doesNotMatch(postFunction, /0\.0[0-9]/);
  assert.match(sql, /debit numeric\(18, 2\)/);
  assert.match(sql, /credit numeric\(18, 2\)/);
});

test("an empty or zero journal cannot post", () => {
  assert.match(postFunction, /if line_count = 0 then/);
  assert.match(postFunction, /if total_debit = 0 then/);
});

test("a journal cannot post twice, and a reversed journal cannot post again", () => {
  assert.match(postFunction, /if journal\.status = 'posted' then/);
  assert.match(postFunction, /if journal\.status = 'reversed' then/);
});

test("a closed or locked period refuses postings", () => {
  assert.match(postFunction, /from public\.accounting_periods/);
  assert.match(postFunction, /journal\.journal_date between period_start and period_end/);
  assert.match(postFunction, /if blocking_period is not null then/);
});

test("postings are append-only, enforced by trigger rather than by policy", () => {
  // This is the load-bearing detail. The codebase uses
  // createSupabaseServiceRoleClient(), and the service role BYPASSES RLS — so an
  // append-only rule written only as "no update policy" would hold for users and
  // evaporate for the API routes and workers that write the most.
  assert.match(sql, /create trigger accounting_postings_no_update\s+before update on public\.accounting_postings/);
  assert.match(sql, /create trigger accounting_postings_no_delete\s+before delete on public\.accounting_postings/);
  assert.match(sql, /accounting_postings_are_append_only/);

  // And the policies must not quietly grant what the triggers forbid.
  assert.doesNotMatch(sql, /create policy[^;]*on public\.accounting_postings\s+for update/);
  assert.doesNotMatch(sql, /create policy[^;]*on public\.accounting_postings\s+for delete/);
  assert.doesNotMatch(sql, /create policy[^;]*on public\.accounting_postings\s+for all/);
});

test("a posted journal's lines are frozen", () => {
  // Editing lines after posting would leave the ledger describing something the
  // journal no longer says.
  assert.match(sql, /accounting_journal_lines_frozen_once_posted/);
  assert.match(sql, /if journal_status in \('posted', 'reversed'\) then/);
  assert.match(sql, /create trigger accounting_journal_lines_guard\s+before insert or update or delete/);
});

test("a line carries exactly one side, as a magnitude", () => {
  // A negative debit is a credit wearing the wrong label; a line with both sides
  // is two lines; a line with neither is not a line.
  for (const table of ["journal_lines", "postings"]) {
    assert.match(sql, new RegExp(`accounting_${table}_non_negative check \\(debit >= 0 and credit >= 0\\)`));
    assert.match(sql, new RegExp(`accounting_${table}_one_sided check \\(\\(debit > 0\\) <> \\(credit > 0\\)\\)`));
  }
});

test("deleting a source document cannot destroy ledger history", () => {
  // §43. The link to the originating bank transaction is nulled, never
  // cascaded — the posting outlives its source.
  assert.match(
    sql,
    /source_transaction_id uuid references public\.accounting_transactions\(id\) on delete set null/,
  );
  assert.doesNotMatch(
    sql,
    /source_transaction_id uuid references public\.accounting_transactions\(id\) on delete cascade/,
  );
  // Journals and accounts a posting depends on are restricted, not cascaded.
  assert.match(sql, /journal_id uuid not null references public\.accounting_journals\(id\) on delete restrict/);
  assert.match(sql, /account_id uuid not null references public\.accounting_accounts\(id\) on delete restrict/);
});

test("a reversal is a posted journal, not an erasure", () => {
  const reverse = sql.slice(sql.indexOf("function public.accounting_reverse_journal"));
  // Sides swapped...
  assert.match(reverse, /line\.credit, line\.debit/);
  // ...posted through the same gate as any other journal...
  assert.match(reverse, /perform public\.accounting_post_journal\(reversal_id\)/);
  // ...the original marked, and its postings left where they are.
  assert.match(reverse, /set status = 'reversed'/);
  assert.doesNotMatch(reverse, /delete from public\.accounting_postings/);
  assert.match(reverse, /only a posted journal can be reversed/);
});

test("posting runs as the caller so isolation still applies", () => {
  // SECURITY DEFINER here would let any caller post into any workspace's
  // ledger, since the function would run with the definer's rights.
  assert.match(postFunction, /security invoker/);
  assert.doesNotMatch(postFunction, /security definer/);
});

test("absence of a period row means open", () => {
  // Only closed and locked periods get rows, so nothing has to pre-generate
  // twelve months per entity per year.
  const periods = sql.slice(sql.indexOf("create table if not exists public.accounting_periods"), sql.indexOf("create table if not exists public.accounting_journals"));
  assert.match(periods, /status text not null check \(status in \('soft_closed', 'locked'\)\)/);
  assert.doesNotMatch(periods, /'open'/);
});

test("periods cannot overlap for the same entity", () => {
  assert.match(sql, /accounting_periods_no_overlap[\s\S]{0,200}exclude using gist/);
  assert.match(sql, /daterange\(period_start, period_end, '\[\]'\) with &&/);
});

test("every ledger table is workspace-scoped, RLS-enabled and policied", () => {
  for (const table of ["accounting_periods", "accounting_journals", "accounting_journal_lines", "accounting_postings"]) {
    const definition = sql.slice(sql.indexOf(`create table if not exists public.${table}`));
    assert.match(
      definition.slice(0, 900),
      /workspace_id uuid not null references public\.workspaces\(id\) on delete cascade/,
      `${table} must carry workspace_id`,
    );
    assert.ok(sql.includes(`alter table public.${table} enable row level security`), `${table} needs RLS`);
    assert.match(sql, new RegExp(`create policy "[^"]+" on public\\.${table}`), `${table} needs a policy`);
  }
});

test("the migration is non-destructive", () => {
  assert.doesNotMatch(sql, /drop table/i);
  assert.doesNotMatch(sql, /truncate/i);
  assert.doesNotMatch(sql, /alter table public\.(accounting_transactions|documents|companies)[^;]*drop/i);
  for (const drop of sql.match(/drop (policy|constraint|trigger)[^;]*/gi) ?? []) {
    assert.match(drop, /if exists/i, `"${drop.trim()}" must be guarded with IF EXISTS`);
  }
});
