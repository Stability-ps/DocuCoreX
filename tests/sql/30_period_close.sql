-- Stage 9: period close and the audit trail.
set client_min_messages = notice;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);

-- ── LOCK REFUSES UNPOSTED JOURNALS ───────────────────────────────────────────
do $$
declare
  jid uuid; refused boolean := false; msg text; period_id uuid;
begin
  jid := t_journal('22222222-0000-0000-0000-00000000000a', '2026-09-10',
    '44444444-0000-0000-0000-000000006100', 500.00,
    '44444444-0000-0000-0000-000000001100', 500.00, 'JV-SEP-DRAFT');
  -- t_journal leaves the journal as 'draft'; it is never posted.

  begin
    perform public.accounting_close_period(
      '22222222-0000-0000-0000-00000000000a', '2026-09-01', '2026-09-30', 'locked', 'September close');
  exception when others then refused := true; msg := sqlerrm;
  end;
  perform t_report('§9 locking refuses an unposted journal dated in range', refused, coalesce(msg, 'ACCEPTED'));

  -- A soft close has no such requirement.
  select id into period_id from public.accounting_periods
   where company_id = '22222222-0000-0000-0000-00000000000a'
     and period_start = '2026-09-01' and period_end = '2026-09-30';
  perform t_report('§9 soft close is not attempted here yet', period_id is null);
end $$;

-- ── SOFT CLOSE, THEN LOCK ONCE THE DRAFT IS POSTED ──────────────────────────
do $$
declare
  jid uuid; period_id uuid; locked_id uuid; audit_action text;
begin
  select id into jid from public.accounting_journals
   where company_id = '22222222-0000-0000-0000-00000000000a' and reference = 'JV-SEP-DRAFT';

  period_id := public.accounting_close_period(
    '22222222-0000-0000-0000-00000000000a', '2026-09-01', '2026-09-30', 'soft_closed', 'September pause');
  perform t_report('§9 soft close succeeds with a draft journal still in range', period_id is not null);

  select action into audit_action from public.accounting_audit_events
   where entity_type = 'accounting_period' and entity_id = period_id::text;
  perform t_report('§9 soft close is logged', audit_action = 'period_soft_closed', coalesce(audit_action, 'MISSING'));

  -- Reopen so the draft can be posted, then close again as locked.
  perform public.accounting_reopen_period(period_id, 'need to post the outstanding journal first');
  perform t_report('§9 reopening removes the period row', not exists (
    select 1 from public.accounting_periods where id = period_id));

  perform public.accounting_post_journal(jid);
  locked_id := public.accounting_close_period(
    '22222222-0000-0000-0000-00000000000a', '2026-09-01', '2026-09-30', 'locked', 'September signed off');
  perform t_report('§9 locking succeeds once nothing is left unposted', locked_id is not null);

  select action into audit_action from public.accounting_audit_events
   where entity_type = 'accounting_period' and entity_id = locked_id::text;
  perform t_report('§9 lock is logged distinctly from soft close', audit_action = 'period_locked', coalesce(audit_action, 'MISSING'));
end $$;

-- ── A LOCKED PERIOD REFUSES NEW POSTINGS (the rule 036 already enforces) ────
do $$
declare jid uuid; refused boolean := false; msg text;
begin
  jid := t_journal('22222222-0000-0000-0000-00000000000a', '2026-09-20',
    '44444444-0000-0000-0000-000000006100', 100.00,
    '44444444-0000-0000-0000-000000001100', 100.00, 'JV-SEP-LATE');
  begin
    perform public.accounting_post_journal(jid);
  exception when others then refused := true; msg := sqlerrm;
  end;
  perform t_report('§9 a locked period still refuses a new posting', refused, coalesce(msg, 'ACCEPTED'));
end $$;

-- ── REOPENING REQUIRES A REASON, AND RECORDS ONE ────────────────────────────
do $$
declare
  period_id uuid; refused boolean := false; msg text; recorded_reason text;
