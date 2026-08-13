# Accounting & Financial Reporting — Implementation Map

Stage 1 deliverable: the audit of the existing accounting module and the staged
plan to turn it into a production accounting and financial reporting workspace.

This document is the reference the later stages are built against. It records
what exists **today**, verified by reading the code, so that later stages can be
judged against a real baseline rather than an assumed one.

Audited at `0b0bdef`.

---

## 1. What exists today

### 1.1 The shape of the module

The whole workspace is **one client component**, `components/accounting/accounting-intelligence.tsx`
(4,423 lines), mounted by a ten-line page shell (`app/accounting/page.tsx`).

Navigation is React state, not routing. Two levels:

- `AccountingModule` (`:87`) — Bank Statements, Financial Statements, Tax & VAT,
  Transaction Insights, Forecasting, Audit Tools
- `AccountingTab` (`:86`) — Transactions, Review, Difference Inspector, Summary,
  Bank Reconciliation, VAT, General Ledger, Provisional Ledger

There are **two routes in total**:

```
/accounting
/accounting/statements/[statementId]
```

Consequence: nothing in the workspace is linkable, bookmarkable, or
server-renderable per section, and every section's code loads on every visit.

### 1.2 The data model

`accounting_transactions` (migration `003`) is the only transaction store:

```sql
run_id, workspace_id, transaction_date, description,
debit_amount, credit_amount, running_balance,
bank_charge, account_category, vat_treatment,
supported_by_invoice, notes, confidence, review_status,
source_page, raw_text
```

This is a **flat bank-statement row table**. `account_category` is a text label,
`debit_amount`/`credit_amount` are the two sides of the *bank* movement — not
ledger postings.

Accounting tables that exist: `accounting_statement_runs`,
`accounting_transactions`, `accounting_transaction_tags`,
`accounting_transfer_matches`, `accounting_recurring_decisions`,
`accounting_classification_rules`, `accounting_merchant_knowledge`,
`accounting_ai_learning_events`, `accounting_review_comments`,
`accounting_parser_health`, `accounting_parser_failures`,
`accounting_statement_analytics`, `accounting_action_audit`,
`accounting_engagement`.

### 1.3 What "General Ledger" and "Trial Balance" currently are

Both are **derived in memory at export time** and never persisted.

`lib/accounting/model.ts:289-295` synthesises a balanced debit/credit pair per
bank row, against a hardcoded bank account:

```ts
if (t.debit > 0) {
  journals.push({ ...base, accountNumber: t.account.number, debit: t.debit, credit: 0 });
  journals.push({ ...base, accountNumber: BANK_ACCOUNT.number, debit: 0, credit: t.debit });
}
```

`model.ts:301+` then groups those pairs into ledger accounts to produce the
"Trial Balance". It balances by construction — every row emits one debit and one
equal credit — so it cannot *fail* to balance, and therefore cannot detect that
anything is wrong.

The UI is honest about this: the tab is labelled **"Provisional Ledger"**
(`accounting-intelligence.tsx:110`), not Trial Balance.

### 1.4 The chart of accounts

A hardcoded 28-entry TypeScript array, `model.ts:25-56`. It has
`number`, `name`, `type`, `group`, `statement` and nothing else.

Not per-company. Not editable. No hierarchy, no parent accounts, no VAT default,
no AFS mapping, no cash-flow mapping, no opening balance, no active/inactive
flag, no system-account lock.

### 1.5 VAT

An estimate, not a tax-code system. `export.ts:97` sets `VAT_RATE = 15 / 115`
and applies it to bank amounts (`export.ts:159-160`). Transactions carry a
five-value `vat_treatment` enum (`standard`, `zero_rated`, `exempt`,
`out_of_scope`, `review`).

The VAT Working Paper is real and traceable to transactions, and its own header
says so: *"VAT estimated at 15% inclusive (15/115) … Verify against valid tax
invoices and SARS VAT201. Not tax advice."*

