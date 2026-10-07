-- Trial balance with brought-forward balances.
--
-- 038's trial balance summed only the postings inside [from_date, to_date], so a
-- report that did not start at the company's first posting showed a balance-sheet
-- account's period MOVEMENT under a "Closing" heading — Cash at 30 April read as
-- April's net receipts, not the cash held.
--
-- Conventional treatment, and nothing invented:
--   * permanent accounts (asset, liability, equity): opening = every posting
--     dated before from_date; closing = opening + the period's movement;
--   * temporary accounts (income, cost of sales, expenses, other income/expense,
--     taxation): the period's activity only;
--   * the temporary-account postings dated before from_date — profit or loss of
--     earlier periods that no closing journal has moved into equity — appear as
--     one equity row, "Unclosed profit/(loss) brought forward", traceable to
--     exactly those postings. DocuCoreX has no automatic year-end close: period
--     close only locks (041). An accountant who posts a closing journal (type
--     'closing') moves that profit into Retained Earnings themselves; the closing
--     journal's postings to the temporary accounts then net them to zero, the row
--     disappears, and Retained Earnings carries it — nothing is counted twice.
--
-- Every set of postings included is a union of whole, balanced journals, so the
-- debit and credit movements agree and the signed closing balances sum to zero.
-- With from_date null nothing is brought forward and the result is exactly what
-- 038 returned. include_adjustments = false still drops adjustment and closing
-- journals inside the period; those before it are final and stay in the opening.
--
-- Covered by tests/sql/37_trial_balance_brought_forward.sql.

drop function if exists public.accounting_trial_balance(uuid, date, date, boolean);

create function public.accounting_trial_balance(
  target_company uuid,
  from_date date default null,
  to_date date default null,
  include_adjustments boolean default true
)
returns table (
  account_id uuid,
  code text,
  name text,
  account_type text,
  normal_balance text,
  opening_balance numeric(18, 2),
  debits numeric(18, 2),
  credits numeric(18, 2),
  closing_balance numeric(18, 2),
  posting_count bigint,
  is_brought_forward boolean
)
language sql
security invoker
stable
set search_path = public
as $$
  with accounts as (
    select a.*, a.account_type in ('asset', 'liability', 'equity') as permanent
    from public.accounting_accounts a
    where a.company_id = target_company
  ),
  postings as (
    select p.account_id, p.posting_date, p.debit, p.credit,
           j.journal_type in ('adjustment', 'closing') as is_adjustment
    from public.accounting_postings p
    join public.accounting_journals j on j.id = p.journal_id and j.company_id = p.company_id
    where p.company_id = target_company
      and (to_date is null or p.posting_date <= to_date)
  ),
  in_period as (
    select account_id, sum(debit) as d, sum(credit) as c, count(*) as n
    from postings
    where (from_date is null or posting_date >= from_date)
      and (include_adjustments or not is_adjustment)
    group by account_id
  ),
  before_period as (
    select account_id, sum(debit) as d, sum(credit) as c, count(*) as n
    from postings
    where from_date is not null and posting_date < from_date
    group by account_id
  ),
  account_rows as (
    select
      a.id, a.code, a.name, a.account_type, a.normal_balance,
      case when a.permanent then
        coalesce(case a.normal_balance when 'debit' then b.d - b.c else b.c - b.d end, 0)
      else 0 end as opening,
      coalesce(p.d, 0) as d,
      coalesce(p.c, 0) as c,
      coalesce(p.n, 0) + case when a.permanent then coalesce(b.n, 0) else 0 end as n
    from accounts a
    left join in_period p on p.account_id = a.id
    left join before_period b on b.account_id = a.id
  ),
  unclosed as (
    select coalesce(sum(b.c - b.d), 0) as amount, coalesce(sum(b.n), 0) as n
    from before_period b
    join accounts a on a.id = b.account_id and not a.permanent
  )
  select * from (
    select
      r.id, r.code, r.name, r.account_type, r.normal_balance,
      r.opening::numeric(18, 2),
      r.d::numeric(18, 2),
      r.c::numeric(18, 2),
      (r.opening + case r.normal_balance when 'debit' then r.d - r.c else r.c - r.d end)::numeric(18, 2),
      r.n::bigint,
      false
    from account_rows r
    -- An account with no postings is absent, not zero (038 §31); one whose only
    -- history is before the period still has a balance and is listed.
    where r.n > 0
    union all
    select
      null::uuid, null::text, 'Unclosed profit/(loss) brought forward', 'equity', 'credit',
      u.amount::numeric(18, 2), 0::numeric(18, 2), 0::numeric(18, 2), u.amount::numeric(18, 2),
      u.n::bigint, true
    from unclosed u
    where u.amount <> 0
  ) rows
  order by rows.code nulls last;
$$;
