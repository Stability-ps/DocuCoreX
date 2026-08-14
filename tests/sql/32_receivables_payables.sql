-- Stage 7B: accounts receivable and accounts payable — tagging, allocation, ageing.
set client_min_messages = notice;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);

-- ── SET UP: control accounts and two customers ──────────────────────────────
do $$
declare ws uuid; ar_acct uuid; ap_acct uuid;
begin
  select workspace_id into ws from public.companies where id = '22222222-0000-0000-0000-00000000000a';

  insert into public.accounting_accounts (company_id, workspace_id, code, name, account_type, normal_balance)
  values ('22222222-0000-0000-0000-00000000000a', ws, '1400', 'Accounts Receivable', 'asset', 'debit')
  returning id into ar_acct;
  insert into public.accounting_accounts (company_id, workspace_id, code, name, account_type, normal_balance)
  values ('22222222-0000-0000-0000-00000000000a', ws, '2450', 'Accounts Payable', 'liability', 'credit')
  returning id into ap_acct;

  update public.accounting_entity_settings
  set ar_control_account_id = ar_acct, ap_control_account_id = ap_acct
  where company_id = '22222222-0000-0000-0000-00000000000a';

  insert into public.accounting_customers (id, company_id, workspace_id, name)
  values ('66666666-0000-0000-0000-000000000001', '22222222-0000-0000-0000-00000000000a', ws, 'Customer X'),
         ('66666666-0000-0000-0000-000000000002', '22222222-0000-0000-0000-00000000000a', ws, 'Customer Y');
  insert into public.accounting_suppliers (id, company_id, workspace_id, name)
  values ('77777777-0000-0000-0000-000000000001', '22222222-0000-0000-0000-00000000000a', ws, 'Supplier X');

  perform t_report('§32 AR and AP control accounts are set', ar_acct is not null and ap_acct is not null);
end $$;

-- ── THE TAGGING GATE ─────────────────────────────────────────────────────────
do $$
declare ar_acct uuid; ap_acct uuid; jid uuid; refused boolean := false; msg text;
begin
  select ar_control_account_id, ap_control_account_id into ar_acct, ap_acct
  from public.accounting_entity_settings where company_id = '22222222-0000-0000-0000-00000000000a';

  -- An untagged line to the AR control account is refused at post time.
  jid := t_journal('22222222-0000-0000-0000-00000000000a', '2026-10-01', ar_acct, 100.00,
    '44444444-0000-0000-0000-000000006100', 100.00, 'AR-UNTAGGED');
  begin
    perform public.accounting_post_journal(jid);
  exception when others then refused := true; msg := sqlerrm;
  end;
  perform t_report('§32 an untagged AR control line is refused', refused, coalesce(msg, 'ACCEPTED'));

  -- Tagging it lets it through.
  update public.accounting_journal_lines set customer_id = '66666666-0000-0000-0000-000000000001'
  where journal_id = jid and account_id = ar_acct;
  perform public.accounting_post_journal(jid);
  perform t_report('§32 a tagged AR control line posts', (select status from public.accounting_journals where id = jid) = 'posted');

  -- Same for AP, with a supplier.
  refused := false; msg := null;
  jid := t_journal('22222222-0000-0000-0000-00000000000a', '2026-10-01',
    '44444444-0000-0000-0000-000000006100', 50.00, ap_acct, 50.00, 'AP-UNTAGGED');
  begin
    perform public.accounting_post_journal(jid);
  exception when others then refused := true; msg := sqlerrm;
  end;
  perform t_report('§32 an untagged AP control line is refused', refused, coalesce(msg, 'ACCEPTED'));

  update public.accounting_journal_lines set supplier_id = '77777777-0000-0000-0000-000000000001'
  where journal_id = jid and account_id = ap_acct;
  perform public.accounting_post_journal(jid);
  perform t_report('§32 a tagged AP control line posts', (select status from public.accounting_journals where id = jid) = 'posted');
