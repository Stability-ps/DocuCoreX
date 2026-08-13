-- The accounting ledger: journals, journal lines, postings, and periods.
-- Stage 4 of docs/ACCOUNTING_WORKSPACE_PLAN.md.
--
-- This is the migration the whole programme exists for. Until now the product
-- had no ledger: general ledger and trial balance were derived in memory at
-- export time by emitting one debit and one equal credit per bank row, so the
-- trial balance balanced BY CONSTRUCTION and could not fail — the opposite of
-- an accounting control.
--
-- Three rules are enforced here, in the database, because each of them is
-- worthless if it can be stepped around:
--
--   1. A journal may not post unless its debits equal its credits.
--   2. A posting, once made, is never altered or removed.
--   3. A locked period accepts no postings.
--
-- WHY TRIGGERS AND NOT ONLY POLICIES: this codebase uses
-- createSupabaseServiceRoleClient() in API routes and workers, and the service
-- role BYPASSES row level security entirely. An append-only rule expressed as
-- "no update policy" would therefore hold for users and evaporate for exactly
-- the code paths that write the most. Triggers apply to every writer, including
-- the service role and the SQL console.
--
-- Nothing here is destructive. No existing table is altered or dropped.

-- ---------------------------------------------------------------------------
-- Periods.
--
-- ABSENCE OF A ROW MEANS OPEN. Only a period that has been closed or locked
-- gets a row, so nothing has to pre-generate twelve months per entity per year,
-- and a company that has never closed anything is not carrying a table of empty
-- state. Closing is an act; being open is the default.
-- ---------------------------------------------------------------------------
create table if not exists public.accounting_periods (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  period_start date not null,
  period_end date not null,

  -- soft_closed — ordinary posting refused; a correction may reopen it
  -- locked      — signed off; reopening is a deliberate, audited act
  status text not null check (status in ('soft_closed', 'locked')),

  note text,
  closed_by uuid references auth.users(id) on delete set null,
  closed_at timestamptz not null default now(),

  constraint accounting_periods_ordered check (period_start <= period_end)
);

alter table public.accounting_periods
  drop constraint if exists accounting_periods_no_overlap;
alter table public.accounting_periods
  add constraint accounting_periods_no_overlap
  exclude using gist (
    company_id with =,
    daterange(period_start, period_end, '[]') with &&
  );

-- ---------------------------------------------------------------------------
-- Journals.
-- ---------------------------------------------------------------------------
create table if not exists public.accounting_journals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  journal_type text not null default 'general'
    check (journal_type in (
      'general', 'adjustment', 'opening_balance', 'depreciation',
      'accrual', 'prepayment', 'tax', 'closing', 'reversal'
    )),

  reference text,
  journal_date date not null,
  description text,

  status text not null default 'draft'
    check (status in ('draft', 'pending_review', 'approved', 'posted', 'reversed')),

  -- Set on the REVERSING journal, pointing at what it reverses. A reversal is
  -- itself a journal so that the correction is visible in the ledger rather
  -- than achieved by editing history away.
  reverses_journal_id uuid references public.accounting_journals(id) on delete restrict,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  posted_by uuid references auth.users(id) on delete set null,
  posted_at timestamptz
);

create index if not exists accounting_journals_company_idx
  on public.accounting_journals (company_id, journal_date desc);

create index if not exists accounting_journals_status_idx
  on public.accounting_journals (company_id, status);

