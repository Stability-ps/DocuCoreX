-- Stage 6B: tax codes and VAT derived from postings.
set client_min_messages = notice;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);

-- ── SEEDED CODES ────────────────────────────────────────────────────────────
do $$
declare seeded int; mapped int; unmapped int;
begin
  select count(*) into seeded from public.accounting_tax_codes
   where company_id = '22222222-0000-0000-0000-00000000000a';
  perform t_report('tax codes are seeded per entity', seeded = 7, format('codes=%s', seeded));

  -- 1200 and 2200 exist in this entity's chart, so the VAT-bearing codes map.
  select count(*) into mapped from public.accounting_tax_codes
   where company_id = '22222222-0000-0000-0000-00000000000a' and control_account_id is not null;
  perform t_report('VAT-bearing codes resolve a control account', mapped = 4, format('mapped=%s', mapped));

  -- Zero-rated, exempt and non-supply arise no VAT, so they have none.
  select count(*) into unmapped from public.accounting_tax_codes
   where company_id = '22222222-0000-0000-0000-00000000000a'
     and direction = 'none' and control_account_id is null;
  perform t_report('codes that arise no VAT have no control account', unmapped = 3);

  perform t_report('direction is not derived from the rate',
    (select count(distinct direction) from public.accounting_tax_codes
      where company_id='22222222-0000-0000-0000-00000000000a' and rate = 0) = 1
    and (select count(*) from public.accounting_tax_codes
          where company_id='22222222-0000-0000-0000-00000000000a' and rate = 0) = 3,
    'zero-rated output and exempt both carry 0%');
end $$;

-- ── LEGACY LABELS ARE A SUGGESTION, NEVER AN APPLICATION ────────────────────
do $$
declare suggested int; applied int;
begin
  select count(*) into suggested from public.accounting_tax_codes
   where company_id = '22222222-0000-0000-0000-00000000000a' and suggested_for_treatment is not null;
  perform t_report('legacy treatments map to a suggested code', suggested = 5, format('suggestions=%s', suggested));

  -- 'standard' maps to BOTH STD-OUT and STD-IN, and that ambiguity is the
  -- argument against applying these labels automatically: the legacy value
  -- records that VAT applied, not whether it was charged or incurred.
  perform t_report('the legacy standard label cannot tell output from input',
    (select count(*) from public.accounting_tax_codes
      where company_id='22222222-0000-0000-0000-00000000000a'
        and suggested_for_treatment = 'standard') = 2,
    'one label, two possible codes');

  -- No posting acquired a tax code from its legacy label. Those labels came
  -- from a classifier, not an accountant, and applying them would turn
  -- thousands of guesses into a VAT return.
  select count(*) into applied from public.accounting_postings
   where company_id = '22222222-0000-0000-0000-00000000000a'
     and tax_code_id is not null;
  perform t_report('no historic posting was silently given a tax code', applied = 0,
    format('postings with a tax code=%s', applied));
end $$;

-- ── VAT IS A POSTING, NOT A CALCULATION ─────────────────────────────────────
do $$
declare
  ws uuid; std_in uuid; vat_ctrl uuid; jid uuid;
  net numeric; vat numeric; out_total numeric; in_total numeric;
