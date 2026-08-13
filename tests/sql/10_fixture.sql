\set ON_ERROR_STOP on
-- Disposable accounting fixture: two entities, so cross-entity leakage is testable.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1','acct@test.local');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', false);

insert into public.workspaces (id, name, owner_id)
values ('11111111-0000-0000-0000-000000000001'::uuid, 'Verify Workspace', '00000000-0000-0000-0000-0000000000a1');
-- migration 001's handle_new_user trigger already created this profile when the
-- auth.users row was inserted, so point it at the test workspace rather than
-- inserting a second one.
update public.profiles set workspace_id = '11111111-0000-0000-0000-000000000001', full_name = 'Test Accountant'
where id = '00000000-0000-0000-0000-0000000000a1';

-- Entity A and Entity B
insert into public.companies (id, workspace_id, is_default, business_name) values
  ('22222222-0000-0000-0000-00000000000a','11111111-0000-0000-0000-000000000001', true,  'Entity A (Pty) Ltd'),
  ('22222222-0000-0000-0000-00000000000b','11111111-0000-0000-0000-000000000001', false, 'Entity B (Pty) Ltd');

-- Migration 040 installs an AFTER INSERT trigger on companies that seeds
-- accounting settings, the chart and the tax codes, so these rows already
-- exist by the time this runs. Kept for databases migrated before that trigger.
insert into public.accounting_entity_settings (company_id, workspace_id) values
  ('22222222-0000-0000-0000-00000000000a','11111111-0000-0000-0000-000000000001'),
  ('22222222-0000-0000-0000-00000000000b','11111111-0000-0000-0000-000000000001')
on conflict (company_id) do nothing;

insert into public.accounting_financial_years (id, company_id, workspace_id, label, start_date, end_date) values
  ('33333333-0000-0000-0000-00000000000a','22222222-0000-0000-0000-00000000000a','11111111-0000-0000-0000-000000000001','FY2026','2025-03-01','2026-02-28'),
  ('33333333-0000-0000-0000-00000000000b','22222222-0000-0000-0000-00000000000b','11111111-0000-0000-0000-000000000001','FY2026','2025-03-01','2026-02-28');

-- Accounts for Entity A.
--
-- Codes chosen to sit OUTSIDE the starter chart that migration 040's trigger now
-- seeds on company insert — 2100 is SARS / Tax Liability there, so the
-- shareholder loan is 2400 here. The UUIDs are what the tests reference.
-- Accounts for Entity A
insert into public.accounting_accounts (id, company_id, workspace_id, code, name, account_type, normal_balance) values
  ('44444444-0000-0000-0000-000000001100','22222222-0000-0000-0000-00000000000a','11111111-0000-0000-0000-000000000001','1100','Bank','asset','debit'),
  ('44444444-0000-0000-0000-000000002100','22222222-0000-0000-0000-00000000000a','11111111-0000-0000-0000-000000000001','2400','Shareholder Loan','liability','credit'),
  ('44444444-0000-0000-0000-000000006100','22222222-0000-0000-0000-00000000000a','11111111-0000-0000-0000-000000000001','6100','Repairs & Maintenance','expense','debit'),
  ('44444444-0000-0000-0000-000000006200','22222222-0000-0000-0000-00000000000a','11111111-0000-0000-0000-000000000001','6200','Depreciation','expense','debit'),
  ('44444444-0000-0000-0000-000000001510','22222222-0000-0000-0000-00000000000a','11111111-0000-0000-0000-000000000001','1510','Motor Vehicles','asset','debit'),
  ('44444444-0000-0000-0000-000000001590','22222222-0000-0000-0000-00000000000a','11111111-0000-0000-0000-000000000001','1590','Accumulated Depreciation','asset','credit');

-- One account belonging to Entity B, for the cross-entity test
insert into public.accounting_accounts (id, company_id, workspace_id, code, name, account_type, normal_balance) values
  ('55555555-0000-0000-0000-000000001100','22222222-0000-0000-0000-00000000000b','11111111-0000-0000-0000-000000000001','1100','Bank (Entity B)','asset','debit');