begin
  select id into period_id from public.accounting_periods
   where company_id = '22222222-0000-0000-0000-00000000000a'
     and period_start = '2026-09-01' and period_end = '2026-09-30';

  begin
    perform public.accounting_reopen_period(period_id, '');
  exception when others then refused := true; msg := sqlerrm;
  end;
  perform t_report('§9 reopening without a reason is refused', refused, coalesce(msg, 'ACCEPTED'));

  perform public.accounting_reopen_period(period_id, 'correcting a misclassified entry');
  select metadata->>'reason' into recorded_reason from public.accounting_audit_events
   where entity_type = 'accounting_period' and entity_id = period_id::text and action = 'period_reopened';
  perform t_report('§9 the reopen reason is recorded on the audit event',
    recorded_reason = 'correcting a misclassified entry', coalesce(recorded_reason, 'MISSING'));
end $$;

-- ── READINESS REFLECTS WHAT close_period WOULD ITSELF CHECK ─────────────────
do $$
declare unposted bigint; open_recs bigint;
begin
  perform t_journal('22222222-0000-0000-0000-00000000000a', '2026-09-05',
    '44444444-0000-0000-0000-000000006200', 75.00,
    '44444444-0000-0000-0000-000000001100', 75.00, 'JV-SEP-READY');

  select unposted_journal_count into unposted
    from public.accounting_period_close_readiness('22222222-0000-0000-0000-00000000000a', '2026-09-01', '2026-09-30');
  perform t_report('§9 readiness counts the draft journal now sitting in range', unposted >= 1, format('unposted=%s', unposted));
end $$;

-- ── JOURNAL POSTING AND REVERSAL ARE BOTH LOGGED ────────────────────────────
do $$
declare
  jid uuid; reversal_id uuid; posted_action text; reversed_action text; reversal_posted_action text;
begin
  jid := t_journal('22222222-0000-0000-0000-00000000000a', '2026-08-05',
    '44444444-0000-0000-0000-000000006100', 250.00,
    '44444444-0000-0000-0000-000000001100', 250.00, 'JV-AUG-REV');
  perform public.accounting_post_journal(jid);

  select action into posted_action from public.accounting_audit_events
   where entity_type = 'accounting_journal' and entity_id = jid::text and action = 'journal_posted';
  perform t_report('§9 posting a journal is logged', posted_action = 'journal_posted', coalesce(posted_action, 'MISSING'));

  reversal_id := public.accounting_reverse_journal(jid, '2026-08-06', 'test reversal');

  select action into reversed_action from public.accounting_audit_events
   where entity_type = 'accounting_journal' and entity_id = jid::text and action = 'journal_reversed';
  perform t_report('§9 reversing the original is logged', reversed_action = 'journal_reversed', coalesce(reversed_action, 'MISSING'));

  select action into reversal_posted_action from public.accounting_audit_events
   where entity_type = 'accounting_journal' and entity_id = reversal_id::text and action = 'journal_posted';
  perform t_report('§9 the reversing journal posting is logged too', reversal_posted_action = 'journal_posted',
    coalesce(reversal_posted_action, 'MISSING'));
end $$;

-- ── THE AUDIT LOG IS APPEND-ONLY, EVEN FOR THE CALLING ROLE ─────────────────
do $$
declare any_event uuid; refused_update boolean := false; refused_delete boolean := false;
begin
  select id into any_event from public.accounting_audit_events
   where company_id = '22222222-0000-0000-0000-00000000000a' limit 1;

  begin
    update public.accounting_audit_events set action = 'tampered' where id = any_event;
  exception when others then refused_update := true;
  end;
  perform t_report('§9 an audit event cannot be updated', refused_update);

  begin
    delete from public.accounting_audit_events where id = any_event;
  exception when others then refused_delete := true;
  end;
  perform t_report('§9 an audit event cannot be deleted', refused_delete);
end $$;