begin
  select workspace_id into ws from public.companies where id = '22222222-0000-0000-0000-00000000000a';
  select id into std_in from public.accounting_tax_codes
   where company_id='22222222-0000-0000-0000-00000000000a' and code='STD-IN';
  select control_account_id into vat_ctrl from public.accounting_tax_codes where id = std_in;

  -- Dr Repairs 869.57 / Dr VAT Input 130.43 / Cr Bank 1000.00
  insert into public.accounting_journals (company_id, workspace_id, journal_date, reference)
  values ('22222222-0000-0000-0000-00000000000a', ws, '2026-05-10', 'VAT-1') returning id into jid;
  insert into public.accounting_journal_lines
    (journal_id, company_id, workspace_id, account_id, line_number, debit, credit, tax_code_id)
  values
    (jid,'22222222-0000-0000-0000-00000000000a',ws,'44444444-0000-0000-0000-000000006100',1, 869.57, 0, std_in),
    (jid,'22222222-0000-0000-0000-00000000000a',ws, vat_ctrl,                              2, 130.43, 0, std_in),
    (jid,'22222222-0000-0000-0000-00000000000a',ws,'44444444-0000-0000-0000-000000001100',3, 0, 1000.00, null);
  perform public.accounting_post_journal(jid);

  select net_amount, vat_amount into net, vat
  from public.accounting_vat_summary('22222222-0000-0000-0000-00000000000a','2026-05-01','2026-05-31')
  where code = 'STD-IN';

  perform t_report('taxable value is the non-control leg', net = 869.57, format('net=%s', net));
  perform t_report('VAT is the amount posted to the control account', vat = 130.43, format('vat=%s', vat));
  perform t_report('net + VAT equals the inclusive amount', net + vat = 1000.00, format('total=%s', net + vat));

  -- The report must NOT re-derive VAT from the rate. Posting a deliberately
  -- non-15% split has to be reported as posted, not silently corrected.
  insert into public.accounting_journals (company_id, workspace_id, journal_date, reference)
  values ('22222222-0000-0000-0000-00000000000a', ws, '2026-05-20', 'VAT-ODD') returning id into jid;
  insert into public.accounting_journal_lines
    (journal_id, company_id, workspace_id, account_id, line_number, debit, credit, tax_code_id)
  values
    (jid,'22222222-0000-0000-0000-00000000000a',ws,'44444444-0000-0000-0000-000000006100',1, 900.00, 0, std_in),
    (jid,'22222222-0000-0000-0000-00000000000a',ws, vat_ctrl,                              2, 100.00, 0, std_in),
    (jid,'22222222-0000-0000-0000-00000000000a',ws,'44444444-0000-0000-0000-000000001100',3, 0, 1000.00, null);
  perform public.accounting_post_journal(jid);

  select vat_amount into vat
  from public.accounting_vat_summary('22222222-0000-0000-0000-00000000000a','2026-05-01','2026-05-31')
  where code = 'STD-IN';
  -- 130.43 + 100.00 posted. A rate-based report would have said 15/115 of 1900.
  perform t_report('VAT reports what was posted, not what the rate implies',
    vat = 230.43, format('vat=%s (a rate-based figure would be %s)', vat, round(1900 * 15 / 115.0, 2)));
end $$;

-- ── OUTPUT VS INPUT, AND THE NET POSITION ───────────────────────────────────
do $$
declare ws uuid; std_out uuid; ctrl uuid; jid uuid; out_vat numeric; in_vat numeric;
begin
  select workspace_id into ws from public.companies where id = '22222222-0000-0000-0000-00000000000a';
  select id, control_account_id into std_out, ctrl from public.accounting_tax_codes
   where company_id='22222222-0000-0000-0000-00000000000a' and code='STD-OUT';

  -- Dr Bank 5750 / Cr Sales 5000 / Cr VAT Output 750
  insert into public.accounting_journals (company_id, workspace_id, journal_date, reference)
  values ('22222222-0000-0000-0000-00000000000a', ws, '2026-05-25', 'VAT-OUT') returning id into jid;
  insert into public.accounting_journal_lines
    (journal_id, company_id, workspace_id, account_id, line_number, debit, credit, tax_code_id)
  values
    (jid,'22222222-0000-0000-0000-00000000000a',ws,'44444444-0000-0000-0000-000000001100',1, 5750.00, 0, null),
    (jid,'22222222-0000-0000-0000-00000000000a',ws,'44444444-0000-0000-0000-000000002100',2, 0, 5000.00, std_out),
    (jid,'22222222-0000-0000-0000-00000000000a',ws, ctrl,                                  3, 0,  750.00, std_out);
  perform public.accounting_post_journal(jid);

  select coalesce(sum(vat_amount),0) into out_vat
  from public.accounting_vat_summary('22222222-0000-0000-0000-00000000000a','2026-05-01','2026-05-31')
  where direction = 'output';
  select coalesce(sum(vat_amount),0) into in_vat
  from public.accounting_vat_summary('22222222-0000-0000-0000-00000000000a','2026-05-01','2026-05-31')
  where direction = 'input';

  perform t_report('output VAT is summed separately', out_vat = 750.00, format('output=%s', out_vat));
  perform t_report('input VAT is summed separately', in_vat = 230.43, format('input=%s', in_vat));
  perform t_report('net VAT position is output less input', (out_vat - in_vat) = 519.57,
    format('net payable=%s', out_vat - in_vat));
end $$;

