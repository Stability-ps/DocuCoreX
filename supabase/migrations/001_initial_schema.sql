create extension if not exists "pgcrypto";

create type public.document_status as enum (
  'uploaded',
  'queued',
  'processing',
  'ready',
  'review',
  'failed',
  'archived'
);

create type public.document_type as enum (
  'bank_statement',
  'invoice',
  'receipt',
  'financial_statement',
  'contract',
  'payslip',
  'tax_document',
  'purchase_order',
  'unknown'
);

create type public.job_type as enum (
  'upload',
  'virus_scan',
  'ocr',
  'layout_analysis',
  'extraction',
  'conversion',
  'export'
);

create type public.job_status as enum (
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled'
);

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  plan text not null default 'trial',
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete set null,
  full_name text,
  company text,
  role text default 'member',
  two_factor_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  folder_id uuid,
  name text not null,
  mime_type text not null,
  size_bytes bigint not null default 0,
  page_count int not null default 0,
  status public.document_status not null default 'uploaded',
  detected_type public.document_type not null default 'unknown',
  storage_path text not null,
  tags text[] not null default '{}',
  starred boolean not null default false,
  shared boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  version_number int not null,
  storage_path text not null,
  change_note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(document_id, version_number)
);

create table if not exists public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  type public.job_type not null,
  status public.job_status not null default 'queued',
  progress int not null default 0 check (progress >= 0 and progress <= 100),
  message text not null default '',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ocr_results (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  language text not null default 'unknown',
  confidence numeric(5,2) not null default 0,
  text text not null default '',
  layout jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.extraction_results (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  detected_type public.document_type not null default 'unknown',
  confidence numeric(5,2) not null default 0,
  fields jsonb not null default '{}'::jsonb,
  line_items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.ai_insights (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  prompt text not null,
  answer text not null,
  confidence numeric(5,2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.conversions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  from_format text not null,
  to_format text not null,
  status public.job_status not null default 'queued',
  download_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.document_comments (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  key_hash text not null,
  last_four text not null,
  created_by uuid references auth.users(id) on delete set null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.usage_counters (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  documents_uploaded int not null default 0,
  pages_processed int not null default 0,
  ocr_credits_used int not null default 0,
  storage_bytes bigint not null default 0,
  exports_created int not null default 0,
  unique(workspace_id, period_start, period_end)
);

alter table public.workspaces enable row level security;
alter table public.profiles enable row level security;
alter table public.documents enable row level security;
alter table public.document_versions enable row level security;
alter table public.processing_jobs enable row level security;
alter table public.ocr_results enable row level security;
alter table public.extraction_results enable row level security;
alter table public.ai_insights enable row level security;
alter table public.conversions enable row level security;
alter table public.document_comments enable row level security;
alter table public.api_keys enable row level security;
alter table public.audit_logs enable row level security;
alter table public.usage_counters enable row level security;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile" on public.profiles for select using (auth.uid() = id);
drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);
drop policy if exists "Workspace owners can access workspace" on public.workspaces;
create policy "Workspace owners can access workspace" on public.workspaces for all using (auth.uid() = owner_id);
drop policy if exists "Users can access workspace documents" on public.documents;
create policy "Users can access workspace documents" on public.documents for all using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));
drop policy if exists "Users can access document versions" on public.document_versions;
create policy "Users can access document versions" on public.document_versions for all using (document_id in (select id from public.documents where workspace_id in (select workspace_id from public.profiles where id = auth.uid())));
drop policy if exists "Users can access document jobs" on public.processing_jobs;
create policy "Users can access document jobs" on public.processing_jobs for all using (document_id in (select id from public.documents where workspace_id in (select workspace_id from public.profiles where id = auth.uid())));
drop policy if exists "Users can access OCR results" on public.ocr_results;
create policy "Users can access OCR results" on public.ocr_results for all using (document_id in (select id from public.documents where workspace_id in (select workspace_id from public.profiles where id = auth.uid())));
drop policy if exists "Users can access extraction results" on public.extraction_results;
create policy "Users can access extraction results" on public.extraction_results for all using (document_id in (select id from public.documents where workspace_id in (select workspace_id from public.profiles where id = auth.uid())));
drop policy if exists "Users can access AI insights" on public.ai_insights;
create policy "Users can access AI insights" on public.ai_insights for all using (document_id in (select id from public.documents where workspace_id in (select workspace_id from public.profiles where id = auth.uid())));
drop policy if exists "Users can access conversions" on public.conversions;
create policy "Users can access conversions" on public.conversions for all using (document_id in (select id from public.documents where workspace_id in (select workspace_id from public.profiles where id = auth.uid())));
drop policy if exists "Users can access comments" on public.document_comments;
create policy "Users can access comments" on public.document_comments for all using (document_id in (select id from public.documents where workspace_id in (select workspace_id from public.profiles where id = auth.uid())));
drop policy if exists "Users can access API keys" on public.api_keys;
create policy "Users can access API keys" on public.api_keys for all using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));
drop policy if exists "Users can access audit logs" on public.audit_logs;
create policy "Users can access audit logs" on public.audit_logs for select using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));
drop policy if exists "Users can access usage counters" on public.usage_counters;
create policy "Users can access usage counters" on public.usage_counters for select using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

drop policy if exists "Users can read workspace document objects" on storage.objects;
create policy "Users can read workspace document objects" on storage.objects for select using (bucket_id = 'documents' and split_part(name, '/', 1) in (select workspace_id::text from public.profiles where id = auth.uid()));
drop policy if exists "Users can upload workspace document objects" on storage.objects;
create policy "Users can upload workspace document objects" on storage.objects for insert with check (bucket_id = 'documents' and split_part(name, '/', 1) in (select workspace_id::text from public.profiles where id = auth.uid()));
drop policy if exists "Users can update workspace document objects" on storage.objects;
create policy "Users can update workspace document objects" on storage.objects for update using (bucket_id = 'documents' and split_part(name, '/', 1) in (select workspace_id::text from public.profiles where id = auth.uid()));

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_workspace_id uuid;
begin
  insert into public.workspaces (name, owner_id)
  values (coalesce(new.raw_user_meta_data->>'company', 'DocuCoreX Workspace'), new.id)
  returning id into new_workspace_id;

  insert into public.profiles (id, workspace_id, full_name, company, role)
  values (
    new.id,
    new_workspace_id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    new.raw_user_meta_data->>'company',
    'owner'
  );

  insert into public.team_members (workspace_id, user_id, email, role, status)
  values (new_workspace_id, new.id, new.email, 'Owner', 'Active')
  on conflict (workspace_id, email) do update
    set user_id = excluded.user_id,
        role = excluded.role,
        status = excluded.status;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