### 1.6 Financial Statements

`FinancialStatementsPanel` (`accounting-intelligence.tsx:3336`) renders P&L,
Cash Flow and Ratios computed from statement analytics. It is a management
report over one statement run — not annual financial statements, and not derived
from an adjusted trial balance.

### 1.7 Scoping

Every accounting table is scoped by **`workspace_id`**, with RLS resolving
through `profiles`. `company_id` appears in exactly one migration (`009`,
company profiles) and **nowhere in the accounting schema**.

### 1.8 What is genuinely production-grade

To be preserved and built on, not replaced:

- The bank-statement pipeline: upload → detect → extract → validate → review.
  This is the most mature part of the product and carries real reconciliation
  controls (balance continuity, declared-vs-extracted turnover, the
  Difference Inspector).
- The Python parsing worker, its regression suite, and the ledger-repair and
  validation-recovery work of PRs C1–C2d.
- Export (`lib/accounting/export.ts`, 1,022 lines) — multi-sheet Excel with
  working papers.
- Transfer matching, recurring-transaction detection, merchant knowledge,
  classification rules and provenance.
- The statement split workspace (source PDF left, transactions right).

---

## 2. Gap analysis against the specification

| Required | Today | Gap |
|---|---|---|
| Double-entry ledger as source of truth | In-memory pairs at export | **Missing** — needs persisted postings |
| Journals (9 types, draft→posted→reversed) | None | **Missing** |
| Editable, per-company chart of accounts | Hardcoded 28-row array | **Missing** |
| Trial balance derived from posted lines | Derived from bank rows | **Missing** |
| Accounting periods, close, locking | None | **Missing** |
| Bank reconciliation as a saved record | Computed view only | **Partial** |
| Tax codes, VAT periods, VAT lock | Estimate + 5-value enum | **Partial** |
| AR / AP / Fixed assets | None (invoices exist separately) | **Missing** |
| AFS mapping, notes, policies, lifecycle | None | **Missing** |
| Opening balances | None | **Missing** |
| Company isolation | Workspace-scoped | **Architectural gap** |
| ~17 routes | 2 routes | **Missing** |
| Audit trail across all entities | Generic table, narrow use | **Partial** |

---

## 3. Target architecture

One ledger. Everything reads from it.

```
Source Documents → Extraction → Review → Posting → General Ledger
                                                        ↓
                                                  Trial Balance
                                                        ↓
                                                  Adjustments
                                                        ↓
                                            Adjusted Trial Balance
                                                        ↓
                                              Financial Statements
```

The existing bank-statement pipeline becomes a **source feeding the ledger**,
not a parallel accounting system. A reviewed transaction is *posted* into
`accounting_postings`; every report then derives from postings alone.

This is the load-bearing decision of the whole programme: reports must never
again read `accounting_transactions` directly.

---

## 4. Schema plan

New tables, all company-scoped and RLS-protected:

```
accounting_entities            -- company/entity, financial year, currency, framework
accounting_financial_years     -- non-overlapping ranges per entity
accounting_periods             -- open | soft_closed | locked
accounting_accounts            -- chart of accounts, hierarchical
accounting_tax_codes           -- rate, input/output, VAT201 box
accounting_journals            -- header: type, status, reference, approval
accounting_journal_lines       -- account, debit, credit, tax code
accounting_postings            -- the ledger: immutable, append-only
accounting_opening_balances
accounting_reconciliations     -- header, per bank account per period
accounting_reconciliation_items
accounting_afs_mappings        -- account → statement/section/line/note/cashflow
accounting_customers / accounting_suppliers
accounting_fixed_assets / accounting_asset_movements
accounting_close_checks
accounting_audit_events        -- append-only, supersedes accounting_action_audit
```

Integrity enforced in the database, not only the UI:

- a journal may not post unless `SUM(debit) = SUM(credit)` — a deferred
  constraint or posting RPC, so it cannot be bypassed by a direct write
