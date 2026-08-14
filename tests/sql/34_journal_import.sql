-- Stage 8B: bulk journal import — the idempotency backstop.
set client_min_messages = notice;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);

-- ── TWO IMPORTED JOURNALS CANNOT SHARE A REFERENCE FOR ONE ENTITY ───────────
do $$
declare ws uuid; batch_id uuid; jid1 uuid; jid2 uuid; refused boolean := false; msg text;
begin
  select workspace_id into ws from public.companies where id = '22222222-0000-0000-0000-00000000000a';

  insert into public.accounting_import_batches (company_id, workspace_id, import_type, filename, total_groups, valid_groups, rejected_groups)
  values ('22222222-0000-0000-0000-00000000000a', ws, 'journals', 'first.csv', 1, 1, 0)
  returning id into batch_id;

  jid1 := t_journal('22222222-0000-0000-0000-00000000000a', '2026-10-01',
    '44444444-0000-0000-0000-000000001100', 100.00,
    '44444444-0000-0000-0000-000000006100', 100.00, 'OB-DUP-1');
  perform public.accounting_post_journal(jid1);
  update public.accounting_journals set import_batch_id = batch_id where id = jid1;
  perform t_report('§34 a journal linked to a batch is accepted', (select import_batch_id from public.accounting_journals where id = jid1) = batch_id);

  -- A second, DIFFERENT batch tries to import the same reference for the same entity.
  jid2 := t_journal('22222222-0000-0000-0000-00000000000a', '2026-10-02',
    '44444444-0000-0000-0000-000000001100', 50.00,
    '44444444-0000-0000-0000-000000006100', 50.00, 'OB-DUP-1');
  perform public.accounting_post_journal(jid2);
  begin
    update public.accounting_journals set import_batch_id = batch_id where id = jid2;
  exception when others then refused := true; msg := sqlerrm;
  end;
  perform t_report('§34 a second imported journal cannot reuse a reference already imported for this entity', refused, coalesce(msg, 'ACCEPTED'));
end $$;

-- ── THE CONSTRAINT IS CASE- AND WHITESPACE-INSENSITIVE, MATCHING THE APP'S OWN GROUPING ──
do $$
declare ws uuid; batch_id uuid; jid1 uuid; jid2 uuid; refused boolean := false;
begin
  select workspace_id into ws from public.companies where id = '22222222-0000-0000-0000-00000000000a';
  insert into public.accounting_import_batches (company_id, workspace_id, import_type, filename, total_groups, valid_groups, rejected_groups)
  values ('22222222-0000-0000-0000-00000000000a', ws, 'journals', 'second.csv', 1, 1, 0)
  returning id into batch_id;

  jid1 := t_journal('22222222-0000-0000-0000-00000000000a', '2026-10-03',
    '44444444-0000-0000-0000-000000001100', 20.00,
    '44444444-0000-0000-0000-000000006100', 20.00, 'OB-CASE-1');
  perform public.accounting_post_journal(jid1);
  update public.accounting_journals set import_batch_id = batch_id where id = jid1;

  jid2 := t_journal('22222222-0000-0000-0000-00000000000a', '2026-10-04',
    '44444444-0000-0000-0000-000000001100', 15.00,
    '44444444-0000-0000-0000-000000006100', 15.00, ' ob-case-1 ');
  perform public.accounting_post_journal(jid2);
  begin
    update public.accounting_journals set import_batch_id = batch_id where id = jid2;
  exception when others then refused := true;
  end;
  perform t_report('§34 the duplicate-reference guard ignores case and surrounding whitespace', refused);
end $$;

-- ── A MANUALLY CREATED JOURNAL IS NEVER CONSTRAINED BY THIS INDEX ───────────
do $$
declare jid1 uuid; jid2 uuid; both_posted boolean;
begin
  jid1 := t_journal('22222222-0000-0000-0000-00000000000a', '2026-10-05',
    '44444444-0000-0000-0000-000000001100', 10.00,
    '44444444-0000-0000-0000-000000006100', 10.00, 'MANUAL-REUSE');
  perform public.accounting_post_journal(jid1);

  jid2 := t_journal('22222222-0000-0000-0000-00000000000a', '2026-10-06',
    '44444444-0000-0000-0000-000000001100', 5.00,
    '44444444-0000-0000-0000-000000006100', 5.00, 'MANUAL-REUSE');
  perform public.accounting_post_journal(jid2);

  select (select status from public.accounting_journals where id = jid1) = 'posted'
     and (select status from public.accounting_journals where id = jid2) = 'posted'
    into both_posted;
  perform t_report('§34 two manually created journals may freely share a reference', both_posted);
end $$;

-- ── A JOURNAL CANNOT CLAIM AN IMPORT BATCH THAT DOES NOT EXIST ──────────────
do $$
declare jid uuid; refused boolean := false;
begin
  jid := t_journal('22222222-0000-0000-0000-00000000000a', '2026-10-07',
    '44444444-0000-0000-0000-000000001100', 1.00,
    '44444444-0000-0000-0000-000000006100', 1.00, 'BAD-BATCH-REF');
  begin
    update public.accounting_journals set import_batch_id = '00000000-0000-0000-0000-000000000000' where id = jid;
  exception when others then refused := true;
  end;
  perform t_report('§34 a journal cannot reference a nonexistent import batch', refused);
end $$;

-- ── COMMITTING A JOURNAL IMPORT BATCH IS ALSO AN AUDIT EVENT ────────────────
do $$
declare logged_action text;
begin
  select action into logged_action from public.accounting_audit_events
   where entity_type = 'accounting_import_batch' and action = 'journals_imported'
   limit 1;
  perform t_report('§34 a journal import batch is logged distinctly from a chart-of-accounts one',
    logged_action = 'journals_imported', coalesce(logged_action, 'MISSING'));
end $$;
