-- Tax codes, VAT periods, and VAT derived from the ledger.
-- Stage 6B of docs/ACCOUNTING_WORKSPACE_PLAN.md.
--
-- WHAT THIS REPLACES, AND WHAT IT DOES NOT TOUCH
--
-- VAT in this product has been an ESTIMATE: 15/115 applied to bank-statement
-- amounts (lib/accounting/export.ts), with a five-value `vat_treatment` label on
-- each extracted transaction. That is a reasonable working paper over source
-- data, and its own header says so — "VAT estimated at 15% inclusive … Not tax
-- advice."
--
-- It is not an accounting record, and this migration does not convert it into
-- one. The existing estimate keeps working, untouched, over the same bank rows.
-- What is added here is a SECOND, authoritative path: VAT derived from postings
-- carrying an explicit tax code.
--
-- The two must never be silently merged. A historic transaction labelled
-- 'standard' was labelled by a classifier, not by an accountant, and
-- reinterpreting those labels as tax determinations would turn thousands of
-- guesses into a VAT201 the client would be signing. The mapping below is
-- therefore a SUGGESTION recorded per tax code, applied only when a person
-- assigns the code to a journal line.
--
-- Nothing here computes a VAT amount by multiplying by a rate. VAT is a posting
-- to a control account, like every other accounting figure.

-- ---------------------------------------------------------------------------
-- Tax codes.
-- ---------------------------------------------------------------------------
create table if not exists public.accounting_tax_codes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  code text not null,
  name text not null,

  -- Stated per code rather than assumed to be 15. A rate change is a new code,
  -- not an edit: editing a rate would silently restate every period already
  -- reported under the old one.
  rate numeric(5, 2) not null default 0,

  -- output — VAT charged on supplies made
  -- input  — VAT incurred on supplies received
  -- none   — no VAT arises (zero-rated, exempt, non-supply)
  --
  -- Direction is not derivable from the rate: zero-rated output and exempt
  -- supplies both carry 0% and belong in different boxes of a return.
  direction text not null check (direction in ('output', 'input', 'none')),

  -- Where the VAT element is posted. VAT is a posting, not an arithmetic
  -- adjustment, so a code without a control account cannot produce a VAT
  -- figure — and the report says so rather than reporting nil.
  control_account_id uuid,

  -- Capital goods are disclosed separately on a South African VAT201.
  is_capital boolean not null default false,

  -- The VAT201 field this code feeds. Free text: box numbering is a SARS form
  -- detail that changes independently of this schema, and hard-coding it as an
  -- enum would make a form revision a migration.
  vat201_box text,

  -- Which legacy `vat_treatment` label this code is the natural successor to.
  -- A SUGGESTION for the review UI — never applied automatically. See the
  -- header: those labels were produced by a classifier, not by an accountant.
  suggested_for_treatment text
    check (suggested_for_treatment is null or suggested_for_treatment in
      ('standard', 'zero_rated', 'exempt', 'out_of_scope', 'review')),

  is_active boolean not null default true,
  is_system boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint accounting_tax_codes_rate_sane check (rate >= 0 and rate <= 100),
  -- A code that arises no VAT may not carry a rate, and one that does must have
  -- somewhere to post it.
  constraint accounting_tax_codes_none_has_no_rate
    check (direction <> 'none' or rate = 0),

  constraint accounting_tax_codes_control_same_entity
    foreign key (control_account_id, company_id)
    references public.accounting_accounts (id, company_id)
    on delete restrict
);

create unique index if not exists accounting_tax_codes_code_per_company
  on public.accounting_tax_codes (company_id, lower(trim(code)));

create index if not exists accounting_tax_codes_company_idx
  on public.accounting_tax_codes (company_id, is_active);

-- ---------------------------------------------------------------------------
-- VAT periods.
--
-- Separate from accounting_periods: a South African VAT period is usually two
-- months and does not align with a month-end close, so one cannot stand in for
-- the other. Absence of a row means open, for the same reason as accounting
-- periods — closing is an act.
-- ---------------------------------------------------------------------------
create table if not exists public.accounting_vat_periods (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  period_start date not null,
  period_end date not null,

  -- submitted — a return has been filed for this period
  -- locked    — no further VAT-bearing postings may be made into it
  status text not null check (status in ('submitted', 'locked')),

  -- What was declared, so a later ledger change is visible as a difference
  -- against the return rather than quietly rewriting it.
  declared_output_vat numeric(18, 2),
  declared_input_vat numeric(18, 2),

  note text,
  submitted_by uuid references auth.users(id) on delete set null,
  submitted_at timestamptz not null default now(),

  constraint accounting_vat_periods_ordered check (period_start <= period_end)
);

