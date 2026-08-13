-- §11 reversal, §12 source deletion, §13 account deletion, §14 cross-entity,
-- §15 financial-year integrity, §19 status transitions.
set client_min_messages = notice;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);

-- ── §11 REVERSAL ────────────────────────────────────────────────────────────
do $$
declare
  jid uuid; rid uuid; orig_n int; rev_n int; net numeric; ost text; rst text;
  linked boolean; inverted boolean; orig_unchanged boolean;
  orig_dr numeric; orig_cr numeric;
begin
  jid := t_journal('22222222-0000-0000-0000-00000000000a', '2025-09-10',
                   '44444444-0000-0000-0000-000000006100', 500.00,
                   '44444444-0000-0000-0000-000000001100', 500.00, 'JV-REV');
  perform public.accounting_post_journal(jid);
  select count(*) into orig_n from public.accounting_postings where journal_id = jid;
  select debit into orig_dr from public.accounting_postings
    where journal_id = jid and account_id = '44444444-0000-0000-0000-000000006100';
  select credit into orig_cr from public.accounting_postings
    where journal_id = jid and account_id = '44444444-0000-0000-0000-000000001100';

  rid := public.accounting_reverse_journal(jid, '2025-09-30', 'stage 4b reversal');

  select count(*) into rev_n from public.accounting_postings where journal_id = rid;
  select status into ost from public.accounting_journals where id = jid;
  select status into rst from public.accounting_journals where id = rid;
  select (reverses_journal_id = jid) into linked from public.accounting_journals where id = rid;

  -- Sides inverted: bank now debited, repairs now credited.
  select
    (select debit  from public.accounting_postings where journal_id = rid and account_id = '44444444-0000-0000-0000-000000001100') = 500.00
    and
    (select credit from public.accounting_postings where journal_id = rid and account_id = '44444444-0000-0000-0000-000000006100') = 500.00
    into inverted;

  select (orig_dr = 500.00 and orig_cr = 500.00) into orig_unchanged;
  select sum(debit) - sum(credit) into net from public.accounting_postings where journal_id in (jid, rid);

  perform t_report('§11 original postings survive', orig_n = 2 and orig_unchanged, format('original rows=%s', orig_n));
  perform t_report('§11 reversal creates new postings', rev_n = 2, format('reversal rows=%s', rev_n));
  perform t_report('§11 debit/credit sides inverted', inverted);
  perform t_report('§11 original and reversal are linked', linked);
  perform t_report('§11 original status = reversed', ost = 'reversed', format('original=%s', ost));
  perform t_report('§11 reversal status = posted', rst = 'posted', format('reversal=%s', rst));
  perform t_report('§11 net ledger effect is zero', net = 0, format('net=%s', net));
  perform t_report('§11 no postings were deleted',
    (select count(*) from public.accounting_postings where journal_id = jid) = 2);
end $$;

-- ── §19 STATUS TRANSITIONS ──────────────────────────────────────────────────
do $$
declare jid uuid; rev uuid; no_repost boolean := false; frozen boolean := false; no_rev_repost boolean := false;
begin
  select id into jid from public.accounting_journals where reference = 'JV-001' and status = 'posted' limit 1;
  begin perform public.accounting_post_journal(jid); exception when others then no_repost := true; end;
  begin update public.accounting_journal_lines set debit = 9999 where journal_id = jid; exception when others then frozen := true; end;

  select id into rev from public.accounting_journals where status = 'reversed' limit 1;
  begin perform public.accounting_post_journal(rev); exception when others then no_rev_repost := true; end;

  perform t_report('§19 posted journal cannot post again', no_repost);
  perform t_report('§19 posted journal lines are frozen', frozen);
  perform t_report('§19 reversed journal cannot post again', no_rev_repost);
end $$;

