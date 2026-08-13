-- Bank reconciliation: control accounts, reconciliations, and matched items.
-- Stage 6A of docs/ACCOUNTING_WORKSPACE_PLAN.md.
--
-- THE TWO BALANCES ARE DIFFERENT THINGS.
--
-- "Balance per bank statement" is what the bank printed. "Balance per general
-- ledger" is what the books say, derived from accounting_postings. Bank
-- reconciliation exists precisely because they differ, and the product must
-- never present one as the other — a statement's closing balance is evidence,
-- not an accounting balance.
--
-- Nothing here stores either balance. The statement figure already lives on
-- accounting_statement_runs and the ledger figure is derived from postings on
-- demand. Storing a copy would create a third number that could disagree with
-- both, which is the failure this whole programme is built to avoid.
--
-- Nothing here writes to accounting_postings either. A reconciliation that
-- discovers a missing entry creates a JOURNAL, which posts through the gate in
-- migration 037 like everything else.

-- ---------------------------------------------------------------------------
-- Bank account control mapping.
--
--     bank account (as it appears on statements)  →  ledger account (1100 …)
--
-- Reconciliation is meaningless without it: "the ledger balance of this bank
-- account" has no referent until the product is told which account that is.
--
-- The mapping is STATED, never inferred permanently from transaction
-- descriptions. A description is extraction output; deciding a client's control
-- account from it would make the books depend on OCR.
-- ---------------------------------------------------------------------------
create table if not exists public.accounting_bank_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- How the account identifies itself on its statements. Both nullable
  -- because a statement may carry one and not the other, but at least one is
  -- required by the constraint below — an account identified by neither cannot
  -- be matched to a statement at all.
  bank_name text,
  account_number text,

  label text not null,

  -- The control account in the chart. Composite FK, so a bank account can only
  -- map to a ledger account belonging to the SAME entity — the entity-isolation
  -- rule from 037, applied here rather than assumed.
  ledger_account_id uuid not null,

  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint accounting_bank_accounts_identified
    check (coalesce(nullif(trim(bank_name), ''), nullif(trim(account_number), '')) is not null),

  constraint accounting_bank_accounts_ledger_same_entity
    foreign key (ledger_account_id, company_id)
    references public.accounting_accounts (id, company_id)
    on delete restrict
);

-- One mapping per account number per entity. Case- and space-insensitive, so
-- "62905786151" and " 62905786151 " cannot become two bank accounts that
-- reconcile separately against the same real account.
create unique index if not exists accounting_bank_accounts_number_per_company
  on public.accounting_bank_accounts (company_id, lower(trim(account_number)))
  where account_number is not null and trim(account_number) <> '';

create index if not exists accounting_bank_accounts_company_idx
  on public.accounting_bank_accounts (company_id, is_active);

-- ---------------------------------------------------------------------------
-- A reconciliation: one bank account, one period, one formal record.
-- ---------------------------------------------------------------------------
create table if not exists public.accounting_reconciliations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  bank_account_id uuid not null references public.accounting_bank_accounts(id) on delete restrict,

  period_start date not null,
  period_end date not null,

  -- The bank's figure, recorded as at completion. This is the one number worth
  -- storing: it is a statement of what the bank said on the day the
  -- reconciliation was signed off, and a later statement correction must not
  -- silently rewrite a completed reconciliation's history.
  statement_balance numeric(18, 2),

  -- The ledger figure AT COMPLETION, for the same reason. While a
  -- reconciliation is in progress the ledger balance is always derived live;
  -- this is only written when the reconciliation is completed.
  ledger_balance_at_completion numeric(18, 2),

  status text not null default 'in_progress'
    check (status in ('in_progress', 'completed', 'reopened')),

  notes text,

  completed_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint accounting_reconciliations_ordered check (period_start <= period_end),

  -- A completed reconciliation must record both balances. Completing one
  -- without them would leave a signed-off record that cannot be re-derived.
  constraint accounting_reconciliations_completed_has_balances
    check (
      status <> 'completed'
      or (statement_balance is not null and ledger_balance_at_completion is not null)
    )
);

-- One reconciliation per bank account per period. A second one for the same
-- month would mean two answers to the same question.
create unique index if not exists accounting_reconciliations_unique_period
  on public.accounting_reconciliations (bank_account_id, period_start, period_end);

create index if not exists accounting_reconciliations_company_idx
  on public.accounting_reconciliations (company_id, period_end desc);

