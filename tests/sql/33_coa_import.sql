-- Stage 8A: chart of accounts import — batches, their errors, and traceability.
set client_min_messages = notice;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);

-- ── COUNTS MUST BE INTERNALLY CONSISTENT ─────────────────────────────────────
do $$
declare ws uuid; refused boolean := false; batch_id uuid;
begin
  select workspace_id into ws from public.companies where id = '22222222-0000-0000-0000-00000000000a';

  begin
    insert into public.accounting_import_batches (company_id, workspace_id, import_type, filename, total_groups, valid_groups, rejected_groups)
    values ('22222222-0000-0000-0000-00000000000a', ws, 'chart_of_accounts', 'bad.csv', 5, 4, 4);
  exception when others then refused := true;
  end;
  perform t_report('§33 valid_groups + rejected_groups cannot exceed total_groups', refused);

  insert into public.accounting_import_batches (company_id, workspace_id, import_type, filename, total_groups, valid_groups, rejected_groups)
  values ('22222222-0000-0000-0000-00000000000a', ws, 'chart_of_accounts', 'good.csv', 10, 8, 2)
  returning id into batch_id;
  perform t_report('§33 a consistent batch is accepted', batch_id is not null);
end $$;

-- ── APPEND-ONLY, EVEN FOR THE CALLING ROLE ──────────────────────────────────
do $$
declare batch_id uuid; refused_update boolean := false; refused_delete boolean := false;
begin
  select id into batch_id from public.accounting_import_batches where filename = 'good.csv';

  begin
    update public.accounting_import_batches set filename = 'tampered.csv' where id = batch_id;
  exception when others then refused_update := true;
  end;
  perform t_report('§33 a batch record cannot be updated', refused_update);

  begin
    delete from public.accounting_import_batches where id = batch_id;
  exception when others then refused_delete := true;
  end;
  perform t_report('§33 a batch record cannot be deleted', refused_delete);
end $$;

do $$
declare batch_id uuid; error_id uuid; refused_update boolean := false; refused_delete boolean := false;
begin
  select id into batch_id from public.accounting_import_batches where filename = 'good.csv';
  insert into public.accounting_import_batch_errors (batch_id, company_id, workspace_id, group_reference, row_numbers, message)
  values (batch_id, '22222222-0000-0000-0000-00000000000a',
    (select workspace_id from public.companies where id = '22222222-0000-0000-0000-00000000000a'),
    '9999', array[7], 'Unrecognised account type.')
  returning id into error_id;

  begin
    update public.accounting_import_batch_errors set message = 'tampered' where id = error_id;
  exception when others then refused_update := true;
  end;
  perform t_report('§33 a batch error cannot be updated', refused_update);

  begin
    delete from public.accounting_import_batch_errors where id = error_id;
  exception when others then refused_delete := true;
  end;
  perform t_report('§33 a batch error cannot be deleted', refused_delete);
end $$;

-- ── COMMITTING A BATCH IS AN AUDIT EVENT ─────────────────────────────────────
do $$
declare batch_id uuid; logged_action text;
begin
  select id into batch_id from public.accounting_import_batches where filename = 'good.csv';
  select action into logged_action from public.accounting_audit_events
   where entity_type = 'accounting_import_batch' and entity_id = batch_id::text;
  perform t_report('§33 a chart-of-accounts import batch is logged to the audit trail',
    logged_action = 'chart_of_accounts_imported', coalesce(logged_action, 'MISSING'));
end $$;

-- ── TRACEABILITY: AN IMPORTED ACCOUNT LINKS BACK TO ITS BATCH ───────────────
do $$
declare ws uuid; batch_id uuid; account_id uuid; linked_batch uuid;
begin
  select workspace_id into ws from public.companies where id = '22222222-0000-0000-0000-00000000000a';

  insert into public.accounting_import_batches (company_id, workspace_id, import_type, filename, total_groups, valid_groups, rejected_groups)
  values ('22222222-0000-0000-0000-00000000000a', ws, 'chart_of_accounts', 'trace.csv', 1, 1, 0)
  returning id into batch_id;

  insert into public.accounting_accounts (company_id, workspace_id, code, name, account_type, normal_balance, import_batch_id)
  values ('22222222-0000-0000-0000-00000000000a', ws, '9100', 'Imported Test Account', 'expense', 'debit', batch_id)
  returning id into account_id;

  select import_batch_id into linked_batch from public.accounting_accounts where id = account_id;
  perform t_report('§33 an imported account records which batch created it', linked_batch = batch_id);
end $$;

-- ── AN ACCOUNT CANNOT CLAIM A BATCH THAT DOES NOT EXIST ─────────────────────
do $$
declare ws uuid; refused boolean := false;
begin
  select workspace_id into ws from public.companies where id = '22222222-0000-0000-0000-00000000000a';
  begin
    insert into public.accounting_accounts (company_id, workspace_id, code, name, account_type, normal_balance, import_batch_id)
    values ('22222222-0000-0000-0000-00000000000a', ws, '9200', 'Bad Batch Ref', 'expense', 'debit', '00000000-0000-0000-0000-000000000000');
  exception when others then refused := true;
  end;
  perform t_report('§33 an account cannot reference a nonexistent import batch', refused);
end $$;