end $$;

-- ── CROSS-ENTITY CUSTOMER TAG IS REFUSED AT INSERT ──────────────────────────
do $$
declare ws_b uuid; refused boolean := false;
begin
  select workspace_id into ws_b from public.companies where id = '22222222-0000-0000-0000-00000000000b';
  begin
    insert into public.accounting_journal_lines (journal_id, company_id, workspace_id, account_id, line_number, debit, credit, customer_id)
    select id, '22222222-0000-0000-0000-00000000000b', ws_b, '55555555-0000-0000-0000-000000001100', 99, 1, 0,
           '66666666-0000-0000-0000-000000000001'  -- Entity A's customer
    from public.accounting_journals limit 1;
  exception when others then refused := true;
  end;
  perform t_report('§32 a customer from another entity cannot be tagged on a line', refused);
end $$;

-- ── ALLOCATION: THE FULL LIFECYCLE ──────────────────────────────────────────
do $$
declare
  ar_acct uuid; invoice_jid uuid; receipt_jid uuid;
  invoice_posting uuid; receipt_posting uuid;
  alloc_id uuid; remaining_outstanding numeric; refused boolean := false; msg text;
begin
  select ar_control_account_id into ar_acct
  from public.accounting_entity_settings where company_id = '22222222-0000-0000-0000-00000000000a';

  -- Invoice: Dr AR control 1000, Cr Revenue 1000, for Customer X.
  invoice_jid := t_journal('22222222-0000-0000-0000-00000000000a', '2026-10-05', ar_acct, 1000.00,
    (select id from public.accounting_accounts where company_id = '22222222-0000-0000-0000-00000000000a' and code = '4000'),
    1000.00, 'INV-X-1');
  update public.accounting_journal_lines set customer_id = '66666666-0000-0000-0000-000000000001' where journal_id = invoice_jid and account_id = ar_acct;
  perform public.accounting_post_journal(invoice_jid);
  select id into invoice_posting from public.accounting_postings where journal_id = invoice_jid and account_id = ar_acct;

  -- Receipt: Dr Bank, Cr AR control 600, for Customer X.
  receipt_jid := t_journal('22222222-0000-0000-0000-00000000000a', '2026-10-10',
    '44444444-0000-0000-0000-000000001100', 600.00, ar_acct, 600.00, 'RCPT-X-1');
  update public.accounting_journal_lines set customer_id = '66666666-0000-0000-0000-000000000001' where journal_id = receipt_jid and account_id = ar_acct;
  perform public.accounting_post_journal(receipt_jid);
  select id into receipt_posting from public.accounting_postings where journal_id = receipt_jid and account_id = ar_acct;

  select outstanding into remaining_outstanding from public.accounting_ar_open_items('22222222-0000-0000-0000-00000000000a', '2026-10-31') where posting_id = invoice_posting;
  perform t_report('§32 an unallocated invoice is fully outstanding', remaining_outstanding = 1000.00, format('outstanding=%s', remaining_outstanding));

  -- Partial allocation.
  alloc_id := public.accounting_allocate_ar(invoice_posting, receipt_posting, 600.00);
  perform t_report('§32 a valid allocation is recorded', alloc_id is not null);

  select outstanding into remaining_outstanding from public.accounting_ar_open_items('22222222-0000-0000-0000-00000000000a', '2026-10-31') where posting_id = invoice_posting;
  perform t_report('§32 outstanding drops by the allocated amount', remaining_outstanding = 400.00, format('outstanding=%s', remaining_outstanding));

  -- Over-allocation refused: the receipt has nothing left (600 fully used).
  begin
    perform public.accounting_allocate_ar(invoice_posting, receipt_posting, 1.00);
  exception when others then refused := true; msg := sqlerrm;
  end;
  perform t_report('§32 allocating against an exhausted receipt is refused', refused, coalesce(msg, 'ACCEPTED'));

  -- Wrong customer: Customer Y's receipt cannot settle Customer X's invoice.
  refused := false; msg := null;
  declare
    other_receipt_jid uuid; other_receipt_posting uuid;
  begin
    other_receipt_jid := t_journal('22222222-0000-0000-0000-00000000000a', '2026-10-11',
      '44444444-0000-0000-0000-000000001100', 400.00, ar_acct, 400.00, 'RCPT-Y-1');
    update public.accounting_journal_lines set customer_id = '66666666-0000-0000-0000-000000000002' where journal_id = other_receipt_jid and account_id = ar_acct;
    perform public.accounting_post_journal(other_receipt_jid);
    select id into other_receipt_posting from public.accounting_postings where journal_id = other_receipt_jid and account_id = ar_acct;

    begin
      perform public.accounting_allocate_ar(invoice_posting, other_receipt_posting, 100.00);
    exception when others then refused := true; msg := sqlerrm;
    end;
  end;
  perform t_report('§32 a receipt for a different customer cannot be allocated', refused, coalesce(msg, 'ACCEPTED'));

  -- The remaining 400 settles from a second receipt for Customer X.
  declare
    second_receipt_jid uuid; second_receipt_posting uuid;
  begin
    second_receipt_jid := t_journal('22222222-0000-0000-0000-00000000000a', '2026-10-15',
      '44444444-0000-0000-0000-000000001100', 400.00, ar_acct, 400.00, 'RCPT-X-2');
    update public.accounting_journal_lines set customer_id = '66666666-0000-0000-0000-000000000001' where journal_id = second_receipt_jid and account_id = ar_acct;
    perform public.accounting_post_journal(second_receipt_jid);
    select id into second_receipt_posting from public.accounting_postings where journal_id = second_receipt_jid and account_id = ar_acct;
    perform public.accounting_allocate_ar(invoice_posting, second_receipt_posting, 400.00);
  end;

  perform t_report('§32 a fully allocated invoice no longer appears as an open item',
    not exists (select 1 from public.accounting_ar_open_items('22222222-0000-0000-0000-00000000000a', '2026-10-31') where posting_id = invoice_posting));

  -- Deallocation reopens the item.
  delete from public.accounting_ar_allocations where invoice_posting_id = invoice_posting and receipt_posting_id = receipt_posting;
  select outstanding into remaining_outstanding from public.accounting_ar_open_items('22222222-0000-0000-0000-00000000000a', '2026-10-31') where posting_id = invoice_posting;
  perform t_report('§32 removing an allocation restores the outstanding balance', remaining_outstanding = 600.00, format('outstanding=%s', remaining_outstanding));

  perform t_report('§32 allocation and deallocation are both in the audit trail',
    (select count(*) from public.accounting_audit_events
      where entity_type = 'accounting_ar_allocation' and action = 'ar_allocated') = 2,
    format('allocated events=%s',
      (select count(*) from public.accounting_audit_events where entity_type = 'accounting_ar_allocation' and action = 'ar_allocated')));
  perform t_report('§32 removing an allocation is logged too',
    (select count(*) from public.accounting_audit_events
      where entity_type = 'accounting_ar_allocation' and action = 'ar_allocation_removed') = 1);
