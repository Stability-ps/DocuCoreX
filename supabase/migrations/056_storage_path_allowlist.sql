-- Storage path segments are an allow-list (corrects 053's rule).
--
-- 053's storage_path_in_workspace rejected only literal ".", ".." and a
-- backslash. storage-js puts the path into the request URL unencoded, and the
-- URL parser normalises "%2e%2e" into "..", so a path such as
-- "<own ws>/%2e%2e/<victim ws>/documents/x.pdf" passed the check and the
-- service-role download read the victim's file (found by the 2026-10-19 audit).
--
-- 053 is already applied in production (the Supabase GitHub integration applies
-- migrations when they reach main), so the rule is replaced here rather than by
-- editing 053. The triggers 053 created call this function and pick up the new
-- rule immediately.
--
-- Rule: the first segment is the row's workspace id, and every segment is made
-- only of letters, digits, ".", "_" and "-" and is not "." or "..". Checked in
-- production on 2026-10-19: all 694 existing paths across the six columns fit.
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
     and split_part(p_path, '/', 1) = p_workspace_id::text
     and array_length(string_to_array(p_path, '/'), 1) >= 2
     and not exists (
       select 1 from unnest(string_to_array(p_path, '/')) as segment
       where segment !~ '^[A-Za-z0-9._-]+$' or segment in ('.', '..')
     );
$$;
