-- Where a run's closing balance came from.
--
-- Not every statement prints the words "Closing Balance". Standard Bank does
-- not, so the column stayed NULL — and a NULL closing balance was read
-- downstream as ZERO, producing a reconciliation difference of the entire
-- opening balance and putting a correctly reconciled statement into a permanent
-- "needs fresh extraction" state.
--
-- A derived closing balance is only as trustworthy as the evidence behind it,
-- so the evidence is recorded alongside the number rather than left implicit:
--
--   explicit                       the statement printed "Closing Balance"
--   last_running_balance_verified  the final printed running balance, ACCEPTED
--                                  ONLY because the bank's own declared turnover
--                                  (opening + deposits - payments) agrees with
--                                  it to the cent
--   unverified                     those two figures disagreed; closing is NULL
--   unavailable                    not enough evidence to derive one
--
-- Nullable. Runs written before this migration carry no source, which is
-- honest: we do not know how their closing balance was obtained.
alter table if exists public.accounting_statement_runs
  add column if not exists closing_balance_source text;

comment on column public.accounting_statement_runs.closing_balance_source is
  'Evidence behind closing_balance: explicit | last_running_balance_verified | unverified | unavailable. A derived closing balance is never accepted without corroboration from the statement''s own declared totals.';

notify pgrst, 'reload schema';