end $$;

-- ── THE SAME POSTING CANNOT BE ALLOCATED TO ITSELF, AND WRONG DIRECTIONS REFUSE ──
do $$
declare ar_acct uuid; jid uuid; posting_id uuid; refused boolean := false;
begin
  select ar_control_account_id into ar_acct
  from public.accounting_entity_settings where company_id = '22222222-0000-0000-0000-00000000000a';

  jid := t_journal('22222222-0000-0000-0000-00000000000a', '2026-10-20', ar_acct, 50.00,
    (select id from public.accounting_accounts where company_id = '22222222-0000-0000-0000-00000000000a' and code = '4000'), 50.00, 'INV-X-SELF');
  update public.accounting_journal_lines set customer_id = '66666666-0000-0000-0000-000000000001' where journal_id = jid and account_id = ar_acct;
  perform public.accounting_post_journal(jid);
  select id into posting_id from public.accounting_postings where journal_id = jid and account_id = ar_acct;

  -- A debit posting cannot serve as the receipt (credit) side of its own allocation.
  begin
    perform public.accounting_allocate_ar(posting_id, posting_id, 10.00);
  exception when others then refused := true;
  end;
  perform t_report('§32 a posting cannot allocate against itself (wrong side)', refused);
end $$;

-- ── AP MIRROR: A BILL AND A PAYMENT ─────────────────────────────────────────
do $$
declare
  ap_acct uuid; bill_jid uuid; payment_jid uuid;
  bill_posting uuid; payment_posting uuid;
