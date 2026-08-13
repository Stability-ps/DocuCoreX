-- Stage 6A: bank reconciliation.
set client_min_messages = notice;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);

-- ── CONTROL MAPPING ─────────────────────────────────────────────────────────
do $$
declare ws uuid; bank_a uuid; cross_entity boolean := false; msg text; dup boolean := false;
begin
  select workspace_id into ws from public.companies where id = '22222222-0000-0000-0000-00000000000a';

  insert into public.accounting_bank_accounts (company_id, workspace_id, bank_name, account_number, label, ledger_account_id)
  values ('22222222-0000-0000-0000-00000000000a', ws, 'FNB', '62905786151', 'FNB Business',
          '44444444-0000-0000-0000-000000001100')
  returning id into bank_a;
  perform t_report('§2 bank account maps to a ledger account', bank_a is not null);

  -- Entity A bank account may not map to Entity B's ledger account.
  begin
    insert into public.accounting_bank_accounts (company_id, workspace_id, bank_name, account_number, label, ledger_account_id)
    values ('22222222-0000-0000-0000-00000000000a', ws, 'FNB', '999', 'Cross entity',
            '55555555-0000-0000-0000-000000001100');
  exception when others then cross_entity := true; msg := sqlerrm;
  end;
  perform t_report('§2 cross-entity mapping is refused', cross_entity, coalesce(msg, 'ACCEPTED'));

  -- The same account number cannot be mapped twice for one entity.
  begin
    insert into public.accounting_bank_accounts (company_id, workspace_id, bank_name, account_number, label, ledger_account_id)
    values ('22222222-0000-0000-0000-00000000000a', ws, 'FNB', ' 62905786151 ', 'Duplicate',
            '44444444-0000-0000-0000-000000001100');
  exception when others then dup := true;
  end;
  perform t_report('§2 duplicate account number refused, ignoring spacing', dup);

  -- An account identified by neither name nor number cannot be matched at all.
  dup := false;
  begin
    insert into public.accounting_bank_accounts (company_id, workspace_id, label, ledger_account_id)
    values ('22222222-0000-0000-0000-00000000000a', ws, 'Nameless', '44444444-0000-0000-0000-000000001100');
  exception when others then dup := true;
  end;
  perform t_report('§2 an unidentifiable bank account is refused', dup);
end $$;

-- ── LEDGER BALANCE IS DERIVED, NOT STORED ───────────────────────────────────
do $$
declare bank_a uuid; derived numeric; direct numeric;
begin
  select id into bank_a from public.accounting_bank_accounts where account_number = '62905786151';
  derived := public.accounting_bank_ledger_balance(bank_a, '2026-12-31');
  select coalesce(sum(p.debit - p.credit), 0) into direct
  from public.accounting_postings p
  where p.account_id = '44444444-0000-0000-0000-000000001100' and p.posting_date <= '2026-12-31';

  perform t_report('§1 ledger balance derives from postings', derived = direct,
    format('derived=%s direct=%s', derived, direct));
  perform t_report('§1 no ledger balance column is stored on the mapping',
    not exists (
      select 1 from information_schema.columns
      where table_name = 'accounting_bank_accounts' and column_name like '%balance%'
    ));
end $$;

-- ── COMPLETION RULE ─────────────────────────────────────────────────────────
do $$
declare
  ws uuid; bank_a uuid; rec_id uuid; ledger numeric;
  refused_zero boolean := false; refused_missing boolean := false; msg text;
  completed_status text; run_id uuid; doc_id uuid; txn_id uuid; jid uuid;
