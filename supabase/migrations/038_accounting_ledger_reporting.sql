-- General Ledger and Trial Balance, derived from postings.
-- Stage 5 of docs/ACCOUNTING_WORKSPACE_PLAN.md.
--
-- Every function here reads public.accounting_postings and nothing else. Not
-- accounting_transactions, not account_category, not a statement's closing
-- balance. Those explain where a figure came from; postings are the books.
--
-- WHY THESE ARE DATABASE FUNCTIONS AND NOT QUERIES IN TYPESCRIPT
--
-- A running balance is a window over rows the caller has not fetched. Computing
-- it in the browser means fetching the whole ledger to display fifty rows of it,
-- which stops working at the first client with a year of transactions. Doing it
-- in SQL means the database returns the page, already carrying its balances.
--
-- SECURITY INVOKER throughout, so row level security still applies and a caller
-- can only read their own workspace's ledger.

-- ---------------------------------------------------------------------------
-- Trial balance: postings aggregated by account.
--
-- `include_adjustments` is the whole Adjusted Trial Balance foundation. The
-- unadjusted and adjusted trial balances are the SAME ledger read with and
-- without year-end journals — not two stored balance sets that can disagree.
-- Adjustments are journals, so they are already in the ledger; excluding them
-- is a filter, not a subtraction.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_trial_balance(
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
  debits numeric(18, 2),
  credits numeric(18, 2),
  closing_balance numeric(18, 2),
  posting_count bigint
)
language sql
security invoker
stable
set search_path = public
as $$
  select
    a.id,
    a.code,
    a.name,
    a.account_type,
    a.normal_balance,
    coalesce(sum(p.debit), 0)::numeric(18, 2),
    coalesce(sum(p.credit), 0)::numeric(18, 2),
    -- Presented against the account's own normal balance, so an expense with
    -- 100 of debits reads as 100 rather than as -100.
    (case a.normal_balance
       when 'debit' then coalesce(sum(p.debit), 0) - coalesce(sum(p.credit), 0)
       else              coalesce(sum(p.credit), 0) - coalesce(sum(p.debit), 0)
     end)::numeric(18, 2),
    count(p.id)
  from public.accounting_accounts a
  left join public.accounting_postings p
    on p.account_id = a.id
   and p.company_id = a.company_id
   and (from_date is null or p.posting_date >= from_date)
   and (to_date is null or p.posting_date <= to_date)
   and (
     include_adjustments
     or not exists (
       select 1 from public.accounting_journals j
       where j.id = p.journal_id and j.journal_type in ('adjustment', 'closing')
     )
   )
  where a.company_id = target_company
  group by a.id, a.code, a.name, a.account_type, a.normal_balance
  -- An account with no postings is not a zero balance; it is an account with no
  -- activity, and a trial balance that lists it says something untrue about the
  -- period. The caller asks for those separately if it wants them.
  having count(p.id) > 0
  order by a.code;
$$;

