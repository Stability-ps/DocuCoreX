create table if not exists public.uploads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  document_id uuid references public.documents(id) on delete set null,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null default 0,
  storage_path text not null,
  status public.job_status not null default 'queued',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.document_shares (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  shared_with uuid references auth.users(id) on delete cascade,
  permission text not null default 'view',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  title text not null,
  body text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'Viewer',
  status text not null default 'Active',
  created_at timestamptz not null default now(),
  unique(workspace_id, email)
);

create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  role text not null default 'Viewer',
  token text not null default encode(gen_random_bytes(24), 'hex'),
  accepted_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.integrations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null,
  category text not null,
  status text not null default 'ready_to_connect',
  config jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, provider)
);

create table if not exists public.automation_pipelines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.support_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  body text not null,
  status text not null default 'open',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  theme text not null default 'system',
  notifications boolean not null default true,
  date_format text not null default 'DD/MM/YYYY',
  default_export text not null default 'xlsx',
  viewer_density text not null default 'comfortable',
  updated_at timestamptz not null default now()
);

alter table public.uploads enable row level security;
alter table public.document_shares enable row level security;
alter table public.notifications enable row level security;
alter table public.team_members enable row level security;
alter table public.invites enable row level security;
alter table public.integrations enable row level security;
alter table public.automation_pipelines enable row level security;
alter table public.support_requests enable row level security;
alter table public.user_settings enable row level security;

drop policy if exists "Users can access uploads" on public.uploads;
create policy "Users can access uploads" on public.uploads
  for all using (
    workspace_id in (
      select workspace_id from public.profiles where id = auth.uid()
    )
  );

drop policy if exists "Users can access document shares" on public.document_shares;
create policy "Users can access document shares" on public.document_shares
  for all using (
    document_id in (
      select id from public.documents
      where workspace_id in (select workspace_id from public.profiles where id = auth.uid())
    )
  );

drop policy if exists "Users can access notifications" on public.notifications;
create policy "Users can access notifications" on public.notifications
  for all using (
    workspace_id in (
      select workspace_id from public.profiles where id = auth.uid()
    )
    and (user_id is null or user_id = auth.uid())
  );

drop policy if exists "Users can access team members" on public.team_members;
create policy "Users can access team members" on public.team_members
  for all using (
    workspace_id in (
      select workspace_id from public.profiles where id = auth.uid()
    )
  );

drop policy if exists "Users can access invites" on public.invites;
create policy "Users can access invites" on public.invites
  for all using (
    workspace_id in (
      select workspace_id from public.profiles where id = auth.uid()
    )
  );

drop policy if exists "Users can access integrations" on public.integrations;
create policy "Users can access integrations" on public.integrations
  for all using (
    workspace_id in (
      select workspace_id from public.profiles where id = auth.uid()
    )
  );

drop policy if exists "Users can access automation pipelines" on public.automation_pipelines;
create policy "Users can access automation pipelines" on public.automation_pipelines
  for all using (
    workspace_id in (
      select workspace_id from public.profiles where id = auth.uid()
    )
  );

drop policy if exists "Users can access support requests" on public.support_requests;
create policy "Users can access support requests" on public.support_requests
  for all using (
    workspace_id in (
      select workspace_id from public.profiles where id = auth.uid()
    )
  );

drop policy if exists "Users can access own settings" on public.user_settings;
create policy "Users can access own settings" on public.user_settings
  for all using (user_id = auth.uid());