-- ---------------------------------------------------------------------------
-- Reconciliation items.
--
-- One row per decision the accountant made: this bank line matches that ledger
-- posting; this bank line is a timing difference; this ledger entry has no bank
-- counterpart yet.
--
-- A match is a GROUP, not a pair. `match_group` lets one bank item answer to
-- several ledger postings and vice versa — a single transfer paying four
-- invoices is one bank line and four postings, and forcing that into pairs
-- would either lose the relationship or invent three more bank lines.
-- ---------------------------------------------------------------------------
create table if not exists public.accounting_reconciliation_items (
  id uuid primary key default gen_random_uuid(),
  reconciliation_id uuid not null references public.accounting_reconciliations(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- Exactly one side is populated for a plain item; a matched pair is two rows
  -- sharing a match_group.
  transaction_id uuid references public.accounting_transactions(id) on delete set null,
  posting_id uuid references public.accounting_postings(id) on delete restrict,

  match_group uuid,

  -- matched            — bank and ledger agree
  -- timing_difference  — both sides are correct; they will meet next period
  -- missing_posting    — the bank has it, the books do not: an ACCOUNTING ERROR
  -- missing_bank_item  — the books have it, the bank does not
  -- excluded           — deliberately outside this reconciliation, with a reason
  --
  -- The distinction between timing_difference and missing_posting is the point
  -- of the whole exercise. A timing difference resolves itself; a missing
  -- posting means the books are wrong and someone has to act.
  item_type text not null
    check (item_type in ('matched', 'timing_difference', 'missing_posting', 'missing_bank_item', 'excluded')),

  -- How the match was arrived at. 'auto' records that a rule proposed it and a
  -- person confirmed it — never that the system decided alone.
  match_method text not null default 'manual'
    check (match_method in ('manual', 'auto', 'suggested')),
  match_confidence numeric(5, 2),

  -- Set when a reconciliation produced a correcting journal, so the entry that
  -- fixed the books is traceable from the reconciliation that found the problem.
  resolving_journal_id uuid references public.accounting_journals(id) on delete set null,

  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  -- An item that references neither side is not an item.
  constraint accounting_reconciliation_items_has_a_side
    check (transaction_id is not null or posting_id is not null),

  -- A confidence figure without an automated method, or an automated method
  -- claiming certainty it never computed, would both misrepresent how the
  -- match was reached.
  constraint accounting_reconciliation_items_confidence_range
    check (match_confidence is null or (match_confidence >= 0 and match_confidence <= 100))
);

-- A bank transaction may appear once per reconciliation, and a posting likewise.
-- Without this, re-running auto-match would silently double-count.
create unique index if not exists accounting_reconciliation_items_one_transaction
  on public.accounting_reconciliation_items (reconciliation_id, transaction_id)
  where transaction_id is not null;

create unique index if not exists accounting_reconciliation_items_one_posting
  on public.accounting_reconciliation_items (reconciliation_id, posting_id)
  where posting_id is not null;

create index if not exists accounting_reconciliation_items_group_idx
  on public.accounting_reconciliation_items (reconciliation_id, match_group);

-- ---------------------------------------------------------------------------
-- A completed reconciliation is frozen.
--
-- Its whole purpose is to be a record of what was agreed on a date. Editing its
-- items afterwards would change history without leaving any trace that it had
-- changed. Reopening is an explicit act that sets status back to 'reopened'.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_reconciliation_items_frozen_when_complete()
returns trigger
language plpgsql
as $$
declare
  reconciliation_status text;
begin
  select status into reconciliation_status
  from public.accounting_reconciliations
  where id = coalesce(new.reconciliation_id, old.reconciliation_id);

  if reconciliation_status = 'completed' then
    raise exception
      'this reconciliation is completed; reopen it before changing its items'
      using errcode = 'restrict_violation';
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists accounting_reconciliation_items_guard on public.accounting_reconciliation_items;
create trigger accounting_reconciliation_items_guard
  before insert or update or delete on public.accounting_reconciliation_items
  for each row execute function public.accounting_reconciliation_items_frozen_when_complete();

-- ---------------------------------------------------------------------------
-- The ledger balance of a bank control account, at a date.
--
-- Derived from postings. This is the number the statement is reconciled
-- AGAINST, and it is computed rather than stored so it can never drift from the
-- ledger it describes.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_bank_ledger_balance(
  target_bank_account uuid,
  as_at date default null
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
  from public.accounting_bank_accounts b
  join public.accounting_accounts a
    on a.id = b.ledger_account_id and a.company_id = b.company_id
  left join public.accounting_postings p
    on p.account_id = a.id
   and p.company_id = a.company_id
   and (as_at is null or p.posting_date <= as_at)
  where b.id = target_bank_account;
$$;

-- ---------------------------------------------------------------------------
-- Completion, with the accounting rule enforced.
--
-- A reconciliation is NOT complete because the difference is zero. It is
-- complete when the difference is EXPLAINED:
--
--     statement balance
--       − unmatched bank items         (on the bank, not yet in the books)
--       + unmatched ledger entries     (in the books, not yet at the bank)
--       = ledger balance
--
-- Items typed 'missing_posting' are excluded from that explanation on purpose.
-- A missing posting is an accounting error, not a reconciling item, and letting
-- it balance the reconciliation would sign off books that are known to be wrong.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_complete_reconciliation(
  target_reconciliation uuid,
  statement_balance_input numeric
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  rec public.accounting_reconciliations%rowtype;
  ledger_balance numeric(18, 2);
  bank_side numeric(18, 2);
  ledger_side numeric(18, 2);
  unresolved integer;
  residual numeric(18, 2);
begin
  select * into rec from public.accounting_reconciliations where id = target_reconciliation for update;
  if not found then
    raise exception 'reconciliation % not found', target_reconciliation using errcode = 'no_data_found';
  end if;
  if rec.status = 'completed' then
    raise exception 'this reconciliation is already completed' using errcode = 'restrict_violation';
  end if;

  -- An accounting error may not be carried into a completed reconciliation.
  select count(*) into unresolved
  from public.accounting_reconciliation_items
  where reconciliation_id = target_reconciliation
    and item_type = 'missing_posting'
    and resolving_journal_id is null;

  if unresolved > 0 then
    raise exception
      '% item(s) are missing from the ledger and have no correcting journal. A missing posting is an accounting error, not a reconciling item.',
      unresolved
      using errcode = 'restrict_violation';
  end if;

  ledger_balance := public.accounting_bank_ledger_balance(rec.bank_account_id, rec.period_end);

  -- Reconciling items: bank-side and ledger-side timing differences.
  select coalesce(sum(coalesce(t.debit_amount, 0) - coalesce(t.credit_amount, 0)), 0)
    into bank_side
  from public.accounting_reconciliation_items i
  join public.accounting_transactions t on t.id = i.transaction_id
  where i.reconciliation_id = target_reconciliation
    and i.item_type in ('timing_difference', 'missing_bank_item');

  select coalesce(sum(p.debit - p.credit), 0)
    into ledger_side
  from public.accounting_reconciliation_items i
  join public.accounting_postings p on p.id = i.posting_id
  where i.reconciliation_id = target_reconciliation
    and i.item_type in ('timing_difference', 'missing_bank_item');

  -- statement ± reconciling items must equal the ledger. Exact: this is the
  -- same rule as a balanced journal and gets the same treatment.
  residual := (statement_balance_input - bank_side + ledger_side) - ledger_balance;

  if residual <> 0 then
    raise exception
      'the reconciliation does not explain the difference. Statement %, reconciling items % / %, ledger %, unexplained %.',
      statement_balance_input, bank_side, ledger_side, ledger_balance, residual
      using errcode = 'restrict_violation';
  end if;

  update public.accounting_reconciliations
  set status = 'completed',
      statement_balance = statement_balance_input,
      ledger_balance_at_completion = ledger_balance,
      completed_at = now(),
      completed_by = auth.uid(),
      updated_at = now()
  where id = target_reconciliation;

  return target_reconciliation;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security.
-- ---------------------------------------------------------------------------
alter table public.accounting_bank_accounts enable row level security;
alter table public.accounting_reconciliations enable row level security;
alter table public.accounting_reconciliation_items enable row level security;

drop policy if exists "Users can access accounting bank accounts" on public.accounting_bank_accounts;
create policy "Users can access accounting bank accounts" on public.accounting_bank_accounts
  for all using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()))
  with check (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));

drop policy if exists "Users can access accounting reconciliations" on public.accounting_reconciliations;
create policy "Users can access accounting reconciliations" on public.accounting_reconciliations
  for all using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()))
  with check (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));

drop policy if exists "Users can access accounting reconciliation items" on public.accounting_reconciliation_items;
create policy "Users can access accounting reconciliation items" on public.accounting_reconciliation_items
  for all using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()))
  with check (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));
