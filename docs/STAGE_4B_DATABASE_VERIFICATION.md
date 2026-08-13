# Stage 4B — Database Migration & Ledger Integration Verification

Migrations 035 and 036 were executed against a real PostgreSQL instance and the
accounting controls were exercised as behaviour rather than read as SQL.

**Four controls did not behave as the SQL read.** Migration 037 corrects them.

---

## 1. Environment

| | |
|---|---|
| `main` at start | `5242098bf676afe7e2d8277ce4d2c17e8c8c4ad8` (PR #143 squash-merged) |
| Working tree | clean |
| Database | PostgreSQL **16.14** (Homebrew), local, disposable |
| Data directory | scratch, port 55432, destroyed with the session |
| Migrations applied | **all 37**, in order, `ON_ERROR_STOP=1` |
| Errors | **0** |

### Why local, and not staging

There is no staging database to use. Verified:

- `.env.local` and `.env.production` resolve to **the same Supabase project**, so
  local development already runs against production.
- No Supabase branch or preview database is configured
  (`.vercel/.env.preview.local` carries no Supabase URL).
- Production was **not** used. Applying unexecuted schema changes to the only
  live database in order to unblock development is the thing this stage exists
  to avoid.

### Supabase shim

Vanilla PostgreSQL does not have Supabase's managed objects, so the harness
provides them. Nothing in the shim alters the migrations:

- `auth.users` (with `raw_user_meta_data`, which migration 001's
  `handle_new_user` trigger reads), `auth.uid()`, `auth.role()`
- roles `anon`, `authenticated`, `authenticator`, `service_role`
- `service_role` is created **`BYPASSRLS`**, which is what makes the append-only
  test meaningful
- `storage.buckets` / `storage.objects`

### Extensions required

`btree_gist` (financial-year and period exclusion constraints), `pgcrypto`,
`plpgsql`. All present after migration.

---

## 2. Objects created

| Object | Result |
|---|---|
| 7 accounting tables (035 + 036) | created, **RLS enabled on all 7** |
| `accounting_post_journal` | **compiled**, `security invoker` |
| `accounting_reverse_journal` | **compiled**, `security invoker` |
| `accounting_seed_chart_of_accounts` | compiled |
| `accounting_postings_are_append_only` | compiled |
| `accounting_journal_lines_frozen_once_posted` | compiled |
| Triggers | `accounting_postings_no_update`, `accounting_postings_no_delete`, `accounting_journal_lines_guard` — all present and enabled |
| Exclusion constraints | financial years and periods, both enforcing |

---

## 3. Findings

### Finding 1 — cross-entity postings were accepted (§14) · **SEVERE**

An Entity A journal with a line pointing at an **Entity B account** was accepted,
posted, and produced a ledger row whose `company_id` was Entity A while its
account belonged to Entity B.

The journal balanced, so the posting gate passed it. Nothing anywhere asserted
that an account belongs to the entity being posted to.

This is the failure the product can least afford: an accountant holding several
clients in one workspace would find one client's balance in another client's
trial balance, both sets of books internally consistent, neither obviously wrong.

**Fixed** by composite foreign keys on `(account_id, company_id)` and
`(journal_id, company_id)` — declarative, so the rule also holds for the service
role, for imports, and for code written later.

### Finding 2 — the ledger had more than one door (§20) · **SEVERE**

`accounting_postings` refused `UPDATE` and `DELETE` but accepted a direct
`INSERT`. A single statement could add one leg of an entry — no journal, no
balance check, no period check.

The verification suite did this by accident and **the trial balance went out by
R125.00**.

No application code does this today (searched `.insert(`, raw SQL, RPCs,
service-role calls, worker code: nothing outside tests references the table).
But "no caller does this yet" is not a control.

**Fixed** with a transaction-local gate flag that only `accounting_post_journal`
sets, checked by a `BEFORE INSERT` trigger.

### Finding 3 — concurrent posting doubled a journal (§17) · **SEVERE**

Two simultaneous connections calling `accounting_post_journal` for the same
journal both read `status = 'draft'`, both passed every check, and both inserted.

Measured, against the original function:

```
R1,000,000 journal → 4 posting rows, total debit 2,000,000.00
```

Exactly the double-click / worker-retry scenario. **Fixed** with `SELECT … FOR
UPDATE` on the journal row; the second caller waits, then sees `posted` and is
refused. Re-measured after the fix: **2 rows, 1,000,000.00**.

### Finding 4 — source transactions became undeletable (§12) · **HIGH**

`source_transaction_id` is `ON DELETE SET NULL` so the ledger survives a deleted
statement. But `SET NULL` is an `UPDATE`, and the append-only trigger refused
every `UPDATE` — so **once any posting referenced a bank transaction, that
statement could never be deleted at all**.

The ledger was never at risk; the *source* was. This would have broken the
existing delete-statement path the moment Stage 5 started linking the two.

Only execution could find this. **Fixed** with a deliberately narrow carve-out:
the reference may go from set to `NULL` and **nothing else about the row may
differ** — every field carrying accounting meaning is compared.

### Minor

The append-only message read "a posting cannot be update once made". Corrected
to "changed" / "removed".

---

## 4. Test battery — 63 assertions, 0 failures

Executed against the migrated database, after 037.

| § | Test | Result |
|---|---|---|
| 5 | Balanced journal posts; 2 rows; Dr = Cr = 1,000.00; correct entity, date, accounts; date inside FY | **7 PASS** |
| 6 | Unbalanced (1,000.00 / 999.99) rejected — `difference 0.01`; 0 rows; ledger untouched; stays draft | **4 PASS** |
| 7 | `numeric(18,2)`; 0.10+0.20+0.30 = 0.60 exactly; 1,234.56 and 99,999.99 stored exactly; control shows `float8` giving `0.30000000000000004` | **5 PASS** |
| 9 | Locked period refuses a balanced journal; 0 rows; ledger unchanged; journal outside the lock still posts | **5 PASS** |
| 10 | Posts with **zero** period rows defined; no pre-generation required | **2 PASS** |
| 11 | Reversal: original postings survive, new postings created, sides inverted, linked, original `reversed`, **net effect 0.00**, nothing deleted | **8 PASS** |
| 12 | Source deleted → postings survive, journal survives, reference `SET NULL`, amount unchanged | **5 PASS** |
| 13 | Account with postings cannot be deleted; history intact; deactivation works | **3 PASS** |
| 14 | Cross-entity line rejected **at insert**; 0 stored; 0 posted; 0 mismatched postings in the whole ledger | **4 PASS** |
| 15 | Overlapping financial years rejected by exclusion constraint; every posting inside a declared FY | **2 PASS** |
| 16 | Second post call refused (`journal is already posted`); one set of postings; **amount not doubled** | **3 PASS** |
| 18 | Both legs post together; no half-posted journal; every posted journal balances in the ledger | **3 PASS** |
| 18b | Forced mid-post failure → raises, **no orphan first leg**, journal not marked posted, row count unchanged | **4 PASS** |
| 19 | Posted cannot re-post; posted lines frozen; reversed cannot re-post | **3 PASS** |
| 20 | Direct `INSERT` refused; row count unchanged; gate closes again after a legitimate post | **3 PASS** |
| 21 | Trial balance from postings: **105,845.15 / 105,845.15 / difference 0.00 — BALANCED** | **1 PASS** |

### §8 Append-only under service role

Run on a real `BYPASSRLS` connection (`role=service_role bypassrls=true`):

```
UPDATE accounting_postings … → ERROR: accounting_postings is append-only …
DELETE FROM accounting_postings … → ERROR: accounting_postings is append-only …
```

Original posting unchanged. **The protection is the trigger, not RLS** — which
matters because production writes through the service role.

### §22 Ledger balance proof, from postings alone

```
code  name                     normal   debits      credits     closing
1100  Bank                     debit    103,835.15    1,010.00  102,825.15
2100  Shareholder Loan         credit         0.00  104,335.15  104,335.15
6100  Repairs & Maintenance    debit      2,010.00      500.00    1,510.00
```

No bank-statement category was consulted.

---

## 5. Not verified

**§23 application integration against the migrated schema.**

The app reaches Supabase over PostgREST/GoTrue, not a raw PostgreSQL socket, so
it cannot be pointed at this instance. Running it needs one of:

- **Docker + Supabase CLI** — `supabase start` gives the full local stack
  (PostgREST, GoTrue, Storage) and `supabase db push` applies the migrations; or
- a **Supabase staging/branch project** to apply migrations to.

Neither is available here. The journal API and form were verified against the
schema statically and in no-backend mode only. Until one of the above exists,
the UI's behaviour against real postings is unproven — the database controls
beneath it now are not.

---

## 6. Reproducing this

`scripts/verify-ledger.sh` rebuilds the whole thing from scratch: initdb, shim,
all 37 migrations, fixture, and the battery. It uses a scratch data directory
and never touches a configured database.

```
./scripts/verify-ledger.sh
```