-- ---------------------------------------------------------------------------
-- General ledger: posting lines, with a running balance per account.
--
-- The running balance is partitioned by account, because a running balance
-- across mixed accounts is not a quantity that means anything. It starts from
-- the account's opening balance so page two continues page one rather than
-- restarting at the first row it happens to contain.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_general_ledger(
  target_company uuid,
  from_date date default null,
  to_date date default null,
  filter_account uuid default null,
  filter_account_type text default null,
  filter_journal_type text default null,
  search_text text default null,
  page_limit integer default 100,
  page_offset integer default 0
)
returns table (
  posting_id uuid,
  posting_date date,
  account_id uuid,
  account_code text,
  account_name text,
  normal_balance text,
  journal_id uuid,
  journal_reference text,
  journal_type text,
  description text,
  source_transaction_id uuid,
  -- The statement run the source transaction belongs to, so a ledger line can
  -- open the bank statement it came from. §28's chain ends at evidence:
  -- trial balance → ledger → journal → transaction → statement. Carried as a
  -- reference; nothing is copied to make the drill-down work.
  source_run_id uuid,
  debit numeric(18, 2),
  credit numeric(18, 2),
  running_balance numeric(18, 2),
  total_rows bigint
)
language sql
security invoker
stable
set search_path = public
as $$
  with matched as (
    select
      p.id, p.posting_date, p.account_id, a.code, a.name, a.normal_balance,
      p.journal_id, j.reference, j.journal_type,
      coalesce(p.description, j.description) as description,
      p.source_transaction_id, t.run_id as source_run_id,
      p.debit, p.credit, p.created_at
    from public.accounting_postings p
    join public.accounting_accounts a on a.id = p.account_id and a.company_id = p.company_id
    join public.accounting_journals j on j.id = p.journal_id
    -- LEFT: a manual journal has no source, and a source that was deleted has
    -- already been nulled. Neither may drop the ledger line from the report.
    left join public.accounting_transactions t on t.id = p.source_transaction_id
    where p.company_id = target_company
      and (from_date is null or p.posting_date >= from_date)
      and (to_date is null or p.posting_date <= to_date)
      and (filter_account is null or p.account_id = filter_account)
      and (filter_account_type is null or a.account_type = filter_account_type)
      and (filter_journal_type is null or j.journal_type = filter_journal_type)
      and (
        search_text is null or search_text = ''
        or a.code ilike '%' || search_text || '%'
        or a.name ilike '%' || search_text || '%'
        or coalesce(j.reference, '') ilike '%' || search_text || '%'
        or coalesce(p.description, j.description, '') ilike '%' || search_text || '%'
      )
  ),
  -- Everything before the window, per account, so the running balance opens
  -- where the account actually stood rather than at zero.
  opening as (
    select
      p.account_id,
      sum(case a.normal_balance when 'debit' then p.debit - p.credit else p.credit - p.debit end) as amount
    from public.accounting_postings p
    join public.accounting_accounts a on a.id = p.account_id and a.company_id = p.company_id
    where p.company_id = target_company
      and from_date is not null
      and p.posting_date < from_date
    group by p.account_id
  ),
  numbered as (
    select
      m.*,
      coalesce(o.amount, 0)
        + sum(case m.normal_balance when 'debit' then m.debit - m.credit else m.credit - m.debit end)
          over (partition by m.account_id order by m.posting_date, m.created_at, m.id
                rows between unbounded preceding and current row) as running,
      count(*) over () as total
    from matched m
    left join opening o on o.account_id = m.account_id
  )
  select
    id, posting_date, account_id, code, name, normal_balance,
    journal_id, reference, journal_type, description, source_transaction_id, source_run_id,
    debit, credit, running::numeric(18, 2), total
  from numbered
  order by posting_date, code, created_at, id
  limit greatest(page_limit, 0)
  offset greatest(page_offset, 0);
$$;

-- ---------------------------------------------------------------------------
-- One account's opening balance at a date. Used by the account drill-down,
-- which has to print an opening figure above its first row.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_account_opening_balance(
  target_company uuid,
  target_account uuid,
  before_date date
)
returns numeric(18, 2)
language sql
security invoker
stable
set search_path = public
as $$
  select coalesce(sum(
    case a.normal_balance when 'debit' then p.debit - p.credit else p.credit - p.debit end
  ), 0)::numeric(18, 2)
  from public.accounting_postings p
  join public.accounting_accounts a on a.id = p.account_id and a.company_id = p.company_id
  where p.company_id = target_company
    and p.account_id = target_account
    and (before_date is null or p.posting_date < before_date);
$$;

-- Supporting index for the ledger's ordering, so a large account does not sort
-- its whole history to return a page.
create index if not exists accounting_postings_ledger_order_idx
  on public.accounting_postings (company_id, posting_date, account_id, created_at);