-- ---------------------------------------------------------------------------
-- Journal lines.
-- ---------------------------------------------------------------------------
create table if not exists public.accounting_journal_lines (
  id uuid primary key default gen_random_uuid(),
  journal_id uuid not null references public.accounting_journals(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  account_id uuid not null references public.accounting_accounts(id) on delete restrict,
  line_number integer not null default 1,

  debit numeric(18, 2) not null default 0,
  credit numeric(18, 2) not null default 0,

  description text,
  vat_treatment text
    check (vat_treatment is null or vat_treatment in ('standard', 'zero_rated', 'exempt', 'out_of_scope', 'review')),

  created_at timestamptz not null default now(),

  -- Amounts are magnitudes. Direction is which COLUMN carries the figure, so a
  -- negative debit — which is a credit wearing the wrong label — cannot exist.
  constraint accounting_journal_lines_non_negative check (debit >= 0 and credit >= 0),
  -- Exactly one side. A line carrying both is two lines; a line carrying
  -- neither is not a line.
  constraint accounting_journal_lines_one_sided check ((debit > 0) <> (credit > 0))
);

create index if not exists accounting_journal_lines_journal_idx
  on public.accounting_journal_lines (journal_id, line_number);

create index if not exists accounting_journal_lines_account_idx
  on public.accounting_journal_lines (account_id);

-- ---------------------------------------------------------------------------
-- Postings — THE LEDGER.
--
-- Append-only. Every report from Stage 5 onward reads this table and nothing
-- else. A posting records what was posted, from which journal line, to which
-- account, on which date, by whom.
-- ---------------------------------------------------------------------------
create table if not exists public.accounting_postings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  journal_id uuid not null references public.accounting_journals(id) on delete restrict,
  journal_line_id uuid not null references public.accounting_journal_lines(id) on delete restrict,
  account_id uuid not null references public.accounting_accounts(id) on delete restrict,

  posting_date date not null,
  debit numeric(18, 2) not null default 0,
  credit numeric(18, 2) not null default 0,

  description text,
  vat_treatment text,

  -- Where this posting came from, when it came from a bank statement. Nullable
  -- because a manual journal has no source transaction. ON DELETE SET NULL, not
  -- CASCADE: deleting a source document must never destroy ledger history (§43).
  source_transaction_id uuid references public.accounting_transactions(id) on delete set null,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint accounting_postings_non_negative check (debit >= 0 and credit >= 0),
  constraint accounting_postings_one_sided check ((debit > 0) <> (credit > 0))
);

create index if not exists accounting_postings_account_date_idx
  on public.accounting_postings (company_id, account_id, posting_date);

create index if not exists accounting_postings_journal_idx
  on public.accounting_postings (journal_id);

create index if not exists accounting_postings_date_idx
  on public.accounting_postings (company_id, posting_date);

create index if not exists accounting_postings_source_idx
  on public.accounting_postings (source_transaction_id);

-- ---------------------------------------------------------------------------
-- Rule 2: a posting is never altered or removed.
--
-- A trigger rather than an RLS policy, because the service role bypasses RLS
-- and is what the API routes and workers use. Corrections are reversals or
-- adjusting journals — both of which add rows rather than change them.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_postings_are_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'accounting_postings is append-only: a posting cannot be % once made. Reverse the journal or post an adjusting journal instead.',
    lower(tg_op)
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists accounting_postings_no_update on public.accounting_postings;
create trigger accounting_postings_no_update
  before update on public.accounting_postings
  for each row execute function public.accounting_postings_are_append_only();

drop trigger if exists accounting_postings_no_delete on public.accounting_postings;
create trigger accounting_postings_no_delete
  before delete on public.accounting_postings
  for each row execute function public.accounting_postings_are_append_only();

-- A posted journal's lines are equally frozen: editing them after posting would
-- leave the ledger describing something the journal no longer says.
create or replace function public.accounting_journal_lines_frozen_once_posted()
returns trigger
language plpgsql
as $$
declare
  journal_status text;
begin
  select status into journal_status
  from public.accounting_journals
  where id = coalesce(new.journal_id, old.journal_id);

  if journal_status in ('posted', 'reversed') then
    raise exception 'journal lines cannot be changed once the journal is %', journal_status
      using errcode = 'restrict_violation';
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists accounting_journal_lines_guard on public.accounting_journal_lines;
create trigger accounting_journal_lines_guard
  before insert or update or delete on public.accounting_journal_lines
  for each row execute function public.accounting_journal_lines_frozen_once_posted();