alter table public.accounting_vat_periods
  drop constraint if exists accounting_vat_periods_no_overlap;
alter table public.accounting_vat_periods
  add constraint accounting_vat_periods_no_overlap
  exclude using gist (
    company_id with =,
    daterange(period_start, period_end, '[]') with &&
  );

-- ---------------------------------------------------------------------------
-- Tax code on journal lines and postings.
--
-- The existing `vat_treatment` text column stays exactly where it is. It
-- records what the classifier said; this records what the accountant decided.
-- Keeping both means a later question — "was this a determination or a guess?"
-- — is answerable, which it would not be if one overwrote the other.
-- ---------------------------------------------------------------------------
alter table public.accounting_journal_lines
  add column if not exists tax_code_id uuid references public.accounting_tax_codes(id) on delete restrict;

alter table public.accounting_postings
  add column if not exists tax_code_id uuid references public.accounting_tax_codes(id) on delete restrict;

create index if not exists accounting_postings_tax_code_idx
  on public.accounting_postings (company_id, tax_code_id, posting_date);

-- The posting gate carries the tax code through, alongside the source link.
-- Everything else about this function is unchanged from 037.
create or replace function public.accounting_post_journal(target_journal uuid)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  journal public.accounting_journals%rowtype;
  total_debit numeric(18, 2);
  total_credit numeric(18, 2);
  line_count integer;
  blocking_period text;
  blocking_vat_period text;
begin
  select * into journal from public.accounting_journals
  where id = target_journal
  for update;

  if not found then
    raise exception 'journal % not found', target_journal using errcode = 'no_data_found';
  end if;

  if journal.status = 'posted' then
    raise exception 'journal is already posted' using errcode = 'restrict_violation';
  end if;
  if journal.status = 'reversed' then
    raise exception 'a reversed journal cannot be posted again' using errcode = 'restrict_violation';
  end if;

  select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
    into total_debit, total_credit, line_count
  from public.accounting_journal_lines
  where journal_id = target_journal;

  if line_count = 0 then
    raise exception 'a journal with no lines cannot be posted' using errcode = 'restrict_violation';
  end if;

  if total_debit <> total_credit then
    raise exception
      'journal does not balance: debits %, credits %, difference %',
      total_debit, total_credit, (total_debit - total_credit)
      using errcode = 'restrict_violation';
  end if;

  if total_debit = 0 then
    raise exception 'a journal of zero cannot be posted' using errcode = 'restrict_violation';
  end if;

  select status into blocking_period
  from public.accounting_periods
  where company_id = journal.company_id
    and journal.journal_date between period_start and period_end
  limit 1;

  if blocking_period is not null then
    raise exception
      'the period containing % is %; reopen it or post to an open period',
      journal.journal_date, blocking_period
      using errcode = 'restrict_violation';
  end if;

  -- A locked VAT period refuses only VAT-BEARING journals. A journal with no
  -- tax code changes no VAT figure, and blocking it would stop ordinary
  -- bookkeeping in a period whose return happens to be filed.
  select v.status into blocking_vat_period
  from public.accounting_vat_periods v
  where v.company_id = journal.company_id
    and v.status = 'locked'
    and journal.journal_date between v.period_start and v.period_end
    and exists (
      select 1 from public.accounting_journal_lines l
      where l.journal_id = target_journal and l.tax_code_id is not null
    )
  limit 1;

  if blocking_vat_period is not null then
    raise exception
      'the VAT period containing % is locked; a VAT-bearing journal cannot be posted into a filed period',
      journal.journal_date
      using errcode = 'restrict_violation';
  end if;

  perform set_config('docucorex.ledger_gate', 'open', true);

  insert into public.accounting_postings (
    company_id, workspace_id, journal_id, journal_line_id, account_id,
    posting_date, debit, credit, description, vat_treatment, created_by,
    source_transaction_id, tax_code_id
  )
  select
    line.company_id, line.workspace_id, line.journal_id, line.id, line.account_id,
    journal.journal_date, line.debit, line.credit, line.description, line.vat_treatment, auth.uid(),
    line.source_transaction_id, line.tax_code_id
  from public.accounting_journal_lines line
  where line.journal_id = target_journal
  order by line.line_number;

  perform set_config('docucorex.ledger_gate', '', true);

  update public.accounting_journals
  set status = 'posted', posted_at = now(), posted_by = auth.uid(), updated_at = now()
  where id = target_journal;

  return target_journal;