begin
  select workspace_id into ws from public.companies where id = '22222222-0000-0000-0000-00000000000a';
  select id into bank_a from public.accounting_bank_accounts where account_number = '62905786151';
  ledger := public.accounting_bank_ledger_balance(bank_a, '2026-12-31');

  insert into public.accounting_reconciliations (company_id, workspace_id, bank_account_id, period_start, period_end)
  values ('22222222-0000-0000-0000-00000000000a', ws, bank_a, '2026-12-01', '2026-12-31')
  returning id into rec_id;

  -- A statement balance that does not agree, with nothing explaining it.
  begin
    perform public.accounting_complete_reconciliation(rec_id, ledger + 6250.00);
  exception when others then refused_zero := true; msg := sqlerrm;
  end;
  perform t_report('§9 unexplained difference cannot be completed', refused_zero,
    coalesce(substr(msg, 1, 70), 'ACCEPTED'));
  select status into completed_status from public.accounting_reconciliations where id = rec_id;
  perform t_report('§9 reconciliation stays in progress', completed_status = 'in_progress');

  -- A missing posting is an accounting error, not a reconciling item: even when
  -- the arithmetic would work out, completion must refuse.
  insert into public.documents (workspace_id, owner_id, name, storage_path, mime_type, size_bytes)
  values (ws, '00000000-0000-0000-0000-0000000000a1','rec.pdf','ws/rec.pdf','application/pdf',10) returning id into doc_id;
  insert into public.accounting_statement_runs (workspace_id, document_id, bank, status, source_storage_path)
  values (ws, doc_id, 'FNB', 'completed', 'ws/rec.pdf') returning id into run_id;
  insert into public.accounting_transactions (run_id, workspace_id, transaction_date, description, debit_amount)
  values (run_id, ws, '2026-12-15', 'Bank charge not yet posted', 125.00) returning id into txn_id;

  insert into public.accounting_reconciliation_items
    (reconciliation_id, company_id, workspace_id, transaction_id, item_type)
  values (rec_id, '22222222-0000-0000-0000-00000000000a', ws, txn_id, 'missing_posting');

  begin
    perform public.accounting_complete_reconciliation(rec_id, ledger);
  exception when others then refused_missing := true; msg := sqlerrm;
  end;
  perform t_report('§7 a missing posting blocks completion', refused_missing,
    coalesce(substr(msg, 1, 74), 'ACCEPTED'));

  -- Resolving it through the JOURNAL ENGINE — not by inserting a posting.
  jid := t_journal('22222222-0000-0000-0000-00000000000a','2026-12-15',
        '44444444-0000-0000-0000-000000006100', 125.00,
        '44444444-0000-0000-0000-000000001100', 125.00, 'REC-FIX');
  perform public.accounting_post_journal(jid);
  update public.accounting_reconciliation_items
     set resolving_journal_id = jid, item_type = 'matched'
   where reconciliation_id = rec_id and transaction_id = txn_id;

  -- The ledger has moved by the correcting journal, so re-derive.
  ledger := public.accounting_bank_ledger_balance(bank_a, '2026-12-31');
  perform public.accounting_complete_reconciliation(rec_id, ledger);
  select status into completed_status from public.accounting_reconciliations where id = rec_id;
  perform t_report('§9 completes once the difference is explained', completed_status = 'completed');
  perform t_report('§9 both balances are recorded at completion',
    (select statement_balance is not null and ledger_balance_at_completion is not null
     from public.accounting_reconciliations where id = rec_id));
end $$;

-- ── A COMPLETED RECONCILIATION IS FROZEN ────────────────────────────────────
do $$
declare rec_id uuid; frozen boolean := false; second_complete boolean := false;
begin
  select id into rec_id from public.accounting_reconciliations where status = 'completed' limit 1;
  begin
    update public.accounting_reconciliation_items set note = 'tampered' where reconciliation_id = rec_id;
  exception when others then frozen := true;
  end;
  perform t_report('§9 completed reconciliation items are frozen', frozen);

  begin
    perform public.accounting_complete_reconciliation(rec_id, 0);
  exception when others then second_complete := true;
  end;
  perform t_report('§9 cannot be completed twice', second_complete);
end $$;

-- ── ITEM INTEGRITY ──────────────────────────────────────────────────────────
do $$
declare ws uuid; bank_a uuid; rec_id uuid; no_side boolean := false; dup_txn boolean := false; txn uuid;
begin
  select workspace_id into ws from public.companies where id = '22222222-0000-0000-0000-00000000000a';
  select id into bank_a from public.accounting_bank_accounts where account_number = '62905786151';
  insert into public.accounting_reconciliations (company_id, workspace_id, bank_account_id, period_start, period_end)
  values ('22222222-0000-0000-0000-00000000000a', ws, bank_a, '2027-01-01', '2027-01-31') returning id into rec_id;

  begin
    insert into public.accounting_reconciliation_items (reconciliation_id, company_id, workspace_id, item_type)
    values (rec_id, '22222222-0000-0000-0000-00000000000a', ws, 'matched');
  exception when others then no_side := true;
  end;
  perform t_report('§5 an item referencing neither side is refused', no_side);

  select id into txn from public.accounting_transactions limit 1;
  insert into public.accounting_reconciliation_items (reconciliation_id, company_id, workspace_id, transaction_id, item_type)
  values (rec_id, '22222222-0000-0000-0000-00000000000a', ws, txn, 'timing_difference');
  begin
    insert into public.accounting_reconciliation_items (reconciliation_id, company_id, workspace_id, transaction_id, item_type)
    values (rec_id, '22222222-0000-0000-0000-00000000000a', ws, txn, 'matched');
  exception when others then dup_txn := true;
  end;
  perform t_report('§5 a bank item cannot be reconciled twice in one period', dup_txn);
end $$;
