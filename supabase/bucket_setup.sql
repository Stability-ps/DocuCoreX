insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do update set public = false;

drop policy if exists "Users can read workspace document objects" on storage.objects;
create policy "Users can read workspace document objects" on storage.objects
  for select using (
    bucket_id = 'documents'
    and split_part(name, '/', 1) in (
      select workspace_id::text from public.profiles where id = auth.uid()
    )
  );

drop policy if exists "Users can upload workspace document objects" on storage.objects;
create policy "Users can upload workspace document objects" on storage.objects
  for insert with check (
    bucket_id = 'documents'
    and split_part(name, '/', 1) in (
      select workspace_id::text from public.profiles where id = auth.uid()
    )
  );

drop policy if exists "Users can update workspace document objects" on storage.objects;
create policy "Users can update workspace document objects" on storage.objects
  for update using (
    bucket_id = 'documents'
    and split_part(name, '/', 1) in (
      select workspace_id::text from public.profiles where id = auth.uid()
    )
  );
