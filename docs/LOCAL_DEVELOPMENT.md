# Local development

Local development runs against a **local Supabase stack**, never production.
`next dev` refuses to start against the production project
(`lib/database-environment.ts`); that guard stays on.

## Requirements

* Docker Desktop, running, with **8–10 GB of free disk** for the Supabase images.
* Node 24 and pnpm (as in CI).
* The Supabase CLI, run through npx so the version is pinned and nothing is
  installed globally: `npx -y supabase@2.121.0 …`

## First run

```bash
npx -y supabase@2.121.0 start      # first run pulls the images (several GB)
./scripts/local-db-reset.sh        # migrations 001..latest, then the synthetic seed
npx -y supabase@2.121.0 status     # prints the local API URL and keys
```

Put the printed values in `.env.local` (which is git-ignored):

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key from `supabase status`>
SUPABASE_SERVICE_ROLE_KEY=<service_role key from `supabase status`>
NEXT_PUBLIC_REQUIRE_AUTH=true
```

Leave every provider key (OpenAI, Mistral, Azure) **unset** locally unless you
are deliberately testing that integration with synthetic documents.

Then `pnpm dev`.

## Resetting

`./scripts/local-db-reset.sh` rebuilds the local database from scratch at any
time: all migrations in order, then `supabase/seed.local.sql`. It only ever
talks to `127.0.0.1:54322`.

## Seeded accounts

Password for all: `local-dev-only-password`. The `.test` domain is reserved, so
none of these addresses can exist.

| Account | Workspace | Role |
|---|---|---|
| `owner-a@docucorex.test` | A | Owner |
| `admin-a@docucorex.test` | A | Admin |
| `viewer-a@docucorex.test` | A | Viewer |
| `owner-b@docucorex.test` | B | Owner (the "other tenant") |

Use A and B to test isolation: anything owner-a creates must be invisible to
owner-b, and viewer-a must not be able to manage the team.

## Why the seed is not applied automatically

`supabase/config.toml` has `[db.seed] enabled = false` on purpose. Supabase's
GitHub integration creates **hosted preview branches** from this same config,
and those are reachable from the internet; an automatic seed would put accounts
with a published password on them. The reset script applies the seed locally
only.

## Test documents

Use synthetic documents only. The accounting worker's regression suite
generates sanitised FNB-style statements
(`workers/accounting_worker/tests/fixtures/sanitised_statements.py`). Never copy
customer documents into a local stack, a fixture, or a test.

## Tests that need no Supabase at all

* `pnpm test` (Playwright) runs with Supabase blanked, in demo mode.
* `scripts/verify-ledger.sh` applies every migration to a disposable PostgreSQL
  and runs the SQL battery (`PGBIN=…/postgresql@17/bin` on a machine with 17).
* The unit suites (`pnpm test:security`, `test:pdf`, …) and the Python
  regression suite need neither.

## When a hosted staging environment becomes necessary

Local Supabase is enough while one developer works on code and migrations. A
hosted staging project becomes necessary when any of these is true:

* **More than one person** needs to test the same build (QA, the owner, a client
  preview), or tests must run on a phone over the internet.
* **Integrations** need a public URL: auth email links and redirects, OAuth
  (Google/Microsoft) callbacks, Vercel preview deployments talking to a database.
* **Workers on Render** need testing end to end (conversion and accounting
  workers cannot reach a laptop).
* **Migrations need rehearsal** against a production-shaped database before they
  are applied to production. Today that is done with a rolled-back dry run in
  production, which works but is not a substitute for a rehearsal environment.

At that point, create a second Supabase project, apply the migrations, point
Vercel Preview and a staging Render service at it, and keep production
credentials out of it.

## Known limitation

This setup was written and reviewed on 2026-10-19 but **could not be run end to
end on the authoring machine**, which had 4 GB of free disk (not enough for the
Supabase images). The SQL migrations themselves are verified independently by
`scripts/verify-ledger.sh` and by Supabase preview branches; the seed and the
reset script have not yet been executed against a local stack.
