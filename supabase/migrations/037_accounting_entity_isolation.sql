-- Corrective migration: an accounting line may only use an account belonging to
-- its own entity.
--
-- WHY THIS EXISTS
--
-- Migration 036 was verified against a real PostgreSQL instance in Stage 4B.
-- Fourteen of the fifteen accounting controls held. This one did not:
--
--   Entity A journal
--     Dr  Entity B's Bank account      100.00
--     Cr  Entity A's Shareholder Loan  100.00
--
-- was accepted, posted, and produced a row in accounting_postings whose
-- company_id was Entity A while its account belonged to Entity B. The journal
-- balanced, so the posting gate passed it; nothing anywhere asserted that an
-- account belongs to the entity being posted.
--
-- That is entity leakage, and it is the failure this product can least afford:
-- an accountant holding several clients in one workspace would find one
-- client's balance sitting in another client's trial balance, with both sets of
-- books internally consistent and neither obviously wrong.
--
-- HOW IT IS FIXED
--
-- Composite foreign keys, not triggers and not application checks. A row cannot
-- reference an account unless the (id, company_id) pair matches, so the rule
-- holds for the service role, for imports, for a psql session, and for any code
-- written later. It is declarative, so it also cannot be forgotten.
--
-- This is a corrective migration rather than an edit to 036 because 036 is
-- already merged to main. Rewriting applied history is how two databases end up
-- believing different things about the same migration number.
--
-- FORWARD SAFETY
--
-- Only constraints are added; no data is altered or removed. If a database
-- already contains a cross-entity line or posting, the ALTER will fail loudly
-- rather than silently accepting it — which is the correct outcome, because
-- such a row is a real accounting error that a person has to resolve. The
-- diagnostic below names the offending rows before the constraints are added.

-- ---------------------------------------------------------------------------
-- Report any pre-existing violations before attempting the constraints, so a
-- failure comes with the rows that caused it rather than only a constraint name.
-- ---------------------------------------------------------------------------
do $$
declare
  bad_lines integer;
  bad_postings integer;
begin
  select count(*) into bad_lines
  from public.accounting_journal_lines line
  join public.accounting_accounts account on account.id = line.account_id
  where account.company_id <> line.company_id;

  select count(*) into bad_postings
  from public.accounting_postings posting
  join public.accounting_accounts account on account.id = posting.account_id
  where account.company_id <> posting.company_id;

  if bad_lines > 0 or bad_postings > 0 then
    raise warning
      'entity isolation: % journal line(s) and % posting(s) reference an account belonging to another entity. These must be reversed and re-posted against the correct entity before this migration can complete.',
      bad_lines, bad_postings;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The referenced pairs a composite foreign key needs.
-- ---------------------------------------------------------------------------
alter table public.accounting_accounts
  drop constraint if exists accounting_accounts_id_company_key;
alter table public.accounting_accounts
  add constraint accounting_accounts_id_company_key unique (id, company_id);

alter table public.accounting_journals
  drop constraint if exists accounting_journals_id_company_key;
alter table public.accounting_journals
  add constraint accounting_journals_id_company_key unique (id, company_id);

-- ---------------------------------------------------------------------------
-- A journal line's account must belong to the line's entity, and the line must
-- belong to a journal of that same entity.
-- ---------------------------------------------------------------------------
alter table public.accounting_journal_lines
  drop constraint if exists accounting_journal_lines_account_same_entity;
alter table public.accounting_journal_lines
  add constraint accounting_journal_lines_account_same_entity
  foreign key (account_id, company_id)
  references public.accounting_accounts (id, company_id)
  on delete restrict;

alter table public.accounting_journal_lines
  drop constraint if exists accounting_journal_lines_journal_same_entity;
alter table public.accounting_journal_lines
  add constraint accounting_journal_lines_journal_same_entity
  foreign key (journal_id, company_id)
  references public.accounting_journals (id, company_id)
  on delete cascade;

-- ---------------------------------------------------------------------------
-- The same rule on the ledger itself. accounting_post_journal copies company_id
-- from the line, so this cannot currently be violated on its own — but the
-- ledger is the table that must never be wrong, and a control that depends on
-- another table's correctness is not a control.
-- ---------------------------------------------------------------------------
alter table public.accounting_postings
  drop constraint if exists accounting_postings_account_same_entity;
alter table public.accounting_postings
  add constraint accounting_postings_account_same_entity
  foreign key (account_id, company_id)
  references public.accounting_accounts (id, company_id)
  on delete restrict;

alter table public.accounting_postings
  drop constraint if exists accounting_postings_journal_same_entity;
alter table public.accounting_postings
  add constraint accounting_postings_journal_same_entity
  foreign key (journal_id, company_id)
  references public.accounting_journals (id, company_id)
  on delete restrict;

-- A journal line may name the bank transaction it came from, so the posting can
-- carry the link through to the ledger. Nullable: a manual journal has no
-- source. ON DELETE SET NULL for the same reason as the posting column —
-- deleting a source must never destroy ledger history.
alter table public.accounting_journal_lines
  add column if not exists source_transaction_id uuid
  references public.accounting_transactions(id) on delete set null;

