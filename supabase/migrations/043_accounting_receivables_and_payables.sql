-- Accounts receivable and accounts payable: customers, suppliers, tagged
-- control-account postings, allocation, and ageing.
-- Stage 7B of docs/ACCOUNTING_WORKSPACE_PLAN.md.
--
-- THE SUBLEDGER LINK IS THE SAME TRICK AS TWICE BEFORE. `customer_id` and
-- `supplier_id` are nullable columns added to accounting_journal_lines and
-- accounting_postings, exactly how tax_code_id (040) and source_transaction_id
-- (036) were added. An invoice is a journal (Dr AR control / Cr Revenue); a
-- receipt is a journal (Dr Bank / Cr AR control); both are tagged with the
-- same customer.
--
-- WHAT IS NEW HERE, WITH NO EARLIER PRECEDENT: a posting to the AR or AP
-- control account is REFUSED unless it names a customer or supplier.
-- Everywhere else in this schema, an untagged posting just doesn't show up in
-- a report (a tax code with no postings, a bank account with no
-- reconciliation) — quiet, but not wrong. Here it would be wrong: an
-- untagged posting to the control account changes the control account's
-- balance while being invisible to ageing forever, and there is no later
-- screen where the gap becomes visible. So this is enforced in
-- accounting_post_journal itself, not left to the ageing report to notice.
--
-- ALLOCATION IS THE ONE GENUINELY NEW MECHANISM. Reconciliation (039)
-- matches two DIFFERENT systems' records — the bank's and the ledger's.
-- Allocation matches two records ALREADY INSIDE the same ledger: an invoice
-- posting and the receipt posting that settles it. accounting_ar_allocations
-- is not a second ledger and moves no money — both postings already exist;
-- the allocation only records which settles which, and by how much. That is
-- also why it is not append-only like a posting: removing an allocation
-- un-links a judgment, it does not rewrite what was posted. Same posture as
-- accounting_reconciliation_items.

-- ---------------------------------------------------------------------------
-- Customers and suppliers. Deliberately not the existing `invoices` table's
-- client_name free text — that table is workspace-scoped, has no ledger link,
-- and merging the two is a separate decision this migration does not make.
-- ---------------------------------------------------------------------------
create table if not exists public.accounting_customers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  name text not null,
  email text,
  phone text,
  address text,
  is_active boolean not null default true,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint accounting_customers_id_company_unique unique (id, company_id)
);

create index if not exists accounting_customers_company_idx
  on public.accounting_customers (company_id, is_active);

create table if not exists public.accounting_suppliers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  name text not null,
  email text,
  phone text,
  address text,
  is_active boolean not null default true,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint accounting_suppliers_id_company_unique unique (id, company_id)
);

create index if not exists accounting_suppliers_company_idx
  on public.accounting_suppliers (company_id, is_active);

-- ---------------------------------------------------------------------------
-- Control accounts. One AR and one AP control account per entity — a
-- separate mapping table, the way accounting_bank_accounts holds several
-- bank mappings, would be more machinery than a firm running one debtors
-- control and one creditors control needs.
-- ---------------------------------------------------------------------------
alter table public.accounting_entity_settings
  add column if not exists ar_control_account_id uuid references public.accounting_accounts(id) on delete restrict;
alter table public.accounting_entity_settings
  add column if not exists ap_control_account_id uuid references public.accounting_accounts(id) on delete restrict;

alter table public.accounting_entity_settings
  drop constraint if exists accounting_entity_settings_ar_control_same_entity;
alter table public.accounting_entity_settings
  add constraint accounting_entity_settings_ar_control_same_entity
  foreign key (ar_control_account_id, company_id)
  references public.accounting_accounts (id, company_id)
  on delete restrict;

alter table public.accounting_entity_settings
  drop constraint if exists accounting_entity_settings_ap_control_same_entity;
alter table public.accounting_entity_settings
  add constraint accounting_entity_settings_ap_control_same_entity
  foreign key (ap_control_account_id, company_id)
  references public.accounting_accounts (id, company_id)
  on delete restrict;