end;
$$;

-- ---------------------------------------------------------------------------
-- VAT summary, derived from postings.
--
-- The VAT figure is the amount POSTED to the code's control account. It is not
-- computed by multiplying anything by a rate — a rate is what the accountant
-- used to work out the entry, not a licence for the report to re-derive it. If
-- the entry was wrong, the report must show what was posted, not a corrected
-- version of it.
--
-- `net_amount` is the taxable value: postings under the same code that did NOT
-- go to the control account.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_vat_summary(
  target_company uuid,
  from_date date default null,
  to_date date default null
)
returns table (
  tax_code_id uuid,
  code text,
  name text,
  direction text,
  rate numeric(5, 2),
  is_capital boolean,
  vat201_box text,
  control_account_mapped boolean,
  net_amount numeric(18, 2),
  vat_amount numeric(18, 2),
  posting_count bigint
)
language sql
security invoker
stable
set search_path = public
as $$
  select
    tc.id,
    tc.code,
    tc.name,
    tc.direction,
    tc.rate,
    tc.is_capital,
    tc.vat201_box,
    tc.control_account_id is not null,
    coalesce(sum(
      case when tc.control_account_id is null or p.account_id <> tc.control_account_id
           then abs(p.debit - p.credit) else 0 end
    ), 0)::numeric(18, 2),
    coalesce(sum(
      case when tc.control_account_id is not null and p.account_id = tc.control_account_id
           then abs(p.debit - p.credit) else 0 end
    ), 0)::numeric(18, 2),
    count(p.id)
  from public.accounting_tax_codes tc
  left join public.accounting_postings p
    on p.tax_code_id = tc.id
   and p.company_id = tc.company_id
   and (from_date is null or p.posting_date >= from_date)
   and (to_date is null or p.posting_date <= to_date)
  where tc.company_id = target_company
  group by tc.id, tc.code, tc.name, tc.direction, tc.rate, tc.is_capital, tc.vat201_box, tc.control_account_id
  -- A code with no postings in the period is not a nil return line; it is a code
  -- that was not used. Same rule as the trial balance.
  having count(p.id) > 0
  order by tc.direction, tc.code;
$$;

-- ---------------------------------------------------------------------------
-- VAT register: every VAT-bearing posting, for the working paper.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_vat_register(
  target_company uuid,
  from_date date default null,
  to_date date default null,
  page_limit integer default 500,
  page_offset integer default 0
)
returns table (
  posting_id uuid,
  posting_date date,
  code text,
  direction text,
  account_code text,
  account_name text,
  description text,
  journal_reference text,
  source_transaction_id uuid,
  amount numeric(18, 2),
  is_control_leg boolean,
  total_rows bigint
)
language sql
security invoker
stable
set search_path = public
as $$
  with matched as (
    select
      p.id, p.posting_date, tc.code, tc.direction,
      a.code as account_code, a.name as account_name,
      coalesce(p.description, j.description) as description,
      j.reference, p.source_transaction_id,
      (p.debit - p.credit) as amount,
      (tc.control_account_id is not null and p.account_id = tc.control_account_id) as is_control_leg,
      p.created_at
    from public.accounting_postings p
    join public.accounting_tax_codes tc on tc.id = p.tax_code_id
    join public.accounting_accounts a on a.id = p.account_id and a.company_id = p.company_id
    join public.accounting_journals j on j.id = p.journal_id
    where p.company_id = target_company
      and (from_date is null or p.posting_date >= from_date)
      and (to_date is null or p.posting_date <= to_date)
  )
  select
    id, posting_date, code, direction, account_code, account_name,
    description, reference, source_transaction_id,
    amount::numeric(18, 2), is_control_leg,
    count(*) over ()
  from matched
  order by posting_date, code, created_at, id
  limit greatest(page_limit, 0)
  offset greatest(page_offset, 0);