-- ---------------------------------------------------------------------------
-- ONE DOOR INTO THE LEDGER.
--
-- The second finding from Stage 4B verification. accounting_postings refused
-- UPDATE and DELETE, but accepted a direct INSERT — so a single statement could
-- add one leg of an entry and put the trial balance out of balance, without
-- passing the balance check, the period check, or leaving a journal behind.
-- The verification suite did exactly that by accident and the trial balance
-- went out by R125.00.
--
-- No application code does this today (searched: nothing outside tests
-- references the table). But "no caller does this yet" is not a control, and
-- this is the one table in the product that must never be wrong.
--
-- The gate is a transaction-local flag that only accounting_post_journal sets.
-- set_config(..., true) is local to the transaction, so it cannot leak into a
-- later statement or another session, and it is cleared as soon as the insert
-- is done.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_postings_only_via_gate()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('docucorex.ledger_gate', true), '') <> 'open' then
    raise exception
      'accounting_postings may only be written by accounting_post_journal. Create a journal and post it instead of inserting a posting directly.'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists accounting_postings_gate on public.accounting_postings;
create trigger accounting_postings_gate
  before insert on public.accounting_postings
  for each row execute function public.accounting_postings_only_via_gate();

-- Re-declared so it opens the gate around its own insert. Everything else about
-- this function is unchanged from migration 036.
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
  -- Serialise on the journal row. Two concurrent calls for the same journal
  -- would otherwise both read status 'draft', both pass every check, and both
  -- insert — turning a R1,000,000 journal into R2,000,000 on a double-click or
  -- a worker retry. The second call now waits, then sees 'posted' and is
  -- refused below.
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

  perform set_config('docucorex.ledger_gate', 'open', true);

  insert into public.accounting_postings (
    company_id, workspace_id, journal_id, journal_line_id, account_id,
    posting_date, debit, credit, description, vat_treatment, created_by,
    source_transaction_id
  )
  select
    line.company_id, line.workspace_id, line.journal_id, line.id, line.account_id,
    journal.journal_date, line.debit, line.credit, line.description, line.vat_treatment, auth.uid(),
    line.source_transaction_id
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
-- Wording fix on the append-only message. It read "a posting cannot be update
-- once made"; tg_op is UPDATE/DELETE, which does not inflect into that
-- sentence. The rule is unchanged.
-- ---------------------------------------------------------------------------
-- THE THIRD FINDING FROM STAGE 4B, and the one only execution could reveal.
--
-- source_transaction_id is ON DELETE SET NULL so that deleting a bank statement
-- never destroys ledger history. But SET NULL is an UPDATE, and this trigger
-- refused every UPDATE — so the moment any posting referenced a transaction,
-- that statement could no longer be deleted at all. The ledger was not at risk;
-- the SOURCE became undeletable, which would have broken the existing
-- delete-statement path as soon as Stage 5 started linking the two.
--
-- The carve-out is deliberately narrow: the reference may go from set to NULL,
-- and nothing else about the row may differ. Every field that carries
-- accounting meaning is compared, so this cannot become a general update path.
create or replace function public.accounting_postings_are_append_only()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE'
     and old.source_transaction_id is not null
     and new.source_transaction_id is null
     and new.company_id      is not distinct from old.company_id
     and new.workspace_id    is not distinct from old.workspace_id
     and new.journal_id      is not distinct from old.journal_id
     and new.journal_line_id is not distinct from old.journal_line_id
     and new.account_id      is not distinct from old.account_id
     and new.posting_date    is not distinct from old.posting_date
     and new.debit           is not distinct from old.debit
     and new.credit          is not distinct from old.credit
     and new.description     is not distinct from old.description
     and new.vat_treatment   is not distinct from old.vat_treatment
     and new.created_by      is not distinct from old.created_by
     and new.created_at      is not distinct from old.created_at
  then
    return new;
  end if;

  raise exception
    'accounting_postings is append-only: a posting cannot be % once made. Reverse the journal or post an adjusting journal instead.',
    case tg_op when 'UPDATE' then 'changed' else 'removed' end
    using errcode = 'restrict_violation';
end;
$$;

-- The same carve-out on journal lines, which are frozen once posted and carry
-- the same nullable source reference for the same reason.
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
    if tg_op = 'UPDATE'
       and old.source_transaction_id is not null
       and new.source_transaction_id is null
       and new.account_id  is not distinct from old.account_id
       and new.debit       is not distinct from old.debit
       and new.credit      is not distinct from old.credit
       and new.company_id  is not distinct from old.company_id
       and new.line_number is not distinct from old.line_number
    then
      return new;
    end if;

    raise exception 'journal lines cannot be changed once the journal is %', journal_status
      using errcode = 'restrict_violation';
  end if;

  return coalesce(new, old);
end;
$$;
