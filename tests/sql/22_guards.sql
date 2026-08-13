-- §8 append-only under a BYPASSRLS role, §9 locked period, §10 absent period = open.
set client_min_messages = notice;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);

-- ── §10 ABSENT PERIOD MEANS OPEN ────────────────────────────────────────────
-- Run before any period rows exist, so the default is what is under test.
do $$
declare jid uuid; st text; periods int;
begin
  select count(*) into periods from public.accounting_periods;
  jid := t_journal('22222222-0000-0000-0000-00000000000a', '2025-07-01',
                   '44444444-0000-0000-0000-000000006100', 250.00,
                   '44444444-0000-0000-0000-000000001100', 250.00, 'JV-OPEN');
  perform public.accounting_post_journal(jid);
  select status into st from public.accounting_journals where id = jid;
  perform t_report('§10 posts with no period row defined', st = 'posted',
    format('period_rows_before=%s status=%s', periods, st));
  perform t_report('§10 no period pre-generation was required',
    (select count(*) from public.accounting_periods) = periods,
    format('period rows still %s', periods));
end $$;

-- ── §9 LOCKED PERIOD ────────────────────────────────────────────────────────
do $$
declare
  jid uuid; ok_jid uuid; n int; st text; raised boolean := false; msg text;
  ledger_before numeric; ledger_after numeric; outside_status text;
begin
  select coalesce(sum(debit), 0) into ledger_before from public.accounting_postings;

  insert into public.accounting_periods (company_id, workspace_id, period_start, period_end, status, note)
  values ('22222222-0000-0000-0000-00000000000a',
          (select workspace_id from public.companies where id = '22222222-0000-0000-0000-00000000000a'),
          '2025-08-01', '2025-08-31', 'locked', 'stage 4b test lock');

  jid := t_journal('22222222-0000-0000-0000-00000000000a', '2025-08-15',
                   '44444444-0000-0000-0000-000000001100', 500.00,
                   '44444444-0000-0000-0000-000000002100', 500.00, 'JV-LOCKED');
  begin
    perform public.accounting_post_journal(jid);
  exception when others then raised := true; msg := sqlerrm;
  end;

  select count(*) into n from public.accounting_postings where journal_id = jid;
  select status into st from public.accounting_journals where id = jid;
  select coalesce(sum(debit), 0) into ledger_after from public.accounting_postings;

  perform t_report('§9 balanced journal inside locked period rejected', raised, coalesce(msg, 'no error'));
  perform t_report('§9 no posting rows created', n = 0, format('rows=%s', n));
  perform t_report('§9 journal not marked posted', st = 'draft', format('status=%s', st));
  perform t_report('§9 existing ledger unchanged', ledger_before = ledger_after,
    format('before=%s after=%s', ledger_before, ledger_after));

  -- And a journal OUTSIDE the locked window still posts.
  ok_jid := t_journal('22222222-0000-0000-0000-00000000000a', '2025-09-05',
                      '44444444-0000-0000-0000-000000001100', 400.00,
                      '44444444-0000-0000-0000-000000002100', 400.00, 'JV-UNLOCKED');
  perform public.accounting_post_journal(ok_jid);
  select status into outside_status from public.accounting_journals where id = ok_jid;
  perform t_report('§9 journal outside the locked period still posts', outside_status = 'posted',
    format('status=%s', outside_status));
end $$;
