-- Stage 5: General Ledger and Trial Balance derived from postings.
set client_min_messages = notice;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);

-- A known, hand-checkable set of entries on a dedicated account, so the
-- expected figures are arithmetic rather than whatever the fixture happens to
-- hold. Repairs & Maintenance, three debits and one credit.
do $$
declare j1 uuid; j2 uuid; j3 uuid; j4 uuid;
begin
  j1 := t_journal('22222222-0000-0000-0000-00000000000a','2026-03-03',
        '44444444-0000-0000-0000-000000006100', 125.00,
        '44444444-0000-0000-0000-000000001100', 125.00, 'GL-1');
  j2 := t_journal('22222222-0000-0000-0000-00000000000a','2026-03-08',
        '44444444-0000-0000-0000-000000006100', 240.00,
        '44444444-0000-0000-0000-000000001100', 240.00, 'GL-2');
  j3 := t_journal('22222222-0000-0000-0000-00000000000a','2026-03-19',
        '44444444-0000-0000-0000-000000006100', 89.00,
        '44444444-0000-0000-0000-000000001100', 89.00, 'GL-3');
  perform public.accounting_post_journal(j1);
  perform public.accounting_post_journal(j2);
  perform public.accounting_post_journal(j3);

  -- An ADJUSTMENT journal, so unadjusted vs adjusted can be told apart.
  insert into public.accounting_journals (company_id, workspace_id, journal_date, reference, journal_type)
  values ('22222222-0000-0000-0000-00000000000a',
          (select workspace_id from public.companies where id='22222222-0000-0000-0000-00000000000a'),
          '2026-03-31','GL-ADJ','adjustment')
  returning id into j4;
  insert into public.accounting_journal_lines (journal_id, company_id, workspace_id, account_id, line_number, debit, credit)
  values (j4,'22222222-0000-0000-0000-00000000000a',(select workspace_id from public.companies where id='22222222-0000-0000-0000-00000000000a'),'44444444-0000-0000-0000-000000006100',1,0,54.00),
         (j4,'22222222-0000-0000-0000-00000000000a',(select workspace_id from public.companies where id='22222222-0000-0000-0000-00000000000a'),'44444444-0000-0000-0000-000000001100',2,54.00,0);
  perform public.accounting_post_journal(j4);
end $$;

-- ── TRIAL BALANCE ───────────────────────────────────────────────────────────
do $$
declare d numeric; c numeric; rep numeric; unadj numeric; adj numeric; zero_rows int;
begin
  select sum(debits), sum(credits) into d, c
  from public.accounting_trial_balance('22222222-0000-0000-0000-00000000000a', '2026-03-01','2026-03-31');
  perform t_report('§29 trial balance totals agree', d = c, format('dr=%s cr=%s diff=%s', d, c, d - c));

  select closing_balance into rep
  from public.accounting_trial_balance('22222222-0000-0000-0000-00000000000a','2026-03-01','2026-03-31')
  where code = '6100';
  -- 125 + 240 + 89 - 54 = 400
  perform t_report('§29 expense closing follows its normal balance', rep = 400.00, format('6100 closing=%s', rep));

  select closing_balance into unadj
  from public.accounting_trial_balance('22222222-0000-0000-0000-00000000000a','2026-03-01','2026-03-31', false)
  where code = '6100';
  select closing_balance into adj
  from public.accounting_trial_balance('22222222-0000-0000-0000-00000000000a','2026-03-01','2026-03-31', true)
  where code = '6100';
  -- Unadjusted excludes the 54.00 adjustment journal: 454 vs 400.
  perform t_report('§32 unadjusted excludes adjustment journals', unadj = 454.00, format('unadjusted=%s', unadj));
  perform t_report('§32 adjusted includes them', adj = 400.00, format('adjusted=%s', adj));
  perform t_report('§32 adjusted TB derives from the same ledger', (unadj - adj) = 54.00,
    format('difference=%s equals the adjustment', unadj - adj));

  -- §31 zero-balance semantics: accounts with no postings are absent, not zero.
  select count(*) into zero_rows
  from public.accounting_trial_balance('22222222-0000-0000-0000-00000000000a','2026-03-01','2026-03-31')
  where posting_count = 0;
  perform t_report('§31 accounts with no postings are not listed as zero', zero_rows = 0,
    format('zero-posting rows=%s', zero_rows));

  -- A period with no activity yields no rows at all, rather than a page of
  -- zeroes that reads like a real trial balance.
  perform t_report('§39 empty period returns no rows',
    (select count(*) from public.accounting_trial_balance('22222222-0000-0000-0000-00000000000a','2020-01-01','2020-01-31')) = 0);
