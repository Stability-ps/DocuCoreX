# Production migration state — accounting schema

**Status: APPLIED. Production is at 001–040.**

| | |
|---|---|
| Live Supabase project | applied through **040** |
| This repository | contains **035 – 040** |
| Gap | none |
| Verified | 2026-08-13, read-only probe via PostgREST |

## How this was established

All 035–040 tables present. Columns added by later migrations present
(`accounting_postings.source_transaction_id` and `.tax_code_id`,
`accounting_journal_lines.source_transaction_id` and `.tax_code_id`,
`accounting_tax_codes.control_account_id`,
`accounting_bank_accounts.ledger_account_id`). Reporting functions execute:
`accounting_trial_balance`, `accounting_general_ledger`,
`accounting_bank_ledger_balance`, `accounting_vat_summary`,
`accounting_vat_register` all returned HTTP 200.

Seed arithmetic is exact, which confirms the backfills ran:

    24 companies → 24 accounting_entity_settings
                 → 672 accounting_accounts   (24 × 28)
                 → 168 accounting_tax_codes  (24 × 7)

Ledger tables (`accounting_journals`, `accounting_journal_lines`,
`accounting_postings`, `accounting_periods`, reconciliation and VAT period
tables) all exist and are empty.

Migration 034 was found MISSING while 035–040 were present, and was applied
separately, out of order. Harmless: nothing in 035–040 references
`accounting_engagement`, and it references nothing from them. Its absence had
been degrading `saveWorkspaceEngagement` in production; `getWorkspaceCoverage`
already tolerated it (see the `42P01` branch in lib/accounting/server.ts).

## Correction to the previous version of this document

An earlier version stated "Production Supabase: applied through 034" with six
migrations pending. **That was never verified — it was inferred from the
migrations being new in the repository and written down as fact.** It was wrong
in both directions: 035–040 were already applied, and 034 was not.

The lesson worth keeping: migration state is a property of the database, not of
the repository, and the only way to know it is to ask the database.

## What remains UNVERIFIED in production

Table and function **existence** is confirmed. Constraint and trigger
**behaviour** is not, and cannot be confirmed through PostgREST — it exposes
rows and functions, not `pg_constraint` or `pg_trigger`.

Specifically unproven in production:

- the append-only triggers on `accounting_postings`
  (`accounting_postings_no_update`, `accounting_postings_no_delete`)
- the single posting gate (`accounting_postings_gate` / `docucorex.ledger_gate`)
- 037's composite entity-isolation foreign keys
- the `FOR UPDATE` row lock preventing concurrent double-posting
- the exclusion constraints on financial years, accounting periods and VAT
  periods

These are exactly the four defects that only appeared when migration 036 was
executed against a real PostgreSQL in Stage 4B. All were fixed in 037, but
whether the fixed versions are what production actually holds is unknown.

`accounting_postings` is empty, so no ledger data is at risk yet. This is the
cheapest possible moment to check.

**To verify:** `SUPABASE_DB_PASSWORD` or a Management API token, then query
`pg_constraint`, `pg_trigger` and `pg_proc` directly. A few queries settle it.

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
