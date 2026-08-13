-- Reporting and journal-building helpers for the Stage 4B ledger battery.
set client_min_messages = notice;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);

create or replace function t_report(name text, passed boolean, detail text default '')
returns void language plpgsql as $$
begin
  raise notice '%  %  %', case when passed then 'PASS' else 'FAIL' end, rpad(name, 46), detail;
end $$;

-- Build a two-line journal and return its id. Kept deliberately dumb: it does
-- NOT balance anything, so a test can hand it an unbalanced pair on purpose.
create or replace function t_journal(
  company uuid, jdate date, acct_dr uuid, amt_dr numeric,
  acct_cr uuid, amt_cr numeric, jref text default 'T'
) returns uuid language plpgsql as $$
declare jid uuid; ws uuid;
begin
  select workspace_id into ws from public.companies where id = company;
  insert into public.accounting_journals (company_id, workspace_id, journal_date, reference, description)
  values (company, ws, jdate, jref, 'stage 4b test') returning id into jid;
  insert into public.accounting_journal_lines (journal_id, company_id, workspace_id, account_id, line_number, debit, credit)
  values (jid, company, ws, acct_dr, 1, amt_dr, 0),
         (jid, company, ws, acct_cr, 2, 0, amt_cr);
  return jid;
end $$;
