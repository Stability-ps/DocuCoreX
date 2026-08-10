-- The engagement a workspace's statement coverage is measured against.
--
-- Without this, coverage can only report gaps BETWEEN statements it already
-- holds. That is a real and provable finding — April and June present, May
-- absent, so a May statement exists — but it is silent about the two questions
-- an accountant actually asks: does the period we were engaged for start
-- earlier than the first statement we were given, and is there an account we
-- have never received anything for at all.
--
-- Neither can be inferred from the data. The earliest statement being April is
-- equally consistent with an engagement beginning in April and with two missing
-- months. Guessing produces confident nonsense in one direction or silent gaps
-- in the other, so the boundary is stated rather than derived.
--
-- One row per workspace: an engagement is a property of the client relationship,
-- not of a statement or a run, and nothing here cascades from a reprocess.

create table if not exists public.accounting_engagement (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  -- Stored as dates for sane comparison and formatting; coverage works in whole
  -- months and takes the month each date falls in.
  start_date date,
  end_date date,
  -- Accounts the engagement expects. An account named here with no statements
  -- at all is the single most valuable thing the coverage view can show, and it
  -- cannot be discovered any other way — an account that never arrived leaves
  -- no trace in the data.
  expected_accounts text[] not null default '{}',
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint accounting_engagement_period_ordered
    check (start_date is null or end_date is null or start_date <= end_date)
);

alter table public.accounting_engagement enable row level security;

drop policy if exists "Users can access accounting engagement" on public.accounting_engagement;
create policy "Users can access accounting engagement" on public.accounting_engagement
  for all using (
    workspace_id in (
      select workspace_id from public.profiles where id = auth.uid()
    )
  )
  with check (
    workspace_id in (
      select workspace_id from public.profiles where id = auth.uid()
    )
  );
