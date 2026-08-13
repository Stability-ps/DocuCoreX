-- Fixed assets: a register, depreciation, and disposal.
-- Stage 7A of docs/ACCOUNTING_WORKSPACE_PLAN.md.
--
-- COST IS STATED, NOT DERIVED. Unlike every control total elsewhere in this
-- schema, an asset's cost is recorded directly on its register row rather than
-- summed from postings — it is descriptive fact an accountant enters (what was
-- paid, and when), the same kind of stated data as a tax code's rate or a
-- reconciliation's statement balance. How that cost was actually paid for
-- (an existing bank posting, an accounts-payable bill not yet built) is a
-- separate question this migration does not answer; nothing here creates an
-- acquisition posting.
--
-- ACCUMULATED DEPRECIATION IS DERIVED, the same way every other balance in
-- this ledger is: from postings, never stored. accounting_asset_movements is
-- a thin link — which journal did what to which asset — not a second ledger
-- that could disagree with the first.
--
-- ONE JOURNAL, ONE ASSET. A depreciation or disposal journal must post to its
-- asset's accumulated-depreciation account and NO OTHER asset's movement may
-- share that journal. accounting_fixed_asset_register attributes every posting
-- on a linked journal to the one asset that journal's movement names; combining
-- two assets onto one journal would make the register double-count. This is
-- enforced by convention in the server layer that creates these journals, not
-- by a database constraint — recorded here so it is not rediscovered the hard
-- way.

