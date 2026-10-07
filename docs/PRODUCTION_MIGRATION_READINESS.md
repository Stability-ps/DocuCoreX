# Production migration state — accounting schema

**Status: APPLIED. Production is at 001–047.**

| | |
|---|---|
| Live Supabase project | `efprtqcpglsawifrsmcc`, applied through **047** |
| This repository | contains through **047** |
| Gap | none |
| Verified | 2026-10-07, direct catalog queries (`pg_class`, `pg_proc`, `pg_trigger`, `pg_constraint`, `pg_indexes`, `pg_policies`, `information_schema.columns`) |

Migrations are applied by hand, not by the Supabase CLI, so the
`supabase_migrations.schema_migrations` table records only one unrelated entry
and **cannot** be used to read the state. Every check below asks the catalog
for the objects each migration creates.

## How parity was established (2026-10-07)

Every table, function, trigger, named constraint, index, RLS policy and
`ALTER TABLE … ADD COLUMN` declared across `supabase/migrations/*.sql` was
extracted and checked for existence in production. Two migrations were missing
in full and nothing else was:

| Migration | Production state found | Effect while missing | Fix |
|---|---|---|---|
| **010** notifications upgrade | never applied — table still had the legacy `read boolean` and none of `type`, `entity_type`, `entity_id`, `href`, `read_at` or the two indexes | `createNotification` inserts failed (returned `null`), mark-as-read silently matched nothing; the notifications policy still lacked the per-user `user_id` clause | applied 2026-10-07; table held 0 rows, so dropping `read` lost nothing |
| **034** accounting engagement | `accounting_engagement` absent, despite the previous version of this document saying it had been applied | `saveWorkspaceEngagement` degraded; coverage tolerated it (`42P01` branch) | applied 2026-10-07 |

Two further migrations were written during the release audit and applied the
same day:

| Migration | What it does | Verified in production |
|---|---|---|
| **046** RPC tenant guards | `next_invoice_sequence` / `next_company_invoice_sequence` gain an ownership check (`42501` otherwise) and lose the `anon`/`PUBLIC` grant; `accounting_seed_chart_of_accounts` / `accounting_seed_tax_codes` lose every client grant | over PostgREST: anon → 401 on all four; tenant A on tenant B's workspace/company → 403 `access denied`; tenant A on its own → 200, consecutive numbers; tenant B's counters untouched; a new company is still seeded with 32 accounts and 7 tax codes |
| **047** pin trigger search_path | `set search_path = public` on the six ledger-integrity trigger functions, the only functions in the schema without one | no unpinned plpgsql/sql function remains in `public`; the advisor's `function_search_path_mutable` findings are gone |

Before 046, all four functions were callable with nothing but the public anon
key and trusted the id they were given — anyone could advance another
tenant's invoice counter (a gap in its tax-invoice numbering) or write chart
rows under another company. Regression coverage: `tests/sql/35_rpc_tenancy.sql`
and `tests/sql/36_function_search_path.sql`, run by `scripts/verify-ledger.sh`.

## Constraint and trigger behaviour — now verified

The previous version of this document listed these as unprovable through
PostgREST. With catalog access they are confirmed present, **enabled**
(`pg_trigger.tgenabled = 'O'`) and **validated** (`pg_constraint.convalidated`):

- append-only triggers on `accounting_postings` (`…_no_update`, `…_no_delete`)
  and on `accounting_audit_events`, `accounting_import_batches`,
  `accounting_import_batch_errors`
- the single posting gate: `accounting_postings_gate` trigger, and
  `accounting_post_journal` both opens `docucorex.ledger_gate` and takes the
  `FOR UPDATE` row lock that prevents a concurrent double-post
- 037's composite same-entity foreign keys
  (`accounting_postings_{journal,account}_same_entity`,
  `accounting_journal_lines_{journal,account}_same_entity`)
- the exclusion constraints on financial years, accounting periods and VAT
  periods
- `accounting_postings_one_sided` and `accounting_postings_non_negative`
- 041/042: the journal-line and reconciliation-item freeze triggers, the
  `accounting_fixed_assets` check constraints and the
  `accounting_asset_movements_one_depreciation_per_month` partial unique index

Their **behaviour** is exercised by the ledger battery against a real
PostgreSQL 16 built from the same migrations (`scripts/verify-ledger.sh`:
210 passed, 0 failed, trial balance proof BALANCED).

Production itself holds **0 journals and 0 postings** as of 2026-10-07: the
general ledger has not yet been used there, so these guards have not yet been
exercised by live data.

## Other drift noted, deliberately left alone

`public.folders` exists in production but is created by no migration — it
comes from the bootstrap `supabase/schema.sql`. It has RLS enabled with a
workspace-scoped policy, holds 0 rows and is not referenced by the app.

## Correction history

- An earlier version said "applied through 034" with six pending; in fact
  035–040 were applied and 034 was not.
- The 2026-08-14 version said 034 had since been applied and that production
  was at 001–042 with no gap. Neither was true: 034 was still missing and 010
  had never been applied. Both were inferred from indirect PostgREST probes.

The lesson, twice over: migration state is a property of the database, and
the only reliable way to know it is to ask the database's catalog.

## Environment risk, unchanged

`.env.local` and `.env.production` resolve to the same Supabase project, so
local development runs against production. There is no staging or branch
database. Recommended separation:

| Environment | Database | Credentials live in |
|---|---|---|
| Production | current project | Vercel environment variables only |
| Staging | new Supabase project | CI secrets |
| Local | staging project, or a local Supabase stack | `.env.local` |

At minimum, local development should stop pointing at production.