end $$;

-- ── GENERAL LEDGER ──────────────────────────────────────────────────────────
do $$
declare
  balances numeric[]; total bigint; page1 int; page2 int;
  first_running numeric; opening numeric; mid_opening numeric;
begin
  -- Derived, not assumed: 6100 carries activity from earlier in the fixture, and
  -- a running balance that ignored it would be the bug. The first expectation
  -- written here hard-coded 125.00 as the opening row and failed — correctly,
  -- because the account did not start the window at zero.
  opening := public.accounting_account_opening_balance('22222222-0000-0000-0000-00000000000a','44444444-0000-0000-0000-000000006100','2026-03-01');
  select array_agg(running_balance order by posting_date) into balances
  from public.accounting_general_ledger('22222222-0000-0000-0000-00000000000a','2026-03-01','2026-03-31',
       '44444444-0000-0000-0000-000000006100', null, null, null, 100, 0);
  -- opening → +125 → +240 → +89 → −54
  perform t_report('§27 running balance accumulates per account',
    balances = array[opening+125.00, opening+365.00, opening+454.00, opening+400.00]::numeric[],
    format('opening=%s balances=%s', opening, balances::text));

  select total_rows into total
  from public.accounting_general_ledger('22222222-0000-0000-0000-00000000000a','2026-03-01','2026-03-31',
       '44444444-0000-0000-0000-000000006100', null, null, null, 2, 0) limit 1;
  perform t_report('§35 total_rows reports the full set, not the page', total = 4, format('total=%s', total));

  select count(*) into page1 from public.accounting_general_ledger('22222222-0000-0000-0000-00000000000a','2026-03-01','2026-03-31','44444444-0000-0000-0000-000000006100',null,null,null,2,0);
  select count(*) into page2 from public.accounting_general_ledger('22222222-0000-0000-0000-00000000000a','2026-03-01','2026-03-31','44444444-0000-0000-0000-000000006100',null,null,null,2,2);
  perform t_report('§35 pagination returns two pages of two', page1 = 2 and page2 = 2, format('p1=%s p2=%s', page1, page2));

  -- Page two must CONTINUE page one's balance, not restart.
  select running_balance into first_running
  from public.accounting_general_ledger('22222222-0000-0000-0000-00000000000a','2026-03-01','2026-03-31','44444444-0000-0000-0000-000000006100',null,null,null,2,2)
  order by posting_date limit 1;
  -- Page two's first row is the third entry, so it must read opening+454, not
  -- restart from its own first row.
  perform t_report('§27 page two continues the running balance', first_running = opening + 454.00,
    format('first row of page two=%s (opening %s + 454.00)', first_running, opening));

  -- Opening balance from a mid-period start date.
  -- Everything before 09 March: the account's own history plus GL-1 and GL-2.
  mid_opening := public.accounting_account_opening_balance('22222222-0000-0000-0000-00000000000a','44444444-0000-0000-0000-000000006100','2026-03-09');
  perform t_report('§27 opening balance is history before the window', mid_opening = opening + 365.00,
    format('opening at 2026-03-09=%s (= %s + 125.00 + 240.00)', mid_opening, opening));

  select running_balance into first_running
  from public.accounting_general_ledger('22222222-0000-0000-0000-00000000000a','2026-03-09','2026-03-31','44444444-0000-0000-0000-000000006100',null,null,null,10,0)
  order by posting_date limit 1;
  perform t_report('§27 a window opens from its opening balance', first_running = mid_opening + 89.00,
    format('%s opening + 89.00 = %s', mid_opening, first_running));

  -- Filters.
  perform t_report('§26 journal type filter applies',
    (select count(*) from public.accounting_general_ledger('22222222-0000-0000-0000-00000000000a','2026-03-01','2026-03-31',null,null,'adjustment',null,100,0)) = 2);
  perform t_report('§26 search matches reference',
    (select count(*) from public.accounting_general_ledger('22222222-0000-0000-0000-00000000000a','2026-03-01','2026-03-31',null,null,null,'GL-2',100,0)) = 2);
  perform t_report('§26 account type filter applies',
    (select count(*) from public.accounting_general_ledger('22222222-0000-0000-0000-00000000000a','2026-03-01','2026-03-31',null,'expense',null,null,100,0)) = 4);
end $$;

