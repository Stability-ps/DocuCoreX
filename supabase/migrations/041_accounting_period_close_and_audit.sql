-- Period close and the audit trail.
-- Stage 9 of docs/ACCOUNTING_WORKSPACE_PLAN.md.
--
-- Migration 036 already enforces the interesting rule — a locked or
-- soft-closed period refuses new postings, and "absence of a row means open."
-- What was missing was everything that CREATES those rows, a way to reopen one
-- that is itself accountable, and anywhere to see the history of who did what.
--
-- accounting_action_audit (migration 005) is workspace-scoped, has no
-- append-only guarantee, and is written to from exactly two call sites. It is
-- left exactly as it is — nothing here migrates its data or changes its
-- callers. accounting_audit_events is the ledger-era replacement the workspace
-- plan's schema section names: company-scoped, append-only by trigger for
-- every writer including the service role (same reasoning as 036 §"why
-- triggers and not only policies"), and populated by the database itself
-- rather than by application code remembering to call a logging function.
--
-- WHAT IS DELIBERATELY NOT HERE: locking accounting_periods does not reach
-- into accounting_reconciliations or accounting_vat_periods. 040 states plainly
-- that a VAT period does not align with a month-end close and "one cannot stand
-- in for the other" — coupling their lifecycles would contradict that. A
-- reconciliation posts nothing itself, so the existing posting gate already
-- stops the thing that would actually be wrong: a new posting landing in a
-- period that was signed off.

-- ---------------------------------------------------------------------------
-- The audit log.
-- ---------------------------------------------------------------------------
create table if not exists public.accounting_audit_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text not null,

  previous_value jsonb,
  new_value jsonb,
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now()
);

create index if not exists accounting_audit_events_company_idx
  on public.accounting_audit_events (company_id, created_at desc);

create index if not exists accounting_audit_events_entity_idx
  on public.accounting_audit_events (entity_type, entity_id);

-- Append-only for every writer, the same guard as accounting_postings (036).
-- The triggers below are SECURITY DEFINER so they always succeed regardless of
-- who or what performed the underlying action; nothing else is granted insert.
create or replace function public.accounting_audit_events_are_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'accounting_audit_events is append-only: an event cannot be % once recorded.',
    lower(tg_op)
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists accounting_audit_events_no_update on public.accounting_audit_events;
create trigger accounting_audit_events_no_update
  before update on public.accounting_audit_events
  for each row execute function public.accounting_audit_events_are_append_only();

drop trigger if exists accounting_audit_events_no_delete on public.accounting_audit_events;
create trigger accounting_audit_events_no_delete
  before delete on public.accounting_audit_events
  for each row execute function public.accounting_audit_events_are_append_only();

alter table public.accounting_audit_events enable row level security;

drop policy if exists "Users can read accounting audit events" on public.accounting_audit_events;
create policy "Users can read accounting audit events" on public.accounting_audit_events
  for select using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));

-- No insert/update/delete policy for ordinary users: every row is written by a
-- SECURITY DEFINER trigger below, never by application code directly.

-- ---------------------------------------------------------------------------
-- Journals: log the two transitions that matter, posted and reversed.
-- Everything else about draft/pending_review/approved is workflow, not history.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_journals_log_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = old.status or new.status not in ('posted', 'reversed') then
    return new;
  end if;

  insert into public.accounting_audit_events (
    company_id, workspace_id, actor_id, action, entity_type, entity_id, previous_value, new_value
  ) values (
    new.company_id, new.workspace_id, auth.uid(),
    case new.status when 'posted' then 'journal_posted' else 'journal_reversed' end,
    'accounting_journal', new.id::text, to_jsonb(old), to_jsonb(new)
  );
  return new;
end;
$$;

drop trigger if exists accounting_journals_audit_status on public.accounting_journals;
create trigger accounting_journals_audit_status
  after update on public.accounting_journals
  for each row execute function public.accounting_journals_log_status_change();

-- ---------------------------------------------------------------------------
-- Reconciliations: log completion and reopening.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_reconciliations_log_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  insert into public.accounting_audit_events (
    company_id, workspace_id, actor_id, action, entity_type, entity_id, previous_value, new_value
  ) values (
    new.company_id, new.workspace_id, auth.uid(),
    case new.status when 'completed' then 'reconciliation_completed' else 'reconciliation_reopened' end,
    'accounting_reconciliation', new.id::text, to_jsonb(old), to_jsonb(new)
  );
  return new;
end;
$$;

drop trigger if exists accounting_reconciliations_audit_status on public.accounting_reconciliations;
create trigger accounting_reconciliations_audit_status
  after update on public.accounting_reconciliations
  for each row execute function public.accounting_reconciliations_log_status_change();

-- ---------------------------------------------------------------------------
-- VAT periods: same "absence means open" shape as accounting_periods, so a
-- submission/lock is an insert and a reopen is a delete. Logged the same way.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_vat_periods_log_submit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.accounting_audit_events (
    company_id, workspace_id, actor_id, action, entity_type, entity_id, new_value
  ) values (
    new.company_id, new.workspace_id, auth.uid(),
    case new.status when 'locked' then 'vat_period_locked' else 'vat_period_submitted' end,
    'accounting_vat_period', new.id::text, to_jsonb(new)
  );
  return new;
end;
$$;

drop trigger if exists accounting_vat_periods_audit_insert on public.accounting_vat_periods;
create trigger accounting_vat_periods_audit_insert
  after insert on public.accounting_vat_periods
  for each row execute function public.accounting_vat_periods_log_submit();

