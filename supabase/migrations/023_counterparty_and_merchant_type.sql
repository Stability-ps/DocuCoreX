-- Identity, relationship and reasoning, stored apart from the treatment.
--
-- The old model kept one answer per transaction: a category and a VAT
-- treatment, with nothing recorded about how either was reached. That made two
-- production defects invisible until a statement exposed them — a fuel brand
-- authorising a VAT claim, and a one-character learned key claiming 425 rows —
-- because "why was this classified?" had no answer beyond "a string matched".
--
-- These columns store the reasoning alongside the result:
--
--   counterparty_key / display   who the transaction was with, extracted from
--                                the bank's wording rather than guessed. The key
--                                is what lets 615 rows collapse into ~99
--                                counterparty decisions.
--   counterparty_truncated       the bank cut the name short (Standard Bank
--                                prints a 14-character payee field), so the name
--                                is a prefix and must not be treated as whole.
--   merchant_type                what KIND of entity this is — fuel_retailer,
--                                insurer, revenue_authority. Deliberately not a
--                                category: knowing Shell is a fuel retailer does
--                                not establish what was bought.
--   merchant_type_source         kb | ai | manual | unknown.
--   relationship / strength      supplier, customer, or unknown, and how well
--                                the statement proves it. Never a treatment.
--   evidence_used                the facts the decision rested on, so a reviewer
--                                can check the reasoning instead of redoing it.
--   treatment_alternatives       what else the evidence allowed. A row booked to
--                                Motor Vehicle Expenses because a forecourt
--                                charge looked like refuelling should say that
--                                Travel and Inventory were also possible.
--
-- Every column is nullable with no default and no backfill. Rows written before
-- this migration carry NULL, which is honest: we do not know the counterparty
-- type of a transaction classified under the old model, and inventing one would
-- be the same error the columns exist to prevent.
--
-- Additive and safe in both directions. The worker lists all nine in
-- OPTIONAL_TRANSACTION_COLUMNS, so against a database without them it drops
-- them and retries — the same graceful degradation that carried migrations 021
-- and 022 through production. Older workers never write them.

alter table if exists public.accounting_transactions
  add column if not exists counterparty_key       text,
  add column if not exists counterparty_display   text,
  add column if not exists counterparty_truncated boolean,
  add column if not exists merchant_type          text,
  add column if not exists merchant_type_source   text,
  add column if not exists relationship           text,
  add column if not exists relationship_strength  text,
  add column if not exists evidence_used          jsonb,
  add column if not exists treatment_alternatives jsonb;

-- Grouping a workspace's transactions by counterparty is the central read of
-- the new architecture: it is how one approved decision reaches every matching
-- row instead of a reviewer classifying the same payee 115 times.
create index if not exists accounting_transactions_counterparty_idx
  on public.accounting_transactions (workspace_id, counterparty_key);

comment on column public.accounting_transactions.merchant_type is
  'What KIND of entity the counterparty is (fuel_retailer, insurer, revenue_authority). Never a category: identity establishes who was paid, not what was bought, and not whether input VAT may be claimed.';

comment on column public.accounting_transactions.relationship is
  'supplier | customer | unknown, inferred from recurrence and direction. A relationship is evidence, never an accounting treatment: a supplier payment may be stock, an asset or a loan repayment.';

comment on column public.accounting_transactions.evidence_used is
  'The facts behind the classification, so "why was this classified?" is answerable from the row itself.';

notify pgrst, 'reload schema';
