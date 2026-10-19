-- Storage paths must point inside the row's own workspace folder (053).
set client_min_messages = notice;

grant usage on schema public, auth to authenticated; -- Supabase grants these by default
grant select, insert, update on public.documents, public.conversions, public.document_versions, public.uploads, public.accounting_statement_runs to authenticated;

-- Fixture workspace 0001 belongs to a1. A second tenant to aim at.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000e2', 'paths-other@test.local') on conflict do nothing;
insert into public.workspaces (id, name, owner_id)
values ('11111111-0000-0000-0000-0000000000e2', 'Paths Other', '00000000-0000-0000-0000-0000000000e2') on conflict do nothing;

insert into public.documents (id, workspace_id, owner_id, name, mime_type, storage_path) values
  ('dddddddd-0000-0000-0000-0000000000e1', '11111111-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'mine.pdf', 'application/pdf', '11111111-0000-0000-0000-000000000001/documents/mine.pdf'),
  ('dddddddd-0000-0000-0000-0000000000e2', '11111111-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000e2', 'theirs.pdf', 'application/pdf', '11111111-0000-0000-0000-0000000000e2/documents/theirs.pdf');

select t_report('§53 the rule accepts a path in the workspace folder',
  public.storage_path_in_workspace('11111111-0000-0000-0000-000000000001/documents/a.pdf', '11111111-0000-0000-0000-000000000001'));
select t_report('§53 the rule refuses another workspace, traversal, empty segments and backslashes',
  not public.storage_path_in_workspace('11111111-0000-0000-0000-0000000000e2/documents/a.pdf', '11111111-0000-0000-0000-000000000001')
  and not public.storage_path_in_workspace('11111111-0000-0000-0000-000000000001/../11111111-0000-0000-0000-0000000000e2/a.pdf', '11111111-0000-0000-0000-000000000001')
  and not public.storage_path_in_workspace('11111111-0000-0000-0000-000000000001//a.pdf', '11111111-0000-0000-0000-000000000001')
  and not public.storage_path_in_workspace('11111111-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001')
  and not public.storage_path_in_workspace('/11111111-0000-0000-0000-000000000001/a.pdf', '11111111-0000-0000-0000-000000000001')
  and not public.storage_path_in_workspace('11111111-0000-0000-0000-000000000001' || chr(92) || 'a.pdf', '11111111-0000-0000-0000-000000000001'));

-- The attack, as the user, on each table the server later reads with the service role.
do $$
declare refused text := ''; attempt text; ok int := 0;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);

  begin
    update public.documents set storage_path = '11111111-0000-0000-0000-0000000000e2/documents/theirs.pdf' where id = 'dddddddd-0000-0000-0000-0000000000e1';
    attempt := 'documents.update allowed';
  exception when insufficient_privilege then ok := ok + 1; end;

  begin
    insert into public.documents (workspace_id, owner_id, name, mime_type, storage_path)
    values ('11111111-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'x.pdf', 'application/pdf', '11111111-0000-0000-0000-0000000000e2/documents/theirs.pdf');
  exception when insufficient_privilege then ok := ok + 1; end;

  begin
    insert into public.accounting_statement_runs (workspace_id, source_storage_path, status)
    values ('11111111-0000-0000-0000-000000000001', '11111111-0000-0000-0000-0000000000e2/documents/theirs.pdf', 'queued');
  exception when insufficient_privilege then ok := ok + 1; when others then refused := refused || ' runs:' || sqlstate; end;

  begin
    insert into public.conversions (document_id, from_format, to_format, status, download_path)
    values ('dddddddd-0000-0000-0000-0000000000e1', 'pdf', 'docx', 'queued', '11111111-0000-0000-0000-0000000000e2/conversions/theirs.docx');
  exception when insufficient_privilege then ok := ok + 1; when others then refused := refused || ' conversions:' || sqlstate; end;

  begin
    insert into public.document_versions (document_id, version_number, storage_path)
    values ('dddddddd-0000-0000-0000-0000000000e1', 2, '11111111-0000-0000-0000-0000000000e2/documents/theirs.pdf');
  exception when insufficient_privilege then ok := ok + 1; when others then refused := refused || ' versions:' || sqlstate; end;

  begin
    insert into public.uploads (workspace_id, file_name, mime_type, storage_path)
    values ('11111111-0000-0000-0000-000000000001', 'x.pdf', 'application/pdf', '11111111-0000-0000-0000-0000000000e2/documents/theirs.pdf');
  exception when insufficient_privilege then ok := ok + 1; when others then refused := refused || ' uploads:' || sqlstate; end;

  reset role;
  perform t_report('§53 every path column refuses another workspace''s object', ok = 6,
    format('%s of 6 refused%s', ok, coalesce(nullif(refused, ''), '')));
end $$;

select t_report('§53 the document still points at its own file',
  (select storage_path from public.documents where id = 'dddddddd-0000-0000-0000-0000000000e1') = '11111111-0000-0000-0000-000000000001/documents/mine.pdf');

-- Legitimate writes still work: own-folder paths, and unrelated column updates.
do $$
declare n int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  update public.documents set status = 'ready', name = 'renamed.pdf' where id = 'dddddddd-0000-0000-0000-0000000000e1';
  get diagnostics n = row_count;
  update public.documents set storage_path = '11111111-0000-0000-0000-000000000001/documents/moved.pdf' where id = 'dddddddd-0000-0000-0000-0000000000e1';
  insert into public.conversions (document_id, from_format, to_format, status, download_path)
  values ('dddddddd-0000-0000-0000-0000000000e1', 'pdf', 'docx', 'queued', '11111111-0000-0000-0000-000000000001/conversions/mine.docx');
  insert into public.conversions (document_id, from_format, to_format, status) values ('dddddddd-0000-0000-0000-0000000000e1', 'pdf', 'xlsx', 'queued');
  reset role;
  perform t_report('§53 ordinary updates, own-folder paths and empty download paths still save', n = 1);
end $$;

delete from public.conversions where document_id = 'dddddddd-0000-0000-0000-0000000000e1';
delete from public.documents where id in ('dddddddd-0000-0000-0000-0000000000e1', 'dddddddd-0000-0000-0000-0000000000e2');
