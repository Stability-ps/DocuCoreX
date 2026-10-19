-- Accounting runs and uploads can only reference their own workspace's
-- documents and jobs; fail_stale_accounting_run only fails this workspace's job (055).
set client_min_messages = notice;

grant usage on schema public, auth to authenticated; -- Supabase grants these by default
grant select, insert, update on public.accounting_statement_runs, public.uploads, public.processing_jobs, public.documents to authenticated;

-- Victim tenant with a document and a running job; attacker is a1 in workspace 0001.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000c9', 'guard-victim@test.local') on conflict do nothing;
insert into public.workspaces (id, name, owner_id)
values ('11111111-0000-0000-0000-0000000000c9', 'Guard Victim', '00000000-0000-0000-0000-0000000000c9') on conflict do nothing;
update public.profiles set workspace_id = '11111111-0000-0000-0000-0000000000c9' where id = '00000000-0000-0000-0000-0000000000c9';

insert into public.documents (id, workspace_id, owner_id, name, mime_type, storage_path) values
  ('dddddddd-0000-0000-0000-0000000000c9', '11111111-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000c9', 'victim.pdf', 'application/pdf', '11111111-0000-0000-0000-0000000000c9/documents/victim.pdf'),
  ('dddddddd-0000-0000-0000-0000000000a9', '11111111-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'own.pdf', 'application/pdf', '11111111-0000-0000-0000-000000000001/documents/own.pdf');
insert into public.processing_jobs (id, document_id, type, status, message, updated_at) values
  ('eeeeeeee-0000-0000-0000-0000000000c9', 'dddddddd-0000-0000-0000-0000000000c9', 'extraction', 'running', 'victim working', now() - interval '2 hours'),
  ('eeeeeeee-0000-0000-0000-0000000000a9', 'dddddddd-0000-0000-0000-0000000000a9', 'extraction', 'running', 'own working', now() - interval '2 hours');

-- A run that predates 055 and already points at the victim's job (written as
-- the table owner, which the old schema allowed any user to do via PostgREST).
alter table public.accounting_statement_runs disable trigger runs_reference_own_workspace;
insert into public.accounting_statement_runs (id, workspace_id, status, processing_job_id, source_storage_path, updated_at)
values ('f0000000-0000-0000-0000-0000000000c9', '11111111-0000-0000-0000-000000000001', 'processing', 'eeeeeeee-0000-0000-0000-0000000000c9', '11111111-0000-0000-0000-000000000001/documents/own.pdf', now() - interval '2 hours');
alter table public.accounting_statement_runs enable trigger runs_reference_own_workspace;

do $$
declare refused int := 0; failed boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);

  begin
    insert into public.accounting_statement_runs (workspace_id, status, processing_job_id, source_storage_path)
    values ('11111111-0000-0000-0000-000000000001', 'processing', 'eeeeeeee-0000-0000-0000-0000000000c9', '11111111-0000-0000-0000-000000000001/documents/own.pdf');
  exception when insufficient_privilege then refused := refused + 1; end;

  begin
    insert into public.accounting_statement_runs (workspace_id, status, document_id, source_storage_path)
    values ('11111111-0000-0000-0000-000000000001', 'processing', 'dddddddd-0000-0000-0000-0000000000c9', '11111111-0000-0000-0000-000000000001/documents/own.pdf');
  exception when insufficient_privilege then refused := refused + 1; end;

  begin
    insert into public.uploads (workspace_id, document_id, file_name, mime_type, storage_path)
    values ('11111111-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-0000000000c9', 'x.pdf', 'application/pdf', '11111111-0000-0000-0000-000000000001/documents/x.pdf');
  exception when insufficient_privilege then refused := refused + 1; end;

  failed := public.fail_stale_accounting_run('f0000000-0000-0000-0000-0000000000c9', '11111111-0000-0000-0000-000000000001', null, now() + interval '1 day', 'attacker-controlled message');
  reset role;

  perform t_report('§55 runs and uploads cannot reference another workspace''s documents or jobs', refused = 3, format('%s of 3 refused', refused));
  perform t_report('§55 failing a run never touches another workspace''s job',
    (select status::text = 'running' and message = 'victim working' from public.processing_jobs where id = 'eeeeeeee-0000-0000-0000-0000000000c9'),
    format('run failed=%s', failed));
end $$;

-- Legitimate use still works: a run on its own document and job, failed when stale.
do $$
declare run_id uuid; failed boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  insert into public.accounting_statement_runs (workspace_id, status, document_id, processing_job_id, source_storage_path)
  values ('11111111-0000-0000-0000-000000000001', 'processing', 'dddddddd-0000-0000-0000-0000000000a9', 'eeeeeeee-0000-0000-0000-0000000000a9', '11111111-0000-0000-0000-000000000001/documents/own.pdf')
  returning id into run_id;
  reset role;
  update public.accounting_statement_runs set updated_at = now() - interval '2 hours' where id = run_id;
  set local role authenticated;
  failed := public.fail_stale_accounting_run(run_id, '11111111-0000-0000-0000-000000000001', null, now() - interval '1 hour', 'stuck');
  reset role;
  perform t_report('§55 a run on its own document and job still saves and fails its own stale job',
    failed and (select status::text = 'failed' from public.processing_jobs where id = 'eeeeeeee-0000-0000-0000-0000000000a9'),
    format('failed=%s', failed));
end $$;

delete from public.accounting_statement_runs where workspace_id = '11111111-0000-0000-0000-000000000001' and source_storage_path like '%/own.pdf';
delete from public.documents where id in ('dddddddd-0000-0000-0000-0000000000c9', 'dddddddd-0000-0000-0000-0000000000a9');
