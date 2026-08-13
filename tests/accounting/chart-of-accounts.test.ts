import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migration = readFileSync(join(root, "supabase/migrations/035_accounting_entities_and_chart.sql"), "utf8");
const model = readFileSync(join(root, "lib/accounting/model.ts"), "utf8");

/** Codes and names from the seeded chart in the migration, in file order. */
function seededAccounts(): Array<{ code: string; name: string }> {
  const body = migration.slice(migration.indexOf("insert into public.accounting_accounts"), migration.indexOf("on conflict do nothing"));
  return [...body.matchAll(/'(\d{4})',\s*'([^']*)'/g)].map((match) => ({ code: match[1], name: match[2] }));
}

/** Codes and names from the chart the product already reports against. */
function modelAccounts(): Array<{ code: string; name: string }> {
  const body = model.slice(model.indexOf("export const CHART"), model.indexOf("const BY_NUMBER"));
  return [...body.matchAll(/number: "(\d{4})", name: "([^"]*)"/g)].map((match) => ({ code: match[1], name: match[2] }));
}

test("the seeded chart is exactly the chart the product already reports against", () => {
  // The seed is a transcription, not an improvement. A "better" starter chart
  // introduced here would silently change what every existing export means —
  // the same statement would map to different accounts before and after the
  // migration, with nothing in the ledger recording that it had happened.
  // Stage 5 is where the chart may grow, once the ledger is authoritative.
  const seeded = seededAccounts();
  const existing = modelAccounts();

  assert.ok(seeded.length > 0, "the migration should seed a chart");
  assert.deepEqual(
    seeded,
    existing,
    "the seeded chart drifted from lib/accounting/model.ts CHART — they must stay identical code-for-code and name-for-name",
  );
});

test("normal balance follows the account type, and every account declares one", () => {
  const body = migration.slice(migration.indexOf("insert into public.accounting_accounts"), migration.indexOf("on conflict do nothing"));
  const rows = [...body.matchAll(/'(\d{4})',\s*'[^']*',\s*'(\w+)',\s*'(\w+)'/g)];

  assert.equal(rows.length, seededAccounts().length, "every seeded account must state a type and a normal balance");

  const expected: Record<string, string> = {
    asset: "debit",
    expense: "debit",
    cost_of_sales: "debit",
    other_expense: "debit",
    liability: "credit",
    equity: "credit",
    income: "credit",
    other_income: "credit",
  };

  for (const [, code, accountType, normalBalance] of rows) {
    assert.equal(
      normalBalance,
      expected[accountType],
      `account ${code} is a ${accountType} so its normal balance should be ${expected[accountType]}`,
    );
  }
});

test("financial years cannot overlap for the same entity", () => {
  // Stated in the database rather than the UI. A UI-only rule is bypassed by an
  // import, a direct write, or any later API, and two years claiming the same
  // day makes every balance for that day depend on which year a query picks.
  assert.match(migration, /create extension if not exists btree_gist/);
  assert.match(migration, /exclude using gist/);
  assert.match(migration, /company_id with =/);
  assert.match(migration, /daterange\(start_date, end_date, '\[\]'\) with &&/);
  // Inclusive of the end date, because a financial year includes its last day.
  assert.doesNotMatch(migration, /daterange\(start_date, end_date, '\[\)'\)/);
});

test("the entity is the existing company, not a second entity store", () => {
  // §45: no duplicate accounting data stores. `companies` already models the
  // entity — workspace-scoped, one default per workspace, carrying the
  // registration and VAT numbers an entity is identified by.
  assert.doesNotMatch(migration, /create table[^;]*accounting_entities\b/);
  for (const table of ["accounting_entity_settings", "accounting_financial_years", "accounting_accounts"]) {
    const definition = migration.slice(migration.indexOf(`create table if not exists public.${table}`));
    assert.match(
      definition.slice(0, 800),
      /company_id uuid[\s\S]*references public\.companies\(id\) on delete cascade/,
      `${table} must hang off companies`,
    );
  }
});

test("every new table is workspace-scoped, RLS-enabled and policied", () => {
  for (const table of ["accounting_entity_settings", "accounting_financial_years", "accounting_accounts"]) {
    const definition = migration.slice(migration.indexOf(`create table if not exists public.${table}`));
    assert.match(
      definition.slice(0, 800),
      /workspace_id uuid not null references public\.workspaces\(id\) on delete cascade/,
      `${table} must carry workspace_id for RLS`,
    );
    assert.ok(migration.includes(`alter table public.${table} enable row level security`), `${table} needs RLS enabled`);
    assert.match(
      migration,
      new RegExp(`create policy "[^"]+" on public\\.${table}`),
      `${table} needs an RLS policy`,
    );
  }
});

test("an account is deactivated rather than deleted, and system accounts are marked", () => {
  // Deleting an account with history orphans the ledger. §11 requires
  // deactivation; the posting-side guard arrives with postings in Stage 4.
  assert.match(migration, /is_active boolean not null default true/);
  assert.match(migration, /is_system boolean not null default false/);
  assert.match(migration, /parent_id uuid references public\.accounting_accounts\(id\) on delete restrict/);
});

test("the migration is non-destructive and re-runnable", () => {
  // Production safety §45: this must not drop, alter or delete anything that
  // already exists, and running it twice must not duplicate a chart.
  assert.doesNotMatch(migration, /drop table/i);
  assert.doesNotMatch(migration, /delete from/i);
  assert.doesNotMatch(migration, /truncate/i);
  // The only permitted drops are of the migration's own policies and its own
  // constraint, which is how those are made re-runnable.
  for (const drop of migration.match(/drop (policy|constraint)[^;]*/gi) ?? []) {
    assert.match(drop, /if exists/i, `"${drop.trim()}" must be guarded with IF EXISTS`);
  }
  assert.match(migration, /on conflict do nothing/);
  assert.match(migration, /on conflict \(company_id\) do nothing/);
});

test("no framework compliance is asserted by default", () => {
  // §44: the product must not hard-code a claim that its output is IFRS or
  // IFRS-for-SMEs compliant. The accountant states the framework.
  const settings = migration.slice(
    migration.indexOf("create table if not exists public.accounting_entity_settings"),
    migration.indexOf("create table if not exists public.accounting_financial_years"),
  );
  assert.match(settings, /reporting_framework text/);
  assert.doesNotMatch(settings, /reporting_framework text not null default/i);
  // Comments stripped first: the column's own comment names IFRS in order to say
  // the product must not claim it, and asserting over the prose would fail on
  // the explanation rather than on the schema.
  const sqlOnly = settings.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(sqlOnly, /IFRS/i);
});