-- ── DERIVATION AND ISOLATION ────────────────────────────────────────────────
do $$
declare gl_total numeric; tb_total numeric; b_rows int; draft_rows int;
begin
  select sum(debit) into gl_total from public.accounting_general_ledger('22222222-0000-0000-0000-00000000000a',null,null,null,null,null,null,100000,0);
  select sum(debits) into tb_total from public.accounting_trial_balance('22222222-0000-0000-0000-00000000000a');
  perform t_report('§29 trial balance summarises the general ledger', gl_total = tb_total,
    format('gl=%s tb=%s', gl_total, tb_total));

  -- Entity B has no postings, so its reports are empty rather than showing A's.
  select count(*) into b_rows from public.accounting_trial_balance('22222222-0000-0000-0000-00000000000b');
  perform t_report('§40 another entity sees none of this ledger', b_rows = 0, format('entity B rows=%s', b_rows));

  -- A draft journal contributes nothing: it has no postings.
  perform t_report('§40 draft journals are absent from the ledger',
    (select count(*) from public.accounting_general_ledger('22222222-0000-0000-0000-00000000000a',null,null,null,null,null,'JV-002',100,0)) = 0,
    'JV-002 is the unbalanced draft');

  -- A reversal is visible in history AND nets to zero.
  perform t_report('§40 reversed entries remain visible in the ledger',
    (select count(*) from public.accounting_general_ledger('22222222-0000-0000-0000-00000000000a',null,null,null,null,'reversal',null,100,0)) > 0);
end $$;

-- ── §28 SOURCE TRACEABILITY: ledger line → transaction → statement ──────────
do $$
declare
  ws uuid; doc_id uuid; run_id uuid; txn_id uuid; jid uuid;
  traced_run uuid; traced_txn uuid; manual_run uuid; surviving int;
begin
  select workspace_id into ws from public.companies where id = '22222222-0000-0000-0000-00000000000a';
  insert into public.documents (workspace_id, owner_id, name, storage_path, mime_type, size_bytes)
  values (ws, '00000000-0000-0000-0000-0000000000a1','trace.pdf','ws/trace.pdf','application/pdf',10)
  returning id into doc_id;
  insert into public.accounting_statement_runs (workspace_id, document_id, bank, status, source_storage_path)
  values (ws, doc_id, 'FNB', 'completed', 'ws/trace.pdf') returning id into run_id;
  insert into public.accounting_transactions (run_id, workspace_id, transaction_date, description, debit_amount)
  values (run_id, ws, '2026-04-02', 'Bank charge', 60.00) returning id into txn_id;

  jid := t_journal('22222222-0000-0000-0000-00000000000a','2026-04-02',
        '44444444-0000-0000-0000-000000006100', 60.00,
        '44444444-0000-0000-0000-000000001100', 60.00, 'TRACE-1');
  update public.accounting_journal_lines set source_transaction_id = txn_id
   where journal_id = jid and debit > 0;
  perform public.accounting_post_journal(jid);

  select source_run_id, source_transaction_id into traced_run, traced_txn
  from public.accounting_general_ledger('22222222-0000-0000-0000-00000000000a','2026-04-01','2026-04-30',
       '44444444-0000-0000-0000-000000006100', null, null, null, 10, 0)
  limit 1;

  perform t_report('§28 ledger line names its source transaction', traced_txn = txn_id);
  perform t_report('§28 ledger line reaches the source statement', traced_run = run_id);

  -- A manual journal has no source, and must still appear in the ledger.
  select source_run_id into manual_run
  from public.accounting_general_ledger('22222222-0000-0000-0000-00000000000a','2026-03-01','2026-03-31',
       '44444444-0000-0000-0000-000000006100', null, null, 'GL-1', 10, 0) limit 1;
  perform t_report('§28 a manual journal has no source and still reports', manual_run is null);

  -- Deleting the statement leaves the ledger line, without its evidence.
  delete from public.accounting_statement_runs where id = run_id;
  select count(*) into surviving from public.accounting_general_ledger('22222222-0000-0000-0000-00000000000a','2026-04-01','2026-04-30','44444444-0000-0000-0000-000000006100',null,null,null,10,0);
  select source_run_id into traced_run from public.accounting_general_ledger('22222222-0000-0000-0000-00000000000a','2026-04-01','2026-04-30','44444444-0000-0000-0000-000000006100',null,null,null,10,0) limit 1;
  perform t_report('§28 ledger survives the statement being deleted', surviving = 1,
    format('rows still reported=%s', surviving));
  perform t_report('§28 evidence link is dropped, not the entry', traced_run is null);
end $$;
