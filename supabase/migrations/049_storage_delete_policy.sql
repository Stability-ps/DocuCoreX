-- Migration 049: let users delete their own workspace's stored files.
--
-- storage.objects had SELECT, INSERT and UPDATE policies for the "documents"
-- bucket, scoped to the caller's workspace folder, and no DELETE policy. The
-- app removes files as the signed-in user: permanent document delete
-- (originals and conversions), run delete (workbooks), and the cleanup of an
-- upload that fails validation. Under RLS every one of those removals matched
-- no rows and returned success. Production, 2026-10-08: a permanent delete of
-- 33 documents removed their rows and left all of their files in storage.
--
-- Same scope as the existing policies: the first path segment is the caller's
-- workspace id.
drop policy if exists "Users can delete workspace document objects" on storage.objects;
create policy "Users can delete workspace document objects" on storage.objects
  for delete using (
    bucket_id = 'documents'
    and split_part(name, '/', 1) in (
      select workspace_id::text from public.profiles where id = auth.uid()
    )
  );
