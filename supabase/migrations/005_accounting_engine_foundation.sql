alter table if exists public.accounting_statement_runs
  add column if not exists parser_profile text not null default 'fnb_business_v1',
  add column if not exists parser_version text not null default 'fnb_business_v1',
  add column if not exists review_required boolean not null default false,
  add column if not exists review_reason text,
  add column if not exists processing_duration_ms int,
  add column if not exists extraction_accuracy numeric(5,2);

alter table if exists public.accounting_transactions
  add column if not exists source_row int,
  add column if not exists review_comment text;

alter table if exists public.accounting_transactions
  drop constraint if exists accounting_transactions_review_status_check;

alter table if exists public.accounting_transactions
  add constraint accounting_transactions_review_status_check
  check (review_status in ('needs_review', 'ready', 'approved', 'in_review', 'rejected', 'resolved'));

create table if not exists public.accounting_parser_health (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  parser_name text not null,
  version text not null,
  last_updated timestamptz not null default now(),
  regression_pass_rate numeric(5,2) not null default 0,
  supported_layouts text[] not null default '{}',
  known_issues text[] not null default '{}',
  confidence numeric(5,2) not null default 0,
  average_extraction_accuracy numeric(5,2) not null default 0,
  unique(workspace_id, parser_name)
);

create table if not exists public.accounting_statement_analytics (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  bank text not null,
  statements_processed int not null default 0,
  success_rate numeric(5,2) not null default 0,
  average_confidence numeric(5,2) not null default 0,
  average_processing_ms numeric(12,2) not null default 0,
  average_review_rate numeric(5,2) not null default 0,
  updated_at timestamptz not null default now(),
  unique(workspace_id, bank)
);

create table if not exists public.accounting_parser_failures (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  bank text not null,
  failure_reason text not null,
  failure_count int not null default 1,
  updated_at timestamptz not null default now(),
  unique(workspace_id, bank, failure_reason)
);

create table if not exists public.accounting_merchant_knowledge (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  canonical_name text not null,
  aliases text[] not null default '{}',
  default_category text not null,
  default_vat_treatment text not null default 'review'
    check (default_vat_treatment in ('standard', 'zero_rated', 'exempt', 'out_of_scope', 'review')),
  confidence numeric(5,2) not null default 90,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, canonical_name)
);

create table if not exists public.accounting_ai_learning_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  transaction_id uuid references public.accounting_transactions(id) on delete set null,
  merchant text not null,
  description text not null,
  chosen_category text not null,
  vat_treatment text not null,
  confidence numeric(5,2) not null default 0,
  manual_correction boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.accounting_review_comments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  transaction_id uuid not null references public.accounting_transactions(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.accounting_action_audit (
  id uuid primary key default gen_random_uuid(),
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

create index if not exists accounting_parser_health_workspace_idx
  on public.accounting_parser_health(workspace_id, parser_name);

create index if not exists accounting_statement_analytics_workspace_idx
  on public.accounting_statement_analytics(workspace_id, bank);

create index if not exists accounting_review_comments_transaction_idx
  on public.accounting_review_comments(transaction_id, created_at desc);

create index if not exists accounting_action_audit_workspace_idx
  on public.accounting_action_audit(workspace_id, created_at desc);

alter table public.accounting_parser_health enable row level security;
alter table public.accounting_statement_analytics enable row level security;
alter table public.accounting_parser_failures enable row level security;
alter table public.accounting_merchant_knowledge enable row level security;
alter table public.accounting_ai_learning_events enable row level security;
alter table public.accounting_review_comments enable row level security;
alter table public.accounting_action_audit enable row level security;

drop policy if exists "Users can access accounting parser health" on public.accounting_parser_health;
create policy "Users can access accounting parser health" on public.accounting_parser_health
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

drop policy if exists "Users can access accounting statement analytics" on public.accounting_statement_analytics;
create policy "Users can access accounting statement analytics" on public.accounting_statement_analytics
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

drop policy if exists "Users can access accounting parser failures" on public.accounting_parser_failures;
create policy "Users can access accounting parser failures" on public.accounting_parser_failures
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

drop policy if exists "Users can access accounting merchant knowledge" on public.accounting_merchant_knowledge;
create policy "Users can access accounting merchant knowledge" on public.accounting_merchant_knowledge
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

drop policy if exists "Users can access accounting ai learning events" on public.accounting_ai_learning_events;
create policy "Users can access accounting ai learning events" on public.accounting_ai_learning_events
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

drop policy if exists "Users can access accounting review comments" on public.accounting_review_comments;
create policy "Users can access accounting review comments" on public.accounting_review_comments
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

drop policy if exists "Users can access accounting action audit" on public.accounting_action_audit;
create policy "Users can access accounting action audit" on public.accounting_action_audit
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