-- ---------------------------------------------------------------------------
-- The subledger tag, plus a due date for ageing. A composite FK even though
-- both columns are nullable — a NULL customer_id skips the FK check
-- entirely, so this only ever constrains a tag that is actually present to
-- the SAME entity as the line or posting it sits on.
-- ---------------------------------------------------------------------------
alter table public.accounting_journals
  add column if not exists due_date date;

alter table public.accounting_journal_lines
  add column if not exists customer_id uuid references public.accounting_customers(id) on delete restrict;
alter table public.accounting_journal_lines
  add column if not exists supplier_id uuid references public.accounting_suppliers(id) on delete restrict;

alter table public.accounting_journal_lines
  drop constraint if exists accounting_journal_lines_customer_same_entity;
alter table public.accounting_journal_lines
  add constraint accounting_journal_lines_customer_same_entity
  foreign key (customer_id, company_id) references public.accounting_customers (id, company_id) on delete restrict;

alter table public.accounting_journal_lines
  drop constraint if exists accounting_journal_lines_supplier_same_entity;
alter table public.accounting_journal_lines
  add constraint accounting_journal_lines_supplier_same_entity
  foreign key (supplier_id, company_id) references public.accounting_suppliers (id, company_id) on delete restrict;

alter table public.accounting_postings
  add column if not exists customer_id uuid references public.accounting_customers(id) on delete restrict;
alter table public.accounting_postings
  add column if not exists supplier_id uuid references public.accounting_suppliers(id) on delete restrict;

alter table public.accounting_postings
  drop constraint if exists accounting_postings_customer_same_entity;
alter table public.accounting_postings
  add constraint accounting_postings_customer_same_entity
  foreign key (customer_id, company_id) references public.accounting_customers (id, company_id) on delete restrict;

alter table public.accounting_postings
  drop constraint if exists accounting_postings_supplier_same_entity;
alter table public.accounting_postings
  add constraint accounting_postings_supplier_same_entity
  foreign key (supplier_id, company_id) references public.accounting_suppliers (id, company_id) on delete restrict;

create index if not exists accounting_postings_customer_idx
  on public.accounting_postings (company_id, customer_id, posting_date) where customer_id is not null;
create index if not exists accounting_postings_supplier_idx
  on public.accounting_postings (company_id, supplier_id, posting_date) where supplier_id is not null;

-- ---------------------------------------------------------------------------
-- The posting gate, extended a third time (037 added entity isolation, 040
-- added the tax-code carry and the VAT-lock check). Everything above this
-- comment is unchanged from 040.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_post_journal(target_journal uuid)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  journal public.accounting_journals%rowtype;
  total_debit numeric(18, 2);
  total_credit numeric(18, 2);
  line_count integer;
  blocking_period text;
  blocking_vat_period text;
  ar_account uuid;
  ap_account uuid;
  untagged_ar boolean;
  untagged_ap boolean;
