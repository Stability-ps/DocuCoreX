-- Users can delete their own workspace's stored files, and only those (049).
--
-- Without a DELETE policy every app-side storage removal (permanent document
-- delete, run delete, invalid-upload cleanup) silently matched nothing under
-- RLS, so "deleted" documents kept their files.
set client_min_messages = notice;

insert into storage.buckets (id, name, public) values ('documents', 'documents', false) on conflict (id) do nothing;
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;
grant select on public.profiles to authenticated; -- Supabase grants this by default
grant select, insert, update, delete on storage.objects to authenticated;

-- A second tenant the fixture user does not belong to.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000b2', 'storage-other@test.local') on conflict do nothing;
insert into public.workspaces (id, name, owner_id)
values ('11111111-0000-0000-0000-0000000000f2', 'Storage Other', '00000000-0000-0000-0000-0000000000b2') on conflict do nothing;

insert into storage.objects (bucket_id, name) values
  ('documents', '11111111-0000-0000-0000-000000000001/documents/own.pdf'),
  ('documents', '11111111-0000-0000-0000-0000000000f2/documents/other.pdf');

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);

delete from storage.objects where name = '11111111-0000-0000-0000-0000000000f2/documents/other.pdf';
delete from storage.objects where name = '11111111-0000-0000-0000-000000000001/documents/own.pdf';

reset role;

select t_report('§49 a user deletes a file in their own workspace folder',
  not exists (select 1 from storage.objects where name = '11111111-0000-0000-0000-000000000001/documents/own.pdf'));
select t_report('§49 a user cannot delete another workspace''s file',
  exists (select 1 from storage.objects where name = '11111111-0000-0000-0000-0000000000f2/documents/other.pdf'));

alter table storage.objects disable row level security;
