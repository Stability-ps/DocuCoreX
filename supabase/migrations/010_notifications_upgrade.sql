-- Upgrade notifications to support proper read-state tracking, typed events,
-- and direct navigation targets. Replaces the boolean `read` flag with a
-- `read_at` timestamp (read_at IS NULL == unread) and adds fields needed to
-- route notification clicks to the right entity in the app.

-- Migration 002 normally creates this table. Keep this upgrade independently
-- recoverable for databases whose early app-state migration was only partially
-- applied, and for manual migration runs. The legacy `read` column is included
-- here solely so the backfill below has the same source shape as migration 002.
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  title text not null,
  body text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.notifications
  add column if not exists type text not null default 'system_maintenance_notice',
  add column if not exists entity_type text,
  add column if not exists entity_id uuid,
  add column if not exists href text,
  add column if not exists read_at timestamptz;

-- `read` no longer exists after the first successful run. A static UPDATE that
-- names it makes the migration fail on retry at parse time, so inspect the
-- catalogue and execute the one-time backfill only while the column exists.
do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'notifications'
       and column_name = 'read'
  ) then
    execute $backfill$
      update public.notifications
         set read_at = coalesce(read_at, case when read then created_at else null end)
       where read_at is null
    $backfill$;
  end if;
end;
$$;

alter table public.notifications
  drop column if exists read;

create index if not exists notifications_workspace_user_unread_idx
  on public.notifications (workspace_id, user_id, read_at);

create index if not exists notifications_workspace_created_idx
  on public.notifications (workspace_id, created_at desc);

-- These normally come from migration 002. Reassert them here because a table
-- recovered by this migration must never be left without workspace isolation.
alter table public.notifications enable row level security;

drop policy if exists "Users can access notifications" on public.notifications;
create policy "Users can access notifications" on public.notifications
  for all using (
    workspace_id in (
      select workspace_id from public.profiles where id = auth.uid()
    )
    and (user_id is null or user_id = auth.uid())
  )
  with check (
    workspace_id in (
      select workspace_id from public.profiles where id = auth.uid()
    )
    and (user_id is null or user_id = auth.uid())
  );