-- ---------------------------------------------------------------------------
-- Starter accounts. Existing companies did not gain these when their chart
-- was first seeded (034/035 predate this feature), so they are backfilled
-- below, the same way 040 backfilled tax codes onto companies that already
-- had a chart. Not system accounts: nothing here requires code '1500' or
-- '5150' to exist under those exact names — the register asks which account,
-- it does not assume one.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_seed_chart_of_accounts(target_company uuid, target_workspace uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.accounting_accounts
    (company_id, workspace_id, code, name, account_type, normal_balance, is_system, vat_default)
  values
    (target_company, target_workspace, '1000', 'Cash at Bank',                  'asset',     'debit',  true,  'out_of_scope'),
    (target_company, target_workspace, '1200', 'VAT Control',                   'asset',     'debit',  true,  'out_of_scope'),
    (target_company, target_workspace, '1300', 'Loan Receivable',               'asset',     'debit',  false, 'out_of_scope'),
    (target_company, target_workspace, '1500', 'Fixed Assets at Cost',          'asset',     'debit',  false, 'standard'),
    (target_company, target_workspace, '1550', 'Accumulated Depreciation',      'asset',     'credit', false, 'out_of_scope'),
    (target_company, target_workspace, '2000', 'Loans',                         'liability', 'credit', false, 'out_of_scope'),
    (target_company, target_workspace, '2100', 'SARS / Tax Liability',          'liability', 'credit', true,  'out_of_scope'),
    (target_company, target_workspace, '2200', 'VAT Payable',                   'liability', 'credit', true,  'out_of_scope'),
    (target_company, target_workspace, '2300', 'Director Loan / Drawings',      'liability', 'credit', false, 'out_of_scope'),
    (target_company, target_workspace, '2900', 'Suspense / Review Required',    'liability', 'credit', true,  'review'),
    (target_company, target_workspace, '2910', 'Refund Suspense',               'liability', 'credit', true,  'review'),
    (target_company, target_workspace, '2920', 'Inter-account Transfers',       'liability', 'credit', true,  'out_of_scope'),
    (target_company, target_workspace, '3000', 'Capital',                       'equity',    'credit', false, 'out_of_scope'),
    (target_company, target_workspace, '3100', 'Retained Earnings',             'equity',    'credit', true,  'out_of_scope'),
    (target_company, target_workspace, '4000', 'Sales / Revenue',               'income',    'credit', false, 'standard'),
    (target_company, target_workspace, '4100', 'Interest Received',             'income',    'credit', false, 'exempt'),
    (target_company, target_workspace, '4200', 'Revenue Review',                'income',    'credit', false, 'review'),
    (target_company, target_workspace, '4300', 'Cash Deposits (Review)',        'income',    'credit', false, 'review'),
    (target_company, target_workspace, '4900', 'Gain/Loss on Disposal of Assets','other_income','credit', false, 'out_of_scope'),
    (target_company, target_workspace, '5000', 'Bank Charges',                  'expense',   'debit',  false, 'standard'),
    (target_company, target_workspace, '5100', 'Motor Vehicle Expenses',        'expense',   'debit',  false, 'standard'),
    (target_company, target_workspace, '5150', 'Depreciation',                  'expense',   'debit',  false, 'out_of_scope'),
    (target_company, target_workspace, '5200', 'Communication',                 'expense',   'debit',  false, 'standard'),
    (target_company, target_workspace, '5300', 'Insurance',                     'expense',   'debit',  false, 'exempt'),
    (target_company, target_workspace, '5400', 'Payroll / Salaries',            'expense',   'debit',  false, 'out_of_scope'),
    (target_company, target_workspace, '5500', 'Software Subscriptions',        'expense',   'debit',  false, 'standard'),
    (target_company, target_workspace, '5600', 'Courier / Delivery',            'expense',   'debit',  false, 'standard'),
    (target_company, target_workspace, '5650', 'Supplier Payments',             'expense',   'debit',  false, 'review'),
    (target_company, target_workspace, '5700', 'Travel / Meals / Entertainment','expense',   'debit',  false, 'standard'),
    (target_company, target_workspace, '5800', 'Levies',                        'expense',   'debit',  false, 'standard'),
    (target_company, target_workspace, '5900', 'Finance Costs',                 'expense',   'debit',  false, 'exempt'),
    (target_company, target_workspace, '5950', 'Other Operating Expenses',      'expense',   'debit',  false, 'review')
  on conflict do nothing;
end;
$$;

do $$
declare company_row record;
begin
  for company_row in select id, workspace_id from public.companies where not is_archived loop
    perform public.accounting_seed_chart_of_accounts(company_row.id, company_row.workspace_id);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- A disposal is its own journal type, the same reservation 036 already made
-- for depreciation.
-- ---------------------------------------------------------------------------
alter table public.accounting_journals
  drop constraint if exists accounting_journals_journal_type_check;
alter table public.accounting_journals
  add constraint accounting_journals_journal_type_check
  check (journal_type in (
    'general', 'adjustment', 'opening_balance', 'depreciation', 'disposal',
    'accrual', 'prepayment', 'tax', 'closing', 'reversal'
  ));

-- ---------------------------------------------------------------------------
-- The register.
-- ---------------------------------------------------------------------------
create table if not exists public.accounting_fixed_assets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  description text not null,

  -- Where the asset's cost sits, and where its accumulated depreciation sits.
  -- The two must differ, and both must belong to this entity's own chart.
  asset_account_id uuid not null references public.accounting_accounts(id) on delete restrict,
  accumulated_depreciation_account_id uuid not null references public.accounting_accounts(id) on delete restrict,

  acquisition_date date not null,
  cost numeric(18, 2) not null,
  residual_value numeric(18, 2) not null default 0,

  depreciation_method text not null default 'none'
    check (depreciation_method in ('straight_line', 'reducing_balance', 'none')),
  useful_life_months integer,
  depreciation_rate_percent numeric(5, 2),

  disposal_date date,
  disposal_proceeds numeric(18, 2),

  is_active boolean not null default true,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint accounting_fixed_assets_cost_non_negative check (cost >= 0),
  constraint accounting_fixed_assets_residual_sane check (residual_value >= 0 and residual_value <= cost),
  constraint accounting_fixed_assets_distinct_accounts check (asset_account_id <> accumulated_depreciation_account_id),

  -- Each method carries exactly the input it needs and no other: a
  -- reducing-balance rate on a straight-line asset would sit there unused and
  -- eventually get read by mistake.
  constraint accounting_fixed_assets_method_has_its_input check (
    (depreciation_method = 'straight_line' and useful_life_months is not null and useful_life_months > 0
       and depreciation_rate_percent is null)
    or (depreciation_method = 'reducing_balance' and depreciation_rate_percent is not null
       and depreciation_rate_percent > 0 and depreciation_rate_percent <= 100 and useful_life_months is null)
    or (depreciation_method = 'none' and useful_life_months is null and depreciation_rate_percent is null)
  ),

  constraint accounting_fixed_assets_disposal_after_acquisition
    check (disposal_date is null or disposal_date >= acquisition_date),
  -- Null means not disposed; zero means disposed for nothing (scrapped). The
  -- two must not be conflated, so disposal always states a proceeds figure.
  constraint accounting_fixed_assets_disposal_has_proceeds
    check ((disposal_date is null) = (disposal_proceeds is null)),

  constraint accounting_fixed_assets_asset_account_same_entity
    foreign key (asset_account_id, company_id)
    references public.accounting_accounts (id, company_id)
    on delete restrict,
  constraint accounting_fixed_assets_accum_account_same_entity
    foreign key (accumulated_depreciation_account_id, company_id)
    references public.accounting_accounts (id, company_id)
    on delete restrict
);