-- ── §13 ACCOUNT DELETION PROTECTION ─────────────────────────────────────────
do $$
declare blocked boolean := false; msg text; still_there boolean; deactivated boolean;
begin
  begin
    delete from public.accounting_accounts where id = '44444444-0000-0000-0000-000000001100';
  exception when others then blocked := true; msg := sqlerrm;
  end;
  select exists (select 1 from public.accounting_accounts where id = '44444444-0000-0000-0000-000000001100') into still_there;

  update public.accounting_accounts set is_active = false where id = '44444444-0000-0000-0000-000000001510';
  select not is_active into deactivated from public.accounting_accounts where id = '44444444-0000-0000-0000-000000001510';

  perform t_report('§13 account with postings cannot be deleted', blocked, coalesce(msg, 'no error'));
  perform t_report('§13 account and its history remain', still_there);
  perform t_report('§13 deactivation is available instead', deactivated);
end $$;

-- ── §14 CROSS-ENTITY PROTECTION ─────────────────────────────────────────────
do $$
declare
  jid uuid; ws uuid; line_rejected boolean := false; post_rejected boolean := false;
  posted_n int; msg text; leaked_line int;
begin
  select workspace_id into ws from public.companies where id = '22222222-0000-0000-0000-00000000000a';
  insert into public.accounting_journals (company_id, workspace_id, journal_date, reference)
  values ('22222222-0000-0000-0000-00000000000a', ws, '2025-10-01', 'JV-XENTITY') returning id into jid;

  -- Entity A journal, one line pointing at an Entity B ACCOUNT.
  begin
    insert into public.accounting_journal_lines (journal_id, company_id, workspace_id, account_id, line_number, debit, credit)
    values (jid, '22222222-0000-0000-0000-00000000000a', ws, '55555555-0000-0000-0000-000000001100', 1, 100.00, 0),
           (jid, '22222222-0000-0000-0000-00000000000a', ws, '44444444-0000-0000-0000-000000002100', 2, 0, 100.00);
  exception when others then line_rejected := true; msg := sqlerrm;
  end;

  select count(*) into leaked_line from public.accounting_journal_lines
   where journal_id = jid and account_id = '55555555-0000-0000-0000-000000001100';

  begin
    perform public.accounting_post_journal(jid);
  exception when others then post_rejected := true; msg := coalesce(msg, sqlerrm);
  end;

  select count(*) into posted_n from public.accounting_postings where journal_id = jid;

  perform t_report('§14 cross-entity line rejected at insert', line_rejected, coalesce(msg, 'accepted'));
  perform t_report('§14 no cross-entity line stored', leaked_line = 0, format('lines=%s', leaked_line));
  perform t_report('§14 cross-entity journal did not post', post_rejected or posted_n = 0,
    format('postings=%s', posted_n));
  perform t_report('§14 no cross-entity posting exists',
    (select count(*) from public.accounting_postings p
      join public.accounting_accounts a on a.id = p.account_id
     where p.company_id <> a.company_id) = 0,
    format('mismatched postings=%s',
      (select count(*) from public.accounting_postings p
        join public.accounting_accounts a on a.id = p.account_id
       where p.company_id <> a.company_id)));
end $$;

-- ── §15 FINANCIAL-YEAR INTEGRITY ────────────────────────────────────────────
do $$
declare overlap_rejected boolean := false; msg text; orphan_dates int;
begin
  begin
    insert into public.accounting_financial_years (company_id, workspace_id, label, start_date, end_date)
    values ('22222222-0000-0000-0000-00000000000a',
            (select workspace_id from public.companies where id = '22222222-0000-0000-0000-00000000000a'),
            'FY2026 duplicate', '2025-06-01', '2026-05-31');
  exception when others then overlap_rejected := true; msg := sqlerrm;
  end;

  -- Postings whose date falls in no declared financial year for their entity.
  select count(*) into orphan_dates
  from public.accounting_postings p
  where not exists (
    select 1 from public.accounting_financial_years fy
    where fy.company_id = p.company_id and p.posting_date between fy.start_date and fy.end_date
  );

  perform t_report('§15 overlapping financial years rejected', overlap_rejected, coalesce(msg, 'accepted'));
  perform t_report('§15 every posting falls inside a declared FY', orphan_dates = 0,
    format('postings outside any FY=%s', orphan_dates));
end $$;