begin
  select ap_control_account_id into ap_acct
  from public.accounting_entity_settings where company_id = '22222222-0000-0000-0000-00000000000a';

  -- Bill: Dr Expense, Cr AP control 300, for Supplier X.
  bill_jid := t_journal('22222222-0000-0000-0000-00000000000a', '2026-10-06',
    '44444444-0000-0000-0000-000000006100', 300.00, ap_acct, 300.00, 'BILL-X-1');
  update public.accounting_journal_lines set supplier_id = '77777777-0000-0000-0000-000000000001' where journal_id = bill_jid and account_id = ap_acct;
  perform public.accounting_post_journal(bill_jid);
  select id into bill_posting from public.accounting_postings where journal_id = bill_jid and account_id = ap_acct;

  -- Payment: Dr AP control 300, Cr Bank, for Supplier X.
  payment_jid := t_journal('22222222-0000-0000-0000-00000000000a', '2026-10-12', ap_acct, 300.00,
    '44444444-0000-0000-0000-000000001100', 300.00, 'PAY-X-1');
  update public.accounting_journal_lines set supplier_id = '77777777-0000-0000-0000-000000000001' where journal_id = payment_jid and account_id = ap_acct;
  perform public.accounting_post_journal(payment_jid);
  select id into payment_posting from public.accounting_postings where journal_id = payment_jid and account_id = ap_acct;

  perform public.accounting_allocate_ap(bill_posting, payment_posting, 300.00);

  perform t_report('§32 a fully paid bill no longer appears as an open item',
    not exists (select 1 from public.accounting_ap_open_items('22222222-0000-0000-0000-00000000000a', '2026-10-31') where posting_id = bill_posting));
end $$;

-- ── AGEING BUCKETS ───────────────────────────────────────────────────────────
do $$
declare ar_acct uuid; jid uuid; row_current numeric; row_90 numeric;
begin
  select ar_control_account_id into ar_acct
  from public.accounting_entity_settings where company_id = '22222222-0000-0000-0000-00000000000a';

  -- Due 90+ days before the as-at date.
  jid := t_journal('22222222-0000-0000-0000-00000000000a', '2026-07-01', ar_acct, 200.00,
    (select id from public.accounting_accounts where company_id = '22222222-0000-0000-0000-00000000000a' and code = '4000'), 200.00, 'INV-OLD');
  update public.accounting_journal_lines set customer_id = '66666666-0000-0000-0000-000000000002' where journal_id = jid and account_id = ar_acct;
  update public.accounting_journals set due_date = '2026-07-15' where id = jid;
  perform public.accounting_post_journal(jid);

  select current_amount, days_90_plus into row_current, row_90
  from public.accounting_ar_ageing('22222222-0000-0000-0000-00000000000a', '2026-10-31')
  where customer_id = '66666666-0000-0000-0000-000000000002';

  perform t_report('§32 an invoice overdue by more than 60 days lands in the 90+ bucket', row_90 = 200.00, format('90plus=%s', row_90));
  perform t_report('§32 the same invoice is not double-counted in the current bucket', row_current = 0, format('current=%s', row_current));
end $$;
