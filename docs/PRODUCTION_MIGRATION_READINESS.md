# Production migration readiness — accounting schema 035–040

**Status: NOT APPLIED. The live Supabase project is at migration 034.**

Everything the accounting workspace has built since Stage 3 — the chart of
accounts, the ledger, the posting gate, the General Ledger and Trial Balance —
exists in this repository and in a verified local PostgreSQL, and **nowhere
else**. No production feature may be enabled until this rollout is done.

This document exists so the gap is visible and bounded rather than quietly
growing. Update it whenever a migration is added or applied.

---

## 1. Current state

| | |
|---|---|
| Live Supabase project | applied through **034** |
| This repository | contains **035 – 040** |
| Gap | **6 migrations** |
| Verified against | PostgreSQL 16.14, local, disposable |
| Verification | `./scripts/verify-ledger.sh` — 88 assertions, 0 failures |
| Never run against | the live database |

There is no staging environment. `.env.local` and `.env.production` resolve to
the same Supabase project, and no branch or preview database is configured. That
is the reason the gap exists, and closing it is the first item in §4.

## 2. What is pending

| # | Migration | What it does | Risk if applied |
|---|---|---|---|
| 035 | `accounting_entities_and_chart` | entity settings, financial years, chart of accounts; seeds the starter chart | **Low.** Additive. Creates a default company per workspace that has none, and seeds a chart per company. Idempotent. |
| 036 | `accounting_ledger_and_journals` | periods, journals, journal lines, postings; posting gate; append-only triggers | **Low–medium.** Additive tables and functions. Adds two triggers, but only on its own new tables. |
| 037 | `accounting_entity_isolation` | composite FKs for entity isolation, single posting gate, `FOR UPDATE` lock, source-deletion carve-out | **Medium.** Adds `UNIQUE (id, company_id)` to `accounting_accounts` and `accounting_journals`, and a column to `accounting_journal_lines`. Fails loudly if a cross-entity row exists — there can be none, since no ledger data exists in production yet. |
| 038 | `accounting_ledger_reporting` | GL / TB / opening-balance functions, one index | **Low.** Read-only functions plus an index on a table that is empty in production. |
| 039 | `accounting_bank_reconciliation` | bank-account control mapping, reconciliations, reconciliation items | **Low.** Additive. |
| 040 | `accounting_tax_codes_and_vat` | tax codes, VAT periods, `tax_code_id` on lines and postings, VAT summary/register functions | **Low–medium.** Additive, and seeds tax codes per company. Adds an AFTER INSERT trigger on `companies` that seeds accounting setup for newly created entities — the only pending migration that touches a pre-existing table's behaviour. |

**No pending migration drops, truncates or deletes anything.** Asserted by test
in each migration's suite. The only `DROP`s are of each migration's own policies,
constraints and triggers, each guarded with `IF EXISTS`.

## 3. Order dependency

Strictly sequential. 037 alters objects created by 035 and 036; 038's functions
read tables from 035 and 036; 039 references the chart from 035 and postings from
036; 040 adds columns to 036's tables and reads 035's chart.

```
034 (live) → 035 → 036 → 037 → 038 → 039 → 040
```

## 4. Rollout procedure

### Step 1 — get a database that is not production

This is the blocking prerequisite and the reason for everything else here.
Either:

- **Supabase branching** — create a preview branch from the production project.
  It clones the schema, so the rollout is rehearsed against the real 034 schema
  rather than against a reconstruction; or
- **Local Supabase stack** — `brew install docker` (or Docker Desktop), then
  `supabase start` and `supabase db push`. Also unblocks the application
  integration testing still outstanding from Stage 4B.

Do not skip this step by applying to production and watching what happens.

### Step 2 — rehearse

```bash
supabase db push --db-url "<branch or local connection string>"
./scripts/verify-ledger.sh          # 88 assertions against a clean schema
```

Then run the app against that database and exercise: Chart of Accounts, create
and post a journal, reject an unbalanced one, General Ledger, Trial Balance,
account drill-down, and reconciliation once 039 lands. This is the §23 gap from
Stage 4B, still open.

### Step 3 — back up production

Take a snapshot before applying. Supabase's PITR does not remove the need for a
deliberate restore point immediately before a schema change.

### Step 4 — apply, in order, in one transaction per migration

```bash
supabase db push
```

Verify after applying:

```sql
-- tables
select tablename from pg_tables where schemaname='public'
  and tablename like 'accounting_%' order by 1;
-- functions
select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and proname like 'accounting_%' order by 1;
-- triggers
select tgname, c.relname from pg_trigger t join pg_class c on c.oid=t.tgrelid
  where not tgisinternal and c.relname like 'accounting_%' order by 2,1;
-- extension
select extname from pg_extension where extname='btree_gist';
```

`btree_gist` is required by 035 and 036. If the Supabase project cannot create
extensions from a migration, create it from the dashboard first.

### Step 5 — verify the backfill

035 creates a default company for any workspace lacking one, and seeds a chart
per company. Confirm counts are what the workspace count predicts, and that no
pre-existing company was modified.

## 5. Rollback

The pending migrations are additive, so the fastest rollback is to leave the new
objects in place unused — nothing in 001–034 reads them, and the accounting
workspace's new routes are the only consumers.

If objects must be removed, drop in reverse order (039 → 035). Note that
`accounting_postings` refuses `DELETE` by trigger; the trigger must be dropped
before the table can be.

**Do not roll back by restoring a snapshot** once any user has written ledger
data, since that discards their postings along with the schema.

## 6. Enablement gate

Until this rollout is complete, the accounting routes that depend on 035–039
will show their error or empty states in production rather than working
features:

`/accounting/chart-of-accounts`, `/accounting/journals`,
`/accounting/general-ledger`, `/accounting/trial-balance`,
`/accounting/reconciliation`, `/accounting/vat`

They fail safe — an unmigrated database produces a load error, not wrong numbers
— but they should not be presented to users as finished until the schema is
there. The bank-statement pipeline, which is what production runs today, is
unaffected by every one of these migrations.

## 7. Checklist

- [ ] Non-production database available (Supabase branch or local stack)
- [ ] `supabase db push` rehearsed against it, clean
- [ ] `./scripts/verify-ledger.sh` green against the rehearsal database
- [ ] Application exercised against the rehearsal database (Stage 4B §23)
- [ ] Production snapshot taken
- [ ] `btree_gist` available in the production project
- [ ] 035 – 040 applied in order
- [ ] Catalog verification queries run and recorded
- [ ] Backfill counts confirmed
- [ ] Accounting routes verified in production
- [ ] This document updated to say "applied through 040"
