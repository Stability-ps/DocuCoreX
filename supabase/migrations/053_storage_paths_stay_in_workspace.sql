-- A row's storage path must point inside its own workspace's folder.
--
-- Storage paths live in rows users can edit through PostgREST: documents,
-- uploads, document_versions, conversions and accounting_statement_runs. The
-- server then reads those paths with the SERVICE ROLE (OCR and extraction in
-- lib/ocr/loadDocumentBytes.ts, conversion on the worker, statement parsing in
-- the accounting worker), and the service role bypasses storage RLS. A user who
-- set their own document's storage_path to another workspace's object had that
-- object OCR'd, converted or parsed into their own results. Confirmed against a
-- disposable database built from these migrations (2026-10-19).
--
-- The application now checks every privileged read (lib/storage-paths.ts and
-- the accounting worker's storage_path_belongs_to_workspace). This makes the
-- database refuse to store such a path in the first place.
--
-- Rule (same as the application's): the first segment is the row's workspace
-- id, and no segment is empty, "." or "..", and there is no backslash.
-- Checked on INSERT and whenever a path column changes, for every role:
-- every path the server itself writes already satisfies it. Verified in
-- production on 2026-10-19 before writing this: all 735 existing paths conform,
-- so no existing row is affected.
--
-- Covered by tests/sql/42_storage_paths_stay_in_workspace.sql.

create or replace function public.storage_path_in_workspace(p_path text, p_workspace_id uuid)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_path is not null
     and p_workspace_id is not null
     and position(chr(92) in p_path) = 0
     and split_part(p_path, '/', 1) = p_workspace_id::text
     and array_length(string_to_array(p_path, '/'), 1) >= 2
     and not exists (
       select 1 from unnest(string_to_array(p_path, '/')) as segment
       where segment in ('', '.', '..')
     );
$$;

create or replace function public.enforce_storage_path_in_workspace()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_workspace uuid;
  v_column text := tg_argv[0];
  v_new text := to_jsonb(new) ->> v_column;
  v_old text := case when tg_op = 'UPDATE' then to_jsonb(old) ->> v_column end;
begin
  if v_new is null then
    return new; -- nullable path columns (conversions.download_path, workbooks) may be empty
  end if;
  if tg_op = 'UPDATE' and v_new is not distinct from v_old
     and (to_jsonb(new) ->> 'workspace_id') is not distinct from (to_jsonb(old) ->> 'workspace_id')
     and (to_jsonb(new) ->> 'document_id') is not distinct from (to_jsonb(old) ->> 'document_id') then
    return new; -- path and owner unchanged: nothing to re-check
  end if;

  if to_jsonb(new) ? 'workspace_id' then
    v_workspace := (to_jsonb(new) ->> 'workspace_id')::uuid;
  else
    -- Child tables carry the document, not the workspace.
    select d.workspace_id into v_workspace from public.documents d where d.id = (to_jsonb(new) ->> 'document_id')::uuid;
  end if;

  if not public.storage_path_in_workspace(v_new, v_workspace) then
    raise exception '%.% must point inside its own workspace folder', tg_table_name, v_column
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists documents_storage_path_in_workspace on public.documents;
create trigger documents_storage_path_in_workspace
  before insert or update on public.documents
  for each row execute function public.enforce_storage_path_in_workspace('storage_path');

drop trigger if exists uploads_storage_path_in_workspace on public.uploads;
create trigger uploads_storage_path_in_workspace
  before insert or update on public.uploads
  for each row execute function public.enforce_storage_path_in_workspace('storage_path');

drop trigger if exists document_versions_storage_path_in_workspace on public.document_versions;
create trigger document_versions_storage_path_in_workspace
  before insert or update on public.document_versions
  for each row execute function public.enforce_storage_path_in_workspace('storage_path');

drop trigger if exists conversions_download_path_in_workspace on public.conversions;
create trigger conversions_download_path_in_workspace
  before insert or update on public.conversions
  for each row execute function public.enforce_storage_path_in_workspace('download_path');

drop trigger if exists runs_source_path_in_workspace on public.accounting_statement_runs;
create trigger runs_source_path_in_workspace
  before insert or update on public.accounting_statement_runs
  for each row execute function public.enforce_storage_path_in_workspace('source_storage_path');

drop trigger if exists runs_workbook_path_in_workspace on public.accounting_statement_runs;
create trigger runs_workbook_path_in_workspace
  before insert or update on public.accounting_statement_runs
  for each row execute function public.enforce_storage_path_in_workspace('workbook_storage_path');
