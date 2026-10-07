-- SECURITY DEFINER RPCs must not cross tenant boundaries (migration 046).
--
-- next_invoice_sequence, next_company_invoice_sequence and the two chart/tax
-- seeders bypass RLS by design. Before 046 they were executable by `anon` and
-- trusted whatever workspace/company id they were handed, so anyone holding the
-- public anon key could advance another tenant's invoice counter (a gap in its
-- tax-invoice numbering) or insert rows into its chart of accounts.
set client_min_messages = notice;

-- A second tenant the fixture user does not belong to.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000b1', 'other@test.local');
insert into public.workspaces (id, name, owner_id)
values ('11111111-0000-0000-0000-000000000002', 'Other Workspace', '00000000-0000-0000-0000-0000000000b1');
update public.profiles set workspace_id = '11111111-0000-0000-0000-000000000002'
 where id = '00000000-0000-0000-0000-0000000000b1';
insert into public.companies (id, workspace_id, is_default, business_name)
values ('22222222-0000-0000-0000-00000000000c', '11111111-0000-0000-0000-000000000002', true, 'Other Tenant (Pty) Ltd');

-- ── grants ──────────────────────────────────────────────────────────────────
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.next_invoice_sequence(uuid)',
    'public.next_company_invoice_sequence(uuid)',
    'public.accounting_seed_chart_of_accounts(uuid, uuid)',
    'public.accounting_seed_tax_codes(uuid, uuid)'
  ] loop
    perform t_report('§46 anon cannot execute ' || split_part(fn, '(', 1),
      not has_function_privilege('anon', fn, 'execute'), fn);
  end loop;
  foreach fn in array array[
    'public.accounting_seed_chart_of_accounts(uuid, uuid)',
    'public.accounting_seed_tax_codes(uuid, uuid)'
  ] loop
    perform t_report('§46 authenticated cannot execute ' || split_part(fn, '(', 1),
      not has_function_privilege('authenticated', fn, 'execute'), fn);
  end loop;
  perform t_report('§46 authenticated keeps next_invoice_sequence',
    has_function_privilege('authenticated', 'public.next_invoice_sequence(uuid)', 'execute'));
  perform t_report('§46 authenticated keeps next_company_invoice_sequence',
    has_function_privilege('authenticated', 'public.next_company_invoice_sequence(uuid)', 'execute'));
end $$;

-- ── ownership, acting as the fixture user (tenant A) ────────────────────────
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);

do $$
declare raised boolean; code text; before_ws int; before_co int; n1 int; n2 int;
begin
  select coalesce(max(next_number), 0) into before_ws from public.invoice_sequences
   where workspace_id = '11111111-0000-0000-0000-000000000002';
  raised := false;
  begin
    perform public.next_invoice_sequence('11111111-0000-0000-0000-000000000002');
  exception when others then raised := true; code := sqlstate;
  end;
  perform t_report('§46 foreign workspace invoice sequence refused', raised and code = '42501',
    format('sqlstate=%s', coalesce(code, 'none')));
  perform t_report('§46 foreign workspace counter unchanged',
    (select coalesce(max(next_number), 0) from public.invoice_sequences
      where workspace_id = '11111111-0000-0000-0000-000000000002') = before_ws);

  select coalesce(max(next_number), 0) into before_co from public.company_invoice_sequences
   where company_id = '22222222-0000-0000-0000-00000000000c';
  raised := false; code := null;
  begin
    perform public.next_company_invoice_sequence('22222222-0000-0000-0000-00000000000c');
  exception when others then raised := true; code := sqlstate;
  end;
  perform t_report('§46 foreign company invoice sequence refused', raised and code = '42501',
    format('sqlstate=%s', coalesce(code, 'none')));
  perform t_report('§46 foreign company counter unchanged',
    (select coalesce(max(next_number), 0) from public.company_invoice_sequences
      where company_id = '22222222-0000-0000-0000-00000000000c') = before_co);

  -- The caller's own counters still work and stay gapless.
  n1 := public.next_invoice_sequence('11111111-0000-0000-0000-000000000001');
  n2 := public.next_invoice_sequence('11111111-0000-0000-0000-000000000001');
  perform t_report('§46 own workspace sequence is consecutive', n2 = n1 + 1, format('%s then %s', n1, n2));
  n1 := public.next_company_invoice_sequence('22222222-0000-0000-0000-00000000000a');
  n2 := public.next_company_invoice_sequence('22222222-0000-0000-0000-00000000000a');
  perform t_report('§46 own company sequence is consecutive', n2 = n1 + 1, format('%s then %s', n1, n2));
end $$;

-- No session at all (what an anon-key request carries).
select set_config('request.jwt.claim.sub', '', false);
do $$
declare raised boolean := false; code text;
begin
  begin
    perform public.next_invoice_sequence('11111111-0000-0000-0000-000000000001');
  exception when others then raised := true; code := sqlstate;
  end;
  perform t_report('§46 sequence refused without a session', raised and code = '42501',
    format('sqlstate=%s', coalesce(code, 'none')));
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);

-- The new-company trigger still seeds the chart and tax codes after the revoke.
do $$
begin
  perform t_report('§46 new company still seeded with chart',
    (select count(*) from public.accounting_accounts where company_id = '22222222-0000-0000-0000-00000000000c') > 0);
  perform t_report('§46 new company still seeded with tax codes',
    (select count(*) from public.accounting_tax_codes where company_id = '22222222-0000-0000-0000-00000000000c') > 0);
end $$;
