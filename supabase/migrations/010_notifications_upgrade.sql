-- Upgrade notifications to support proper read-state tracking, typed events,
-- and direct navigation targets. Replaces the boolean `read` flag with a
-- `read_at` timestamp (read_at IS NULL == unread) and adds fields needed to
-- route notification clicks to the right entity in the app.

alter table public.notifications
  add column if not exists type text not null default 'system_maintenance_notice',
  add column if not exists entity_type text,
  add column if not exists entity_id uuid,
  add column if not exists href text,
  add column if not exists read_at timestamptz;

update public.notifications
  set read_at = coalesce(read_at, case when read then created_at else null end)
  where read_at is null;

alter table public.notifications
  drop column if exists read;

create index if not exists notifications_workspace_user_unread_idx
  on public.notifications (workspace_id, user_id, read_at);

create index if not exists notifications_workspace_created_idx
  on public.notifications (workspace_id, created_at desc);