begin
  select * into journal from public.accounting_journals
  where id = target_journal
  for update;

  if not found then
    raise exception 'journal % not found', target_journal using errcode = 'no_data_found';
  end if;

  if journal.status = 'posted' then
    raise exception 'journal is already posted' using errcode = 'restrict_violation';
  end if;
  if journal.status = 'reversed' then
    raise exception 'a reversed journal cannot be posted again' using errcode = 'restrict_violation';
  end if;

  select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
    into total_debit, total_credit, line_count
  from public.accounting_journal_lines
  where journal_id = target_journal;

  if line_count = 0 then
    raise exception 'a journal with no lines cannot be posted' using errcode = 'restrict_violation';
  end if;

  if total_debit <> total_credit then
    raise exception
      'journal does not balance: debits %, credits %, difference %',
      total_debit, total_credit, (total_debit - total_credit)
      using errcode = 'restrict_violation';
  end if;

  if total_debit = 0 then
    raise exception 'a journal of zero cannot be posted' using errcode = 'restrict_violation';
  end if;

  select status into blocking_period
  from public.accounting_periods
  where company_id = journal.company_id
    and journal.journal_date between period_start and period_end
  limit 1;

  if blocking_period is not null then
    raise exception
      'the period containing % is %; reopen it or post to an open period',
      journal.journal_date, blocking_period
      using errcode = 'restrict_violation';
  end if;

  -- A locked VAT period refuses only VAT-BEARING journals. A journal with no
  -- tax code changes no VAT figure, and blocking it would stop ordinary
  -- bookkeeping in a period whose return happens to be filed.
  select v.status into blocking_vat_period
  from public.accounting_vat_periods v
  where v.company_id = journal.company_id
    and v.status = 'locked'
    and journal.journal_date between v.period_start and v.period_end
    and exists (
      select 1 from public.accounting_journal_lines l
      where l.journal_id = target_journal and l.tax_code_id is not null
    )
  limit 1;

  if blocking_vat_period is not null then
    raise exception
      'the VAT period containing % is locked; a VAT-bearing journal cannot be posted into a filed period',
      journal.journal_date
      using errcode = 'restrict_violation';
  end if;

  -- A line to the AR or AP control account must name who it belongs to.
  -- Untagged, it would move the control account's balance while staying
  -- invisible to ageing forever — no later screen catches this the way an
  -- unused tax code or an unreconciled bank account is visibly absent.
  select ar_control_account_id, ap_control_account_id
    into ar_account, ap_account
  from public.accounting_entity_settings
  where company_id = journal.company_id;

  if ar_account is not null then
    select exists (
      select 1 from public.accounting_journal_lines l
      where l.journal_id = target_journal and l.account_id = ar_account and l.customer_id is null
    ) into untagged_ar;
    if untagged_ar then
      raise exception 'a line posting to the accounts receivable control account must name a customer'
        using errcode = 'restrict_violation';
    end if;
  end if;

  if ap_account is not null then
    select exists (
      select 1 from public.accounting_journal_lines l
      where l.journal_id = target_journal and l.account_id = ap_account and l.supplier_id is null
    ) into untagged_ap;
    if untagged_ap then
      raise exception 'a line posting to the accounts payable control account must name a supplier'
        using errcode = 'restrict_violation';
    end if;
  end if;

  perform set_config('docucorex.ledger_gate', 'open', true);

  insert into public.accounting_postings (
    company_id, workspace_id, journal_id, journal_line_id, account_id,
    posting_date, debit, credit, description, vat_treatment, created_by,
    source_transaction_id, tax_code_id, customer_id, supplier_id
  )
  select
    line.company_id, line.workspace_id, line.journal_id, line.id, line.account_id,
    journal.journal_date, line.debit, line.credit, line.description, line.vat_treatment, auth.uid(),
    line.source_transaction_id, line.tax_code_id, line.customer_id, line.supplier_id
  from public.accounting_journal_lines line
  where line.journal_id = target_journal
  order by line.line_number;

  perform set_config('docucorex.ledger_gate', '', true);

  update public.accounting_journals
  set status = 'posted', posted_at = now(), posted_by = auth.uid(), updated_at = now()
  where id = target_journal;

  return target_journal;
end;
$$;

-- ---------------------------------------------------------------------------
-- Allocation. Which receipt settles which invoice, and by how much.
-- Not append-only: an allocation is a judgment about existing postings, not
-- an accounting entry itself. Removing one un-links; it alters no history.
-- ---------------------------------------------------------------------------
create table if not exists public.accounting_ar_allocations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  customer_id uuid not null references public.accounting_customers(id) on delete restrict,
  invoice_posting_id uuid not null references public.accounting_postings(id) on delete restrict,
  receipt_posting_id uuid not null references public.accounting_postings(id) on delete restrict,
  amount numeric(18, 2) not null check (amount > 0),

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists accounting_ar_allocations_invoice_idx on public.accounting_ar_allocations (invoice_posting_id);
create index if not exists accounting_ar_allocations_receipt_idx on public.accounting_ar_allocations (receipt_posting_id);
create index if not exists accounting_ar_allocations_company_idx on public.accounting_ar_allocations (company_id, customer_id);

