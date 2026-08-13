-- §20 one controlled posting gate, §12 source deletion (corrected),
-- §21/§22 proofs.
set client_min_messages = notice;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);

-- ── §20 DIRECT INSERT MUST BE REFUSED ───────────────────────────────────────
do $$
declare jid uuid; blocked boolean := false; msg text; before_rows int; after_rows int;
begin
  jid := t_journal('22222222-0000-0000-0000-00000000000a', '2025-12-05',
                   '44444444-0000-0000-0000-000000006100', 125.00,
                   '44444444-0000-0000-0000-000000001100', 125.00, 'JV-GATE');
  perform public.accounting_post_journal(jid);
  select count(*) into before_rows from public.accounting_postings;

  -- One leg only, straight into the ledger. This is what put the trial balance
  -- out of balance during the first verification run.
  begin
    insert into public.accounting_postings
      (company_id, workspace_id, journal_id, journal_line_id, account_id, posting_date, debit, credit)
    select company_id, workspace_id, journal_id, id, account_id, '2025-12-05', debit, credit
    from public.accounting_journal_lines where journal_id = jid and debit > 0;
  exception when others then blocked := true; msg := sqlerrm;
  end;

  select count(*) into after_rows from public.accounting_postings;
  perform t_report('§20 direct INSERT into the ledger is refused', blocked, coalesce(msg, 'ACCEPTED'));
  perform t_report('§20 ledger row count unchanged', before_rows = after_rows,
    format('before=%s after=%s', before_rows, after_rows));
end $$;

-- ── §20b THE GATE DOES NOT LEAK ACROSS STATEMENTS ───────────────────────────
do $$
declare jid uuid; blocked boolean := false;
begin
  jid := t_journal('22222222-0000-0000-0000-00000000000a', '2025-12-06',
                   '44444444-0000-0000-0000-000000006100', 10.00,
                   '44444444-0000-0000-0000-000000001100', 10.00, 'JV-GATE2');
  perform public.accounting_post_journal(jid);
  -- Immediately after a legitimate post, in the same transaction.
  begin
    insert into public.accounting_postings
      (company_id, workspace_id, journal_id, journal_line_id, account_id, posting_date, debit, credit)
    select company_id, workspace_id, journal_id, id, account_id, '2025-12-06', 1.00, 0
    from public.accounting_journal_lines where journal_id = jid limit 1;
  exception when others then blocked := true;
  end;
  perform t_report('§20b gate closes again after a legitimate post', blocked);
end $$;

-- ── §12 SOURCE DELETION (corrected: delete the transaction, not the doc) ─────
do $$
declare
  ws uuid; doc_id uuid; run_id uuid; txn_id uuid; jid uuid;
  linked_before boolean; survived int; nulled boolean; amount_intact numeric;
begin
  select workspace_id into ws from public.companies where id = '22222222-0000-0000-0000-00000000000a';

  insert into public.documents (workspace_id, owner_id, name, storage_path, mime_type, size_bytes)
  values (ws, '00000000-0000-0000-0000-0000000000a1', 'statement.pdf', 'ws/statement.pdf', 'application/pdf', 1024)
  returning id into doc_id;
  insert into public.accounting_statement_runs (workspace_id, document_id, bank, status, source_storage_path)
  values (ws, doc_id, 'FNB', 'completed', 'ws/statement.pdf') returning id into run_id;
  insert into public.accounting_transactions (run_id, workspace_id, transaction_date, description, debit_amount)
  values (run_id, ws, '2025-12-01', 'Bank charge', 125.00) returning id into txn_id;

  -- The link now rides on the journal LINE, so the gate carries it to the ledger.
  jid := t_journal('22222222-0000-0000-0000-00000000000a', '2025-12-01',
                   '44444444-0000-0000-0000-000000006100', 125.00,
                   '44444444-0000-0000-0000-000000001100', 125.00, 'JV-SOURCE');
  update public.accounting_journal_lines set source_transaction_id = txn_id
   where journal_id = jid and debit > 0;
  perform public.accounting_post_journal(jid);

  select exists (select 1 from public.accounting_postings
                 where journal_id = jid and source_transaction_id = txn_id) into linked_before;
  perform t_report('§12 posting carries its source link', linked_before);

  -- Delete the source run, which cascades to its transactions.
  delete from public.accounting_statement_runs where id = run_id;

  select count(*) into survived from public.accounting_postings where journal_id = jid;
  select bool_and(source_transaction_id is null) into nulled
    from public.accounting_postings where journal_id = jid;
  select sum(debit) into amount_intact from public.accounting_postings where journal_id = jid;

  perform t_report('§12 source transaction deleted',
    not exists (select 1 from public.accounting_transactions where id = txn_id));
  perform t_report('§12 postings survive', survived = 2, format('rows=%s', survived));
  perform t_report('§12 journal survives', exists (select 1 from public.accounting_journals where id = jid));
  perform t_report('§12 source reference SET NULL, not cascaded', nulled);
  perform t_report('§12 posting amount unchanged', amount_intact = 125.00, format('debit=%s', amount_intact));
end $$;
