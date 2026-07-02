-- Invoice UI/UX redesign (Pass 1): expanded issuer/client/payment/invoice-detail fields,
-- per-line-item VAT handling, and true per-workspace sequential invoice numbering
-- (INV-000001 style, independent of calendar year, never reused).

-- ---------------------------------------------------------------------------
-- Expanded fields on invoices: business identity/tax, structured bank/payment
-- details, expanded client identity/tax, and additional invoice-level metadata.
-- ---------------------------------------------------------------------------
alter table public.invoices
  add column if not exists issuer_trading_name text,
  add column if not exists issuer_vat_number text,
  add column if not exists issuer_registration_number text,
  add column if not exists issuer_website text,
  add column if not exists issuer_postal_address text,
  add column if not exists bank_name text,
  add column if not exists bank_account_holder text,
  add column if not exists bank_account_number text,
  add column if not exists bank_branch_code text,
  add column if not exists bank_swift text,
  add column if not exists payment_reference text,
  add column if not exists payment_instructions text,
  add column if not exists client_company_name text,
  add column if not exists client_contact_person text,
  add column if not exists client_vat_number text,
  add column if not exists client_registration_number text,
  add column if not exists client_postal_address text,
  add column if not exists attention_to text,
  add column if not exists purchase_order_number text,
  add column if not exists client_reference text,
  add column if not exists payment_terms text not null default 'due_on_receipt',
  add column if not exists currency text not null default 'ZAR',
  add column if not exists reference_number text,
  add column if not exists internal_notes text,
  add column if not exists invoice_date date not null default current_date,
  add column if not exists shipping_amount numeric(12,2) not null default 0,
  add column if not exists additional_charges numeric(12,2) not null default 0,
  add column if not exists sequence_number integer;

alter table public.invoices
  add constraint invoices_payment_terms_check
  check (payment_terms in ('due_on_receipt', '7_days', '14_days', '30_days', '60_days', '90_days'));

-- ---------------------------------------------------------------------------
-- Per-line-item VAT: each line can be exempt, zero-rated, standard (15%), or a
-- custom rate, rather than one flat invoice-level tax_rate applied to everything.
-- ---------------------------------------------------------------------------
alter table public.invoice_items
  add column if not exists vat_type text not null default 'standard',
  add column if not exists vat_rate numeric(5,2) not null default 15;

alter table public.invoice_items
  add constraint invoice_items_vat_type_check
  check (vat_type in ('exempt', 'zero_rated', 'standard', 'custom'));

-- ---------------------------------------------------------------------------
-- Per-workspace invoice sequence: guarantees INV-000001, INV-000002, ... that
-- never reuses a number, independent from the database row id and independent
-- per workspace. A dedicated table + security-definer function keeps the
-- increment atomic under concurrent invoice creation.
-- ---------------------------------------------------------------------------
create table public.invoice_sequences (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  next_number integer not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.invoice_sequences enable row level security;

create policy "Users can view their workspace invoice sequence" on public.invoice_sequences
  for select using (
    workspace_id in (select workspace_id from public.profiles where id = auth.uid())
  );

-- Mutations only happen through next_invoice_sequence() (security definer), so no
-- insert/update/delete policy is granted directly to authenticated users.

create or replace function public.next_invoice_sequence(p_workspace_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  assigned integer;
begin
  insert into public.invoice_sequences (workspace_id, next_number)
  values (p_workspace_id, 2)
  on conflict (workspace_id) do update
    set next_number = invoice_sequences.next_number + 1,
        updated_at = now()
  returning next_number - 1 into assigned;

  return assigned;
end;
$$;

grant execute on function public.next_invoice_sequence(uuid) to authenticated;