- postings are insert-only; corrections are reversals or adjusting journals
- a locked period rejects new postings
- accounts with postings cannot be deleted, only deactivated
- financial-year ranges cannot overlap within an entity

`accounting_transactions` is **kept unchanged** and gains a nullable
`posting_id`, linking a bank row to its ledger effect. No existing column is
dropped and no existing data is migrated destructively.

---

## 5. Route plan

```
/accounting                        Overview
/accounting/bank-statements        (existing pipeline, preserved)
/accounting/statements/[id]        (existing split workspace, preserved)
/accounting/transactions
/accounting/journals
/accounting/chart-of-accounts
/accounting/general-ledger
/accounting/trial-balance
/accounting/reconciliation
/accounting/receivables
/accounting/payables
/accounting/fixed-assets
/accounting/vat
/accounting/financial-statements
/accounting/reports
/accounting/import-export
/accounting/period-close
/accounting/audit-trail
```

`/accounting` keeps working throughout. The existing module/tab state is
replaced by routes incrementally, section by section, so no stage leaves the
workspace half-navigable.

---

## 6. Staged delivery

Each stage is one reviewable PR, production-safe on its own, with tests. This
follows the specification's own staging (§55) and the project's established
one-PR-at-a-time convention.

| Stage | Scope | Depends on |
|---|---|---|
| **1** | Audit and this map | — |
| **2** | Route shell, sidebar IA, rename to *Accounting & Financial Reporting*, Overview with real counts | 1 |
| **3** | Entities, financial years, chart of accounts (schema + CRUD + import/export) | 2 |
| **4** | Postings, journals, balanced-posting RPC, period locking | 3 |
| **5** | General Ledger and Trial Balance derived from postings; bank rows post to the ledger | 4 |
| **6** | Bank reconciliation records; tax codes and VAT periods | 5 |
| **7** | AR, AP, fixed assets, depreciation journals | 4 |
| **8** | Imports and exports (validation, mapping, preview) | 3 |
| **9** | Period close and audit trail | 4 |
| **10** | AFS preparation checklist and opening balances | 5 |
| **11** | AFS mapping, statements, notes, policies, lifecycle | 10 |
| **12** | Performance, mobile, accessibility, hardening | all |

Stages 7 and 8 can run in parallel with 5–6; the rest are sequential because
each depends on the ledger beneath it.

---

## 7. Decisions and risks

### 7.1 Company scoping — needs confirmation before Stage 3

Accounting data is scoped by `workspace_id` today; the specification requires
entity isolation (§40). Moving live accounting data to company scoping is a
one-way data migration, so the intended relationship must be settled first:

- **Recommended:** an entity is a first-class row (`accounting_entities`), a
  workspace holds many entities, and existing accounting data backfills to a
  default entity per workspace. Nothing is lost and multi-entity works properly.
- Alternative: treat workspace *as* the entity. Cheaper, but caps the product at
  one company per workspace, which contradicts §40.

Everything up to and including Stage 2 is unaffected either way.

### 7.2 Risks

- **The 4,423-line component.** Decomposing it while it stays in production is
  the largest source of regression risk. Mitigated by moving section by section
  behind routes, leaving the existing component mounted until each section has
  a working replacement.
- **Reports must stop reading bank rows.** Until Stage 5 lands, the Provisional
  Ledger keeps its current honest label. It must not be renamed "Trial Balance"
  before it derives from postings — that would make a derived view look like an
  accounting control.
- **Existing exports.** `export.ts` consumes `model.ts`. When the ledger becomes
  authoritative, exports must switch source without changing their output
  contract for already-processed runs.
- **VAT is currently an estimate.** Tax codes must not silently reinterpret
  historic `vat_treatment` values; Stage 6 maps them explicitly and records the
  mapping.

### 7.3 Explicitly not claimed

No IFRS or IFRS-for-SMEs compliance is asserted. The reporting framework is
configurable per entity, and statements are structured to support professional
review rather than to certify compliance.