create or replace function public.accounting_vat_periods_log_reopen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.accounting_audit_events (
    company_id, workspace_id, actor_id, action, entity_type, entity_id, previous_value, metadata
  ) values (
    old.company_id, old.workspace_id, auth.uid(), 'vat_period_reopened',
    'accounting_vat_period', old.id::text, to_jsonb(old),
    jsonb_build_object('reason', coalesce(nullif(current_setting('docucorex.audit_reason', true), ''), '(no reason recorded)'))
  );
  return old;
end;
$$;

drop trigger if exists accounting_vat_periods_audit_delete on public.accounting_vat_periods;
create trigger accounting_vat_periods_audit_delete
  after delete on public.accounting_vat_periods
  for each row execute function public.accounting_vat_periods_log_reopen();

-- ---------------------------------------------------------------------------
-- Accounting periods: the same insert-is-close, delete-is-reopen shape,
-- logged the same way as VAT periods above.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_periods_log_close()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.accounting_audit_events (
    company_id, workspace_id, actor_id, action, entity_type, entity_id, new_value
  ) values (
    new.company_id, new.workspace_id, auth.uid(),
    case new.status when 'locked' then 'period_locked' else 'period_soft_closed' end,
    'accounting_period', new.id::text, to_jsonb(new)
  );
  return new;
end;
$$;

drop trigger if exists accounting_periods_audit_insert on public.accounting_periods;
create trigger accounting_periods_audit_insert
  after insert on public.accounting_periods
  for each row execute function public.accounting_periods_log_close();

create or replace function public.accounting_periods_log_reopen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.accounting_audit_events (
    company_id, workspace_id, actor_id, action, entity_type, entity_id, previous_value, metadata
  ) values (
    old.company_id, old.workspace_id, auth.uid(), 'period_reopened',
    'accounting_period', old.id::text, to_jsonb(old),
    jsonb_build_object('reason', coalesce(nullif(current_setting('docucorex.audit_reason', true), ''), '(no reason recorded)'))
  );
  return old;
end;
$$;

drop trigger if exists accounting_periods_audit_delete on public.accounting_periods;
create trigger accounting_periods_audit_delete
  after delete on public.accounting_periods
  for each row execute function public.accounting_periods_log_reopen();

-- ---------------------------------------------------------------------------
-- Close a period.
--
-- Locking is a sign-off, so it refuses while a draft or pending_review journal
-- is dated inside the range — such a journal could never be posted afterwards
-- without reopening, and locking should not silently create an unpostable
-- backlog. A soft close carries no such requirement: it is the ordinary
-- month-end pause, not the final word, and correcting it is expected.
--
-- SECURITY INVOKER: RLS still applies, exactly as if the caller had written
-- the insert themselves. accounting_periods_no_overlap (036) is what actually
-- prevents two closes over the same range.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_close_period(
  target_company uuid,
  from_date date,
  to_date date,
  target_status text,
  note_input text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  new_id uuid;
  ws uuid;
  draft_count integer;
begin
  if target_status not in ('soft_closed', 'locked') then
    raise exception 'status must be soft_closed or locked' using errcode = 'restrict_violation';
  end if;
  if from_date > to_date then
    raise exception 'period_start must not be after period_end' using errcode = 'restrict_violation';
  end if;

  select workspace_id into ws from public.companies where id = target_company;
  if ws is null then
    raise exception 'company % not found', target_company using errcode = 'no_data_found';
  end if;

  if target_status = 'locked' then
    select count(*) into draft_count
    from public.accounting_journals
    where company_id = target_company
      and journal_date between from_date and to_date
      and status in ('draft', 'pending_review');

    if draft_count > 0 then
      raise exception
        'cannot lock: % unposted journal(s) dated in this period; post or remove them first',
        draft_count
        using errcode = 'restrict_violation';
    end if;
  end if;

  insert into public.accounting_periods (company_id, workspace_id, period_start, period_end, status, note, closed_by)
  values (target_company, ws, from_date, to_date, target_status, note_input, auth.uid())
  returning id into new_id;

  return new_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reopen a period. A reason is mandatory, not advisory — the plan (036) calls
-- reopening "a deliberate, audited act," and the audit trigger above records
-- whatever this function puts in docucorex.audit_reason. A caller that deletes
-- the row directly, outside this function, still gets logged by the trigger;
-- it just carries the fallback "(no reason recorded)" instead.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_reopen_period(target_period uuid, reason text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if reason is null or length(trim(reason)) = 0 then
    raise exception 'a reason is required to reopen a closed period' using errcode = 'restrict_violation';
  end if;

  if not exists (select 1 from public.accounting_periods where id = target_period) then
    raise exception 'period % not found', target_period using errcode = 'no_data_found';
  end if;

  perform set_config('docucorex.audit_reason', reason, true);
  delete from public.accounting_periods where id = target_period;
end;
$$;

-- ---------------------------------------------------------------------------
-- Readiness: what a person closing a period should see before they do it.
-- Advisory only — it informs the soft-close decision and explains a lock
-- refusal in advance; it enforces nothing itself.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_period_close_readiness(
  target_company uuid,
  from_date date,
  to_date date
)
returns table (
  unposted_journal_count bigint,
  open_reconciliation_count bigint,
  vat_period_status text
)
language sql
security invoker
stable
set search_path = public
as $$
  select
    (select count(*) from public.accounting_journals
       where company_id = target_company
         and journal_date between from_date and to_date
         and status in ('draft', 'pending_review')),
    (select count(*) from public.accounting_reconciliations
       where company_id = target_company
         and status in ('in_progress', 'reopened')
         and period_start <= to_date and period_end >= from_date),
    (select status from public.accounting_vat_periods
       where company_id = target_company
         and period_start <= to_date and period_end >= from_date
       limit 1);
$$;