create table if not exists public.accounting_ap_allocations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  supplier_id uuid not null references public.accounting_suppliers(id) on delete restrict,
  bill_posting_id uuid not null references public.accounting_postings(id) on delete restrict,
  payment_posting_id uuid not null references public.accounting_postings(id) on delete restrict,
  amount numeric(18, 2) not null check (amount > 0),

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists accounting_ap_allocations_bill_idx on public.accounting_ap_allocations (bill_posting_id);
create index if not exists accounting_ap_allocations_payment_idx on public.accounting_ap_allocations (payment_posting_id);
create index if not exists accounting_ap_allocations_company_idx on public.accounting_ap_allocations (company_id, supplier_id);

-- ---------------------------------------------------------------------------
-- accounting_allocate_ar: the validating gate. "Unallocated remainder" is
-- computed here the same way every other balance in this schema is —
-- summed from existing rows, never stored on the posting itself.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_allocate_ar(
  invoice_posting uuid,
  receipt_posting uuid,
  amount numeric
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  inv public.accounting_postings%rowtype;
  rec public.accounting_postings%rowtype;
  ar_account uuid;
  invoice_remaining numeric(18, 2);
  receipt_remaining numeric(18, 2);
  alloc_id uuid;
begin
  if amount is null or amount <= 0 then
    raise exception 'allocation amount must be positive' using errcode = 'restrict_violation';
  end if;

  select * into inv from public.accounting_postings where id = invoice_posting;
  if not found then
    raise exception 'invoice posting % not found', invoice_posting using errcode = 'no_data_found';
  end if;
  select * into rec from public.accounting_postings where id = receipt_posting;
  if not found then
    raise exception 'receipt posting % not found', receipt_posting using errcode = 'no_data_found';
  end if;

  if inv.company_id <> rec.company_id then
    raise exception 'the invoice and receipt belong to different entities' using errcode = 'restrict_violation';
  end if;
  if inv.customer_id is null or inv.customer_id <> rec.customer_id then
    raise exception 'the invoice and receipt must name the same customer' using errcode = 'restrict_violation';
  end if;

  select ar_control_account_id into ar_account
  from public.accounting_entity_settings where company_id = inv.company_id;

  if ar_account is null or inv.account_id <> ar_account or rec.account_id <> ar_account then
    raise exception 'both postings must be to the entity''s accounts receivable control account'
      using errcode = 'restrict_violation';
  end if;
  if inv.debit <= 0 then
    raise exception 'the invoice posting must be a debit to the control account' using errcode = 'restrict_violation';
  end if;
  if rec.credit <= 0 then
    raise exception 'the receipt posting must be a credit to the control account' using errcode = 'restrict_violation';
  end if;

  select inv.debit - coalesce(sum(a.amount), 0) into invoice_remaining
  from public.accounting_ar_allocations a where a.invoice_posting_id = inv.id;
  select rec.credit - coalesce(sum(a.amount), 0) into receipt_remaining
  from public.accounting_ar_allocations a where a.receipt_posting_id = rec.id;

  if amount > invoice_remaining then
    raise exception 'amount % exceeds the invoice''s unallocated balance of %', amount, invoice_remaining
      using errcode = 'restrict_violation';
  end if;
  if amount > receipt_remaining then
    raise exception 'amount % exceeds the receipt''s unallocated balance of %', amount, receipt_remaining
      using errcode = 'restrict_violation';
  end if;

  insert into public.accounting_ar_allocations (
    company_id, workspace_id, customer_id, invoice_posting_id, receipt_posting_id, amount, created_by
  ) values (
    inv.company_id, inv.workspace_id, inv.customer_id, inv.id, rec.id, amount, auth.uid()
  ) returning id into alloc_id;

  return alloc_id;
end;
$$;

-- accounting_allocate_ap: the AP mirror. AP is a liability — a bill CREDITS
-- the control account, a payment DEBITS it, the opposite of the AR pair.
create or replace function public.accounting_allocate_ap(
  bill_posting uuid,
  payment_posting uuid,
  amount numeric
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  bill public.accounting_postings%rowtype;
  pay public.accounting_postings%rowtype;
  ap_account uuid;
  bill_remaining numeric(18, 2);
  payment_remaining numeric(18, 2);
  alloc_id uuid;
begin
  if amount is null or amount <= 0 then
    raise exception 'allocation amount must be positive' using errcode = 'restrict_violation';
  end if;

  select * into bill from public.accounting_postings where id = bill_posting;
  if not found then
    raise exception 'bill posting % not found', bill_posting using errcode = 'no_data_found';
  end if;
  select * into pay from public.accounting_postings where id = payment_posting;
  if not found then
    raise exception 'payment posting % not found', payment_posting using errcode = 'no_data_found';
  end if;

  if bill.company_id <> pay.company_id then
    raise exception 'the bill and payment belong to different entities' using errcode = 'restrict_violation';
  end if;
  if bill.supplier_id is null or bill.supplier_id <> pay.supplier_id then
    raise exception 'the bill and payment must name the same supplier' using errcode = 'restrict_violation';
  end if;

  select ap_control_account_id into ap_account
  from public.accounting_entity_settings where company_id = bill.company_id;

  if ap_account is null or bill.account_id <> ap_account or pay.account_id <> ap_account then
    raise exception 'both postings must be to the entity''s accounts payable control account'
      using errcode = 'restrict_violation';
  end if;
  if bill.credit <= 0 then
    raise exception 'the bill posting must be a credit to the control account' using errcode = 'restrict_violation';
  end if;
  if pay.debit <= 0 then
    raise exception 'the payment posting must be a debit to the control account' using errcode = 'restrict_violation';
  end if;

  select bill.credit - coalesce(sum(a.amount), 0) into bill_remaining
  from public.accounting_ap_allocations a where a.bill_posting_id = bill.id;
  select pay.debit - coalesce(sum(a.amount), 0) into payment_remaining
  from public.accounting_ap_allocations a where a.payment_posting_id = pay.id;

  if amount > bill_remaining then
    raise exception 'amount % exceeds the bill''s unallocated balance of %', amount, bill_remaining
      using errcode = 'restrict_violation';
  end if;
  if amount > payment_remaining then
    raise exception 'amount % exceeds the payment''s unallocated balance of %', amount, payment_remaining
      using errcode = 'restrict_violation';
  end if;

  insert into public.accounting_ap_allocations (
    company_id, workspace_id, supplier_id, bill_posting_id, payment_posting_id, amount, created_by
  ) values (
    bill.company_id, bill.workspace_id, bill.supplier_id, bill.id, pay.id, amount, auth.uid()
  ) returning id into alloc_id;

  return alloc_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Open items and ageing, derived — never stored, the same rule as every
-- other balance in this schema.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_ar_open_items(
  target_company uuid,
  as_at date default current_date
)
returns table (
  posting_id uuid,
  customer_id uuid,
  customer_name text,
  posting_date date,
  due_date date,
  description text,
  original_amount numeric(18, 2),
  allocated numeric(18, 2),
  outstanding numeric(18, 2)
)
language sql
security invoker
stable
set search_path = public
as $$
  with control as (
    select ar_control_account_id as account_id from public.accounting_entity_settings where company_id = target_company
  ),
  invoices as (
    select p.id, p.customer_id, p.posting_date, j.due_date,
           coalesce(p.description, j.description) as description, p.debit as original_amount
    from public.accounting_postings p
    join public.accounting_journals j on j.id = p.journal_id
    join control on control.account_id = p.account_id
    where p.company_id = target_company
      and p.customer_id is not null
      and p.debit > 0
      and p.posting_date <= as_at
  ),
  allocated as (
    select a.invoice_posting_id as posting_id, sum(a.amount) as total
    from public.accounting_ar_allocations a
    join public.accounting_postings rp on rp.id = a.receipt_posting_id
    where rp.posting_date <= as_at
    group by a.invoice_posting_id
  )
  select
    i.id, i.customer_id, c.name, i.posting_date, i.due_date, i.description,
    i.original_amount::numeric(18, 2),
    coalesce(al.total, 0)::numeric(18, 2),
    (i.original_amount - coalesce(al.total, 0))::numeric(18, 2)
  from invoices i
  join public.accounting_customers c on c.id = i.customer_id
  left join allocated al on al.posting_id = i.id
  where (i.original_amount - coalesce(al.total, 0)) > 0.005
  order by i.due_date nulls last, i.posting_date;
$$;

-- The other side of allocation: receipts (AR) and payments (AP) that still
-- have an unallocated remainder. Open items alone only lists what is owed;
-- allocating needs both sides of the match.
create or replace function public.accounting_ar_unallocated_receipts(
  target_company uuid,
  as_at date default current_date
)
returns table (
  posting_id uuid,
  customer_id uuid,
  customer_name text,
  posting_date date,
  description text,
  original_amount numeric(18, 2),
  allocated numeric(18, 2),
  remaining numeric(18, 2)
)
language sql
security invoker
stable
set search_path = public
as $$
  with control as (
    select ar_control_account_id as account_id from public.accounting_entity_settings where company_id = target_company
  ),
  receipts as (
    select p.id, p.customer_id, p.posting_date,
           coalesce(p.description, j.description) as description, p.credit as original_amount
    from public.accounting_postings p
    join public.accounting_journals j on j.id = p.journal_id
    join control on control.account_id = p.account_id
    where p.company_id = target_company
      and p.customer_id is not null
      and p.credit > 0
      and p.posting_date <= as_at
  ),
  allocated as (
    select a.receipt_posting_id as posting_id, sum(a.amount) as total
    from public.accounting_ar_allocations a
    group by a.receipt_posting_id
  )
  select
    r.id, r.customer_id, c.name, r.posting_date, r.description,
    r.original_amount::numeric(18, 2),
    coalesce(al.total, 0)::numeric(18, 2),
    (r.original_amount - coalesce(al.total, 0))::numeric(18, 2)
  from receipts r
  join public.accounting_customers c on c.id = r.customer_id
  left join allocated al on al.posting_id = r.id
  where (r.original_amount - coalesce(al.total, 0)) > 0.005
  order by r.posting_date;
$$;

create or replace function public.accounting_ap_open_items(
  target_company uuid,
  as_at date default current_date
)
returns table (
  posting_id uuid,
  supplier_id uuid,
  supplier_name text,
  posting_date date,
  due_date date,
  description text,
  original_amount numeric(18, 2),
  allocated numeric(18, 2),
  outstanding numeric(18, 2)
)
language sql
security invoker
stable
set search_path = public
as $$
  with control as (
    select ap_control_account_id as account_id from public.accounting_entity_settings where company_id = target_company
  ),
  bills as (
    select p.id, p.supplier_id, p.posting_date, j.due_date,
           coalesce(p.description, j.description) as description, p.credit as original_amount
    from public.accounting_postings p
    join public.accounting_journals j on j.id = p.journal_id
    join control on control.account_id = p.account_id
    where p.company_id = target_company
      and p.supplier_id is not null
      and p.credit > 0
      and p.posting_date <= as_at
  ),
  allocated as (
    select a.bill_posting_id as posting_id, sum(a.amount) as total
    from public.accounting_ap_allocations a
    join public.accounting_postings pp on pp.id = a.payment_posting_id
    where pp.posting_date <= as_at
    group by a.bill_posting_id
  )
  select
    b.id, b.supplier_id, s.name, b.posting_date, b.due_date, b.description,
    b.original_amount::numeric(18, 2),
    coalesce(al.total, 0)::numeric(18, 2),
    (b.original_amount - coalesce(al.total, 0))::numeric(18, 2)
  from bills b
  join public.accounting_suppliers s on s.id = b.supplier_id
  left join allocated al on al.posting_id = b.id
  where (b.original_amount - coalesce(al.total, 0)) > 0.005
  order by b.due_date nulls last, b.posting_date;
$$;

create or replace function public.accounting_ap_unallocated_payments(
  target_company uuid,
  as_at date default current_date
)
returns table (
  posting_id uuid,
  supplier_id uuid,
  supplier_name text,
  posting_date date,
  description text,
  original_amount numeric(18, 2),
  allocated numeric(18, 2),
  remaining numeric(18, 2)
)
language sql
security invoker
stable
set search_path = public
as $$
  with control as (
    select ap_control_account_id as account_id from public.accounting_entity_settings where company_id = target_company
  ),
  payments as (
    select p.id, p.supplier_id, p.posting_date,
           coalesce(p.description, j.description) as description, p.debit as original_amount
    from public.accounting_postings p
    join public.accounting_journals j on j.id = p.journal_id
    join control on control.account_id = p.account_id
    where p.company_id = target_company
      and p.supplier_id is not null
      and p.debit > 0
      and p.posting_date <= as_at
  ),
  allocated as (
    select a.payment_posting_id as posting_id, sum(a.amount) as total
    from public.accounting_ap_allocations a
    group by a.payment_posting_id
  )
  select
    p.id, p.supplier_id, s.name, p.posting_date, p.description,
    p.original_amount::numeric(18, 2),
    coalesce(al.total, 0)::numeric(18, 2),
    (p.original_amount - coalesce(al.total, 0))::numeric(18, 2)
  from payments p
  join public.accounting_suppliers s on s.id = p.supplier_id
  left join allocated al on al.posting_id = p.id
  where (p.original_amount - coalesce(al.total, 0)) > 0.005
  order by p.posting_date;
$$;

create or replace function public.accounting_ar_ageing(
  target_company uuid,
  as_at date default current_date
)
returns table (
  customer_id uuid,
  customer_name text,
  current_amount numeric(18, 2),
  days_30 numeric(18, 2),
  days_60 numeric(18, 2),
  days_90_plus numeric(18, 2),
  total_outstanding numeric(18, 2)
)
language sql
security invoker
stable
set search_path = public
as $$
  select
    customer_id, customer_name,
    coalesce(sum(case when (as_at - coalesce(due_date, posting_date)) <= 0 then outstanding else 0 end), 0)::numeric(18, 2),
    coalesce(sum(case when (as_at - coalesce(due_date, posting_date)) between 1 and 30 then outstanding else 0 end), 0)::numeric(18, 2),
    coalesce(sum(case when (as_at - coalesce(due_date, posting_date)) between 31 and 60 then outstanding else 0 end), 0)::numeric(18, 2),
    coalesce(sum(case when (as_at - coalesce(due_date, posting_date)) > 60 then outstanding else 0 end), 0)::numeric(18, 2),
    coalesce(sum(outstanding), 0)::numeric(18, 2)
  from public.accounting_ar_open_items(target_company, as_at)
  group by customer_id, customer_name
  order by customer_name;
$$;

create or replace function public.accounting_ap_ageing(
  target_company uuid,
  as_at date default current_date
)
returns table (
  supplier_id uuid,
  supplier_name text,
  current_amount numeric(18, 2),
  days_30 numeric(18, 2),
  days_60 numeric(18, 2),
  days_90_plus numeric(18, 2),
  total_outstanding numeric(18, 2)
)
language sql
security invoker
stable
set search_path = public
as $$
  select
    supplier_id, supplier_name,
    coalesce(sum(case when (as_at - coalesce(due_date, posting_date)) <= 0 then outstanding else 0 end), 0)::numeric(18, 2),
    coalesce(sum(case when (as_at - coalesce(due_date, posting_date)) between 1 and 30 then outstanding else 0 end), 0)::numeric(18, 2),
    coalesce(sum(case when (as_at - coalesce(due_date, posting_date)) between 31 and 60 then outstanding else 0 end), 0)::numeric(18, 2),
    coalesce(sum(case when (as_at - coalesce(due_date, posting_date)) > 60 then outstanding else 0 end), 0)::numeric(18, 2),
    coalesce(sum(outstanding), 0)::numeric(18, 2)
  from public.accounting_ap_open_items(target_company, as_at)
  group by supplier_id, supplier_name
  order by supplier_name;
$$;

-- ---------------------------------------------------------------------------
-- Audit trail: an allocation is exactly the kind of judgment an auditor
-- wants visible. Same SECURITY DEFINER trigger shape as 041.
-- ---------------------------------------------------------------------------
create or replace function public.accounting_ar_allocations_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.accounting_audit_events (company_id, workspace_id, actor_id, action, entity_type, entity_id, new_value)
    values (new.company_id, new.workspace_id, auth.uid(), 'ar_allocated', 'accounting_ar_allocation', new.id::text, to_jsonb(new));
    return new;
  else
    insert into public.accounting_audit_events (company_id, workspace_id, actor_id, action, entity_type, entity_id, previous_value)
    values (old.company_id, old.workspace_id, auth.uid(), 'ar_allocation_removed', 'accounting_ar_allocation', old.id::text, to_jsonb(old));
    return old;
  end if;
end;
$$;

drop trigger if exists accounting_ar_allocations_audit_insert on public.accounting_ar_allocations;
create trigger accounting_ar_allocations_audit_insert
  after insert on public.accounting_ar_allocations
  for each row execute function public.accounting_ar_allocations_log();

drop trigger if exists accounting_ar_allocations_audit_delete on public.accounting_ar_allocations;
create trigger accounting_ar_allocations_audit_delete
  after delete on public.accounting_ar_allocations
  for each row execute function public.accounting_ar_allocations_log();

create or replace function public.accounting_ap_allocations_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.accounting_audit_events (company_id, workspace_id, actor_id, action, entity_type, entity_id, new_value)
    values (new.company_id, new.workspace_id, auth.uid(), 'ap_allocated', 'accounting_ap_allocation', new.id::text, to_jsonb(new));
    return new;
  else
    insert into public.accounting_audit_events (company_id, workspace_id, actor_id, action, entity_type, entity_id, previous_value)
    values (old.company_id, old.workspace_id, auth.uid(), 'ap_allocation_removed', 'accounting_ap_allocation', old.id::text, to_jsonb(old));
    return old;
  end if;
end;
$$;

drop trigger if exists accounting_ap_allocations_audit_insert on public.accounting_ap_allocations;
create trigger accounting_ap_allocations_audit_insert
  after insert on public.accounting_ap_allocations
  for each row execute function public.accounting_ap_allocations_log();

drop trigger if exists accounting_ap_allocations_audit_delete on public.accounting_ap_allocations;
create trigger accounting_ap_allocations_audit_delete
  after delete on public.accounting_ap_allocations
  for each row execute function public.accounting_ap_allocations_log();

-- ---------------------------------------------------------------------------
-- Row level security.
-- ---------------------------------------------------------------------------
alter table public.accounting_customers enable row level security;
alter table public.accounting_suppliers enable row level security;
alter table public.accounting_ar_allocations enable row level security;
alter table public.accounting_ap_allocations enable row level security;

drop policy if exists "Users can access accounting customers" on public.accounting_customers;
create policy "Users can access accounting customers" on public.accounting_customers
  for all using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()))
  with check (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));

drop policy if exists "Users can access accounting suppliers" on public.accounting_suppliers;
create policy "Users can access accounting suppliers" on public.accounting_suppliers
  for all using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()))
  with check (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));

drop policy if exists "Users can access AR allocations" on public.accounting_ar_allocations;
create policy "Users can access AR allocations" on public.accounting_ar_allocations
  for all using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()))
  with check (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));

drop policy if exists "Users can access AP allocations" on public.accounting_ap_allocations;
create policy "Users can access AP allocations" on public.accounting_ap_allocations
  for all using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()))
  with check (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));