create index if not exists accounting_fixed_assets_company_idx
  on public.accounting_fixed_assets (company_id, is_active);

-- ---------------------------------------------------------------------------
-- Movements: which journal did what to which asset. No amount, no date beyond
-- what pins down the month a depreciation charge belongs to — the figures
-- live on the journal it points to.
-- ---------------------------------------------------------------------------
create table if not exists public.accounting_asset_movements (
  id uuid primary key default gen_random_uuid(),
  fixed_asset_id uuid not null references public.accounting_fixed_assets(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  journal_id uuid not null references public.accounting_journals(id) on delete restrict,
  movement_type text not null check (movement_type in ('depreciation', 'disposal')),
  -- Duplicated from the journal at creation, the same way accounting_postings
  -- duplicates journal_date — a denormalised date, not a monetary figure, kept
  -- for the constraint below and for querying without a join.
  movement_date date not null,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists accounting_asset_movements_asset_idx
  on public.accounting_asset_movements (fixed_asset_id, movement_date);

create index if not exists accounting_asset_movements_journal_idx
  on public.accounting_asset_movements (journal_id);

-- An asset cannot be depreciated twice in one calendar month. Enforced here,
-- not only in the batch-preview UI, for the same reason accounting_postings is
-- append-only by trigger rather than by convention: a control that only the
-- UI upholds is not a control.
-- date_trunc(text, date) resolves through the timestamptz overload, which is
-- only STABLE (it depends on the session's time zone) — not eligible for an
-- index expression. Casting to timestamp first selects the IMMUTABLE overload;
-- a date has no time-of-day component to be timezone-sensitive about anyway.
create unique index if not exists accounting_asset_movements_one_depreciation_per_month
  on public.accounting_asset_movements (fixed_asset_id, date_trunc('month', movement_date::timestamp))
  where movement_type = 'depreciation';

-- ---------------------------------------------------------------------------
-- The register, with accumulated depreciation and net book value derived from
-- postings — never stored, for the same reason a trial balance is never
-- stored. `as_at` defaults to today; passing an earlier date reports the
-- register as it stood then, which is what a depreciation batch needs to find
-- last month's closing position before charging this month's.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_fixed_asset_register(
  target_company uuid,
  as_at date default current_date
)
returns table (
  asset_id uuid,
  description text,
  asset_account_id uuid,
  asset_account_code text,
  asset_account_name text,
  accumulated_depreciation_account_id uuid,
  acquisition_date date,
  cost numeric(18, 2),
  residual_value numeric(18, 2),
  depreciation_method text,
  useful_life_months integer,
  depreciation_rate_percent numeric(5, 2),
  accumulated_depreciation numeric(18, 2),
  net_book_value numeric(18, 2),
  is_active boolean,
  disposal_date date,
  disposal_proceeds numeric(18, 2)
)
language sql
security invoker
stable
set search_path = public
as $$
  select
    fa.id, fa.description, fa.asset_account_id, aa.code, aa.name,
    fa.accumulated_depreciation_account_id, fa.acquisition_date, fa.cost, fa.residual_value,
    fa.depreciation_method, fa.useful_life_months, fa.depreciation_rate_percent,
    coalesce(dep.accumulated, 0)::numeric(18, 2),
    (fa.cost - coalesce(dep.accumulated, 0))::numeric(18, 2),
    fa.is_active, fa.disposal_date, fa.disposal_proceeds
  from public.accounting_fixed_assets fa
  join public.accounting_accounts aa on aa.id = fa.asset_account_id
  left join lateral (
    select sum(p.credit - p.debit) as accumulated
    from public.accounting_asset_movements m
    join public.accounting_postings p
      on p.journal_id = m.journal_id
     and p.account_id = fa.accumulated_depreciation_account_id
    where m.fixed_asset_id = fa.id
      and p.posting_date <= as_at
  ) dep on true
  where fa.company_id = target_company
  order by aa.code, fa.acquisition_date;
$$;

-- ---------------------------------------------------------------------------
-- Row level security.
-- ---------------------------------------------------------------------------
alter table public.accounting_fixed_assets enable row level security;
alter table public.accounting_asset_movements enable row level security;

drop policy if exists "Users can access fixed assets" on public.accounting_fixed_assets;
create policy "Users can access fixed assets" on public.accounting_fixed_assets
  for all using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()))
  with check (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));

drop policy if exists "Users can access asset movements" on public.accounting_asset_movements;
create policy "Users can access asset movements" on public.accounting_asset_movements
  for all using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()))
  with check (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));