$$;

-- ---------------------------------------------------------------------------
-- Seed the South African tax codes, per entity.
--
-- Rates and directions are stated. Control accounts are resolved from the
-- entity's own chart by code, and left NULL when the account is absent — a null
-- control account is reported honestly rather than guessed at.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_seed_tax_codes(target_company uuid, target_workspace uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  vat_input uuid;
  vat_output uuid;
begin
  select id into vat_input from public.accounting_accounts
   where company_id = target_company and code = '1200' limit 1;
  select id into vat_output from public.accounting_accounts
   where company_id = target_company and code = '2200' limit 1;

  insert into public.accounting_tax_codes
    (company_id, workspace_id, code, name, rate, direction, control_account_id,
     is_capital, vat201_box, suggested_for_treatment, is_system)
  values
    (target_company, target_workspace, 'STD-OUT', 'Standard-rated supplies made',      15, 'output', vat_output, false, '1',     'standard',     true),
    (target_company, target_workspace, 'STD-IN',  'Standard-rated supplies received',  15, 'input',  vat_input,  false, '14',    'standard',     true),
    (target_company, target_workspace, 'CAP-IN',  'Capital goods received',            15, 'input',  vat_input,  true,  '15',    null,           true),
    (target_company, target_workspace, 'IMP-SVC', 'Imported services',                 15, 'input',  vat_input,  false, '12',    null,           true),
    (target_company, target_workspace, 'ZER-OUT', 'Zero-rated supplies made',           0, 'none',   null,       false, '2',     'zero_rated',   true),
    (target_company, target_workspace, 'EXE',     'Exempt supplies',                    0, 'none',   null,       false, '3',     'exempt',       true),
    (target_company, target_workspace, 'NON',     'Non-supply / outside the scope',     0, 'none',   null,       false, null,    'out_of_scope', true)
  on conflict do nothing;
end;
$$;

do $$
declare company_row record;
begin
  for company_row in select id, workspace_id from public.companies where not is_archived loop
    if not exists (select 1 from public.accounting_tax_codes where company_id = company_row.id) then
      perform public.accounting_seed_tax_codes(company_row.id, company_row.workspace_id);
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- A NEW ENTITY GETS ITS ACCOUNTING SET UP TOO.
--
-- A gap found while testing this migration: 035 and the block above seed only
-- the companies that existed WHEN THE MIGRATION RAN. A company created
-- afterwards — through Settings, the way a firm adds its next client — got no
-- chart of accounts and no tax codes, and every accounting screen for it was
-- empty with nothing explaining why.
--
-- Seeding on insert rather than in application code, because a company can be
-- created by more than one path and each would have to remember. AFTER INSERT
-- so the row exists for the foreign keys; the seed functions are idempotent, so
-- a caller that also seeds explicitly does no harm.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_seed_new_company()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_archived then
    return new;
  end if;

  insert into public.accounting_entity_settings (company_id, workspace_id)
  values (new.id, new.workspace_id)
  on conflict (company_id) do nothing;

  if not exists (select 1 from public.accounting_accounts where company_id = new.id) then
    perform public.accounting_seed_chart_of_accounts(new.id, new.workspace_id);
  end if;

  if not exists (select 1 from public.accounting_tax_codes where company_id = new.id) then
    perform public.accounting_seed_tax_codes(new.id, new.workspace_id);
  end if;

  return new;
end;
$$;

drop trigger if exists accounting_seed_company on public.companies;
create trigger accounting_seed_company
  after insert on public.companies
  for each row execute function public.accounting_seed_new_company();

-- ---------------------------------------------------------------------------
-- Row level security.
-- ---------------------------------------------------------------------------
alter table public.accounting_tax_codes enable row level security;
alter table public.accounting_vat_periods enable row level security;

drop policy if exists "Users can access accounting tax codes" on public.accounting_tax_codes;
create policy "Users can access accounting tax codes" on public.accounting_tax_codes
  for all using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()))
  with check (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));

drop policy if exists "Users can access accounting vat periods" on public.accounting_vat_periods;
create policy "Users can access accounting vat periods" on public.accounting_vat_periods
  for all using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()))
  with check (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));