-- ── UNUSED CODES ARE ABSENT, NOT NIL ────────────────────────────────────────
do $$
declare rows_returned int;
begin
  select count(*) into rows_returned
  from public.accounting_vat_summary('22222222-0000-0000-0000-00000000000a','2026-05-01','2026-05-31');
  perform t_report('a code with no postings is not a nil return line', rows_returned = 2,
    format('codes reported=%s of 7 seeded', rows_returned));

  perform t_report('a period with no VAT activity reports nothing',
    (select count(*) from public.accounting_vat_summary('22222222-0000-0000-0000-00000000000a','2019-01-01','2019-01-31')) = 0);
end $$;

-- ── VAT REGISTER ────────────────────────────────────────────────────────────
do $$
declare control_legs int; total bigint;
begin
  select count(*) into control_legs
  from public.accounting_vat_register('22222222-0000-0000-0000-00000000000a','2026-05-01','2026-05-31',500,0)
  where is_control_leg;
  perform t_report('the register distinguishes the VAT leg', control_legs = 3, format('control legs=%s', control_legs));

  select total_rows into total
  from public.accounting_vat_register('22222222-0000-0000-0000-00000000000a','2026-05-01','2026-05-31',2,0) limit 1;
  perform t_report('the register pages server-side', total = 6, format('total=%s', total));
end $$;

-- ── LOCKED VAT PERIOD ───────────────────────────────────────────────────────
do $$
declare
  ws uuid; std_in uuid; ctrl uuid; jid uuid; blocked boolean := false; msg text;
  plain_ok text;
begin
  select workspace_id into ws from public.companies where id = '22222222-0000-0000-0000-00000000000a';
  select id, control_account_id into std_in, ctrl from public.accounting_tax_codes
   where company_id='22222222-0000-0000-0000-00000000000a' and code='STD-IN';

  insert into public.accounting_vat_periods
    (company_id, workspace_id, period_start, period_end, status, declared_output_vat, declared_input_vat)
  values ('22222222-0000-0000-0000-00000000000a', ws, '2026-05-01','2026-06-30','locked', 750.00, 230.43);

  -- A VAT-bearing journal into a filed period is refused.
  insert into public.accounting_journals (company_id, workspace_id, journal_date, reference)
  values ('22222222-0000-0000-0000-00000000000a', ws, '2026-06-10', 'VAT-LATE') returning id into jid;
  insert into public.accounting_journal_lines
    (journal_id, company_id, workspace_id, account_id, line_number, debit, credit, tax_code_id)
  values
    (jid,'22222222-0000-0000-0000-00000000000a',ws,'44444444-0000-0000-0000-000000006100',1, 87.00, 0, std_in),
    (jid,'22222222-0000-0000-0000-00000000000a',ws, ctrl,                                  2, 13.00, 0, std_in),
    (jid,'22222222-0000-0000-0000-00000000000a',ws,'44444444-0000-0000-0000-000000001100',3, 0, 100.00, null);
  begin
    perform public.accounting_post_journal(jid);
  exception when others then blocked := true; msg := sqlerrm;
  end;
  perform t_report('a VAT-bearing journal is refused in a locked VAT period', blocked,
    coalesce(substr(msg,1,70),'ACCEPTED'));

  -- A journal with NO tax code changes no VAT figure and must still post:
  -- blocking it would stop ordinary bookkeeping in a filed period.
  jid := t_journal('22222222-0000-0000-0000-00000000000a','2026-06-11',
        '44444444-0000-0000-0000-000000006100', 50.00,
        '44444444-0000-0000-0000-000000001100', 50.00, 'NONVAT-LATE');
  perform public.accounting_post_journal(jid);
  select status into plain_ok from public.accounting_journals where id = jid;
  perform t_report('a non-VAT journal still posts in a locked VAT period', plain_ok = 'posted',
    format('status=%s', plain_ok));
end $$;

-- ── VAT PERIODS DO NOT OVERLAP ──────────────────────────────────────────────
do $$
declare ws uuid; overlapped boolean := false;
begin
  select workspace_id into ws from public.companies where id = '22222222-0000-0000-0000-00000000000a';
  begin
    insert into public.accounting_vat_periods (company_id, workspace_id, period_start, period_end, status)
    values ('22222222-0000-0000-0000-00000000000a', ws, '2026-06-01','2026-07-31','submitted');
  exception when others then overlapped := true;
  end;
  perform t_report('VAT periods cannot overlap for one entity', overlapped);
end $$;
