create table if not exists public.accounting_classification_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  merchant_key text not null,
  account_category text not null,
  vat_treatment text not null default 'review'
    check (vat_treatment in ('standard', 'zero_rated', 'exempt', 'out_of_scope', 'review')),
  review_status text not null default 'ready'
    check (review_status in ('needs_review', 'ready', 'approved')),
  confidence numeric(5,2) not null default 95,
  reason text not null default 'Learned from accountant correction.',
  sample_description text,
  usage_count int not null default 1,
  last_used_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, merchant_key)
);

create index if not exists accounting_classification_rules_workspace_idx
  on public.accounting_classification_rules(workspace_id, merchant_key);

alter table public.accounting_classification_rules enable row level security;

drop policy if exists "Users can access accounting classification rules" on public.accounting_classification_rules;
create policy "Users can access accounting classification rules" on public.accounting_classification_rules
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