-- ---------------------------------------------------------------------------
-- Rules 1 and 3: post a journal only when it balances, into an open period.
--
-- SECURITY INVOKER so row level security still applies — the caller may only
-- post journals in their own workspace, exactly as if they had written the
-- INSERT themselves.
-- ---------------------------------------------------------------------------
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
begin
  select * into journal from public.accounting_journals where id = target_journal;
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

  -- Rule 1. Stated as an equality on the summed magnitudes, which is what
  -- double entry means. numeric(18,2) is exact, so this is not a tolerance
  -- comparison and must not become one — "close enough" is how a ledger drifts.
  if total_debit <> total_credit then
    raise exception
      'journal does not balance: debits %, credits %, difference %',
      total_debit, total_credit, (total_debit - total_credit)
      using errcode = 'restrict_violation';
  end if;

  if total_debit = 0 then
    raise exception 'a journal of zero cannot be posted' using errcode = 'restrict_violation';
  end if;

  -- Rule 3.
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

  insert into public.accounting_postings (
    company_id, workspace_id, journal_id, journal_line_id, account_id,
    posting_date, debit, credit, description, vat_treatment, created_by
  )
  select
    line.company_id, line.workspace_id, line.journal_id, line.id, line.account_id,
    journal.journal_date, line.debit, line.credit, line.description, line.vat_treatment, auth.uid()
  from public.accounting_journal_lines line
  where line.journal_id = target_journal
  order by line.line_number;

  update public.accounting_journals
  set status = 'posted', posted_at = now(), posted_by = auth.uid(), updated_at = now()
  where id = target_journal;

  return target_journal;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reversal.
--
-- A reversal is a new journal with the sides swapped, posted through the same
-- gate as any other. The original is marked reversed and keeps every posting it
-- ever made — the ledger shows what was done and what undid it, rather than
-- showing a tidied history in which the mistake never happened.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_reverse_journal(
  target_journal uuid,
  reversal_date date default null,
  reason text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  journal public.accounting_journals%rowtype;
  reversal_id uuid;
begin
  select * into journal from public.accounting_journals where id = target_journal;
  if not found then
    raise exception 'journal % not found', target_journal using errcode = 'no_data_found';
  end if;
  if journal.status <> 'posted' then
    raise exception 'only a posted journal can be reversed (this one is %)', journal.status
      using errcode = 'restrict_violation';
  end if;

  insert into public.accounting_journals (
    company_id, workspace_id, journal_type, reference, journal_date, description,
    status, reverses_journal_id, created_by
  )
  values (
    journal.company_id, journal.workspace_id, 'reversal',
    coalesce(journal.reference, '') || ' (reversal)',
    coalesce(reversal_date, journal.journal_date),
    coalesce(reason, 'Reversal of ' || coalesce(journal.reference, journal.id::text)),
    'draft', journal.id, auth.uid()
  )
  returning id into reversal_id;

  insert into public.accounting_journal_lines (
    journal_id, company_id, workspace_id, account_id, line_number,
    debit, credit, description, vat_treatment
  )
  select
    reversal_id, line.company_id, line.workspace_id, line.account_id, line.line_number,
    line.credit, line.debit,  -- swapped
    line.description, line.vat_treatment
  from public.accounting_journal_lines line
  where line.journal_id = target_journal;

  perform public.accounting_post_journal(reversal_id);

  update public.accounting_journals
  set status = 'reversed', updated_at = now()
  where id = target_journal;

  return reversal_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security.
-- ---------------------------------------------------------------------------
alter table public.accounting_periods enable row level security;
alter table public.accounting_journals enable row level security;
alter table public.accounting_journal_lines enable row level security;
alter table public.accounting_postings enable row level security;

drop policy if exists "Users can access accounting periods" on public.accounting_periods;
create policy "Users can access accounting periods" on public.accounting_periods
  for all using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()))
  with check (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));

drop policy if exists "Users can access accounting journals" on public.accounting_journals;
create policy "Users can access accounting journals" on public.accounting_journals
  for all using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()))
  with check (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));

drop policy if exists "Users can access accounting journal lines" on public.accounting_journal_lines;
create policy "Users can access accounting journal lines" on public.accounting_journal_lines
  for all using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()))
  with check (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));

-- Postings: read and insert only. The triggers above are what actually make
-- this append-only for every writer; these policies say the same thing for
-- ordinary users, so the intent is legible in the policy list too.
drop policy if exists "Users can read accounting postings" on public.accounting_postings;
create policy "Users can read accounting postings" on public.accounting_postings
  for select using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));

drop policy if exists "Users can insert accounting postings" on public.accounting_postings;
create policy "Users can insert accounting postings" on public.accounting_postings
  for insert with check (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));
