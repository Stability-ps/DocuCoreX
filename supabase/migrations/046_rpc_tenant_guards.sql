-- Close cross-tenant writes through SECURITY DEFINER functions.
--
-- These four functions bypass RLS by design, and until now every one of them
-- was executable by `anon` (PUBLIC's default EXECUTE was never revoked) and
-- trusted whatever id it was handed:
--
--   next_invoice_sequence(workspace)        anyone could advance another
--   next_company_invoice_sequence(company)  tenant's invoice counter, leaving a
--                                           gap in its tax-invoice numbering and
--                                           learning how many it had issued.
--   accounting_seed_chart_of_accounts(..)   anyone could insert chart / tax-code
--   accounting_seed_tax_codes(..)           rows under any company id.
--
-- The sequences are called by the app as the signed-in user for their own
-- workspace or company (lib/invoices.ts, lib/companies.ts), so they keep the
-- `authenticated` grant and gain an ownership check. The seeders are only ever
-- called by the accounting_seed_new_company trigger, which runs as its owner,
-- so no client role needs them at all.
--
-- Covered by tests/sql/35_rpc_tenancy.sql.

create or replace function public.next_invoice_sequence(p_workspace_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  assigned integer;
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles
     where id = auth.uid()
       and workspace_id = p_workspace_id
  ) then
    raise exception 'workspace access denied' using errcode = '42501';
  end if;

  insert into public.invoice_sequences (workspace_id, next_number)
  values (p_workspace_id, 2)
  on conflict (workspace_id) do update
    set next_number = invoice_sequences.next_number + 1,
        updated_at = now()
  returning next_number - 1 into assigned;

  return assigned;
end;
$$;

create or replace function public.next_company_invoice_sequence(p_company_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  assigned integer;
begin
  if auth.uid() is null or not exists (
    select 1
      from public.companies c
      join public.profiles p on p.workspace_id = c.workspace_id
     where c.id = p_company_id
       and p.id = auth.uid()
  ) then
    raise exception 'company access denied' using errcode = '42501';
  end if;

  insert into public.company_invoice_sequences (company_id, next_number)
  values (p_company_id, 2)
  on conflict (company_id) do update
    set next_number = company_invoice_sequences.next_number + 1,
        updated_at = now()
  returning next_number - 1 into assigned;

  return assigned;
end;
$$;

revoke all on function public.next_invoice_sequence(uuid) from public, anon;
grant execute on function public.next_invoice_sequence(uuid) to authenticated;

revoke all on function public.next_company_invoice_sequence(uuid) from public, anon;
grant execute on function public.next_company_invoice_sequence(uuid) to authenticated;

revoke all on function public.accounting_seed_chart_of_accounts(uuid, uuid) from public, anon, authenticated;
revoke all on function public.accounting_seed_tax_codes(uuid, uuid) from public, anon, authenticated;
