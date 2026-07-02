-- Client invoicing feature: workspace-scoped invoices with embedded client contact details
-- (DocuCoreX has no clients table, unlike the reference implementation this was ported from).

create type public.invoice_status as enum (
  'draft',
  'issued',
  'paid',
  'overdue',
  'cancelled'
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  invoice_number text not null,
  title text,
  description text,
  status public.invoice_status not null default 'draft',
  client_name text not null,
  client_email text,
  client_phone text,
  client_address text,
  bank_details text,
  notes_to_client text,
  terms_and_conditions text,
  subtotal numeric(12,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  tax_rate numeric(5,2) not null default 0,
  tax_amount numeric(12,2) not null default 0,
  total_amount numeric(12,2) not null default 0,
  amount_paid numeric(12,2) not null default 0,
  due_date date,
  created_by uuid references auth.users(id) on delete set null,
  sent_at timestamptz,
  paid_at timestamptz,
  overdue_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, invoice_number)
);

create table public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  service_item text not null,
  quantity numeric(12,2) not null default 1,
  unit_price numeric(12,2) not null default 0,
  line_total numeric(14,2) generated always as (quantity * unit_price) stored,
  position int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.invoices enable row level security;
alter table public.invoice_items enable row level security;

create policy "Users can access workspace invoices" on public.invoices
  for all using (
    workspace_id in (
      select workspace_id from public.profiles where id = auth.uid()
    )
  );

create policy "Users can access invoice items" on public.invoice_items
  for all using (
    invoice_id in (
      select id from public.invoices
      where workspace_id in (select workspace_id from public.profiles where id = auth.uid())
    )
  );
