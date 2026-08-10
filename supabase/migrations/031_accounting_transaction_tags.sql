-- Transaction tags: business grouping, kept apart from accounting treatment.
--
-- A tag and an account category answer different questions. account_category is
-- how a transaction is BOOKED — it feeds the ledger, the VAT schedule and every
-- derived report. A tag is how the business GROUPS it: "Property 1", "Project
-- Alpha", "Vehicle 2", "Intercompany". The same expense can be Repairs &
-- Maintenance for the ledger and Property 1 for the owner, and neither implies
-- the other.
--
-- They are therefore stored separately rather than as extra category values.
-- Folding tags into account_category would put arbitrary business labels into
-- the chart of accounts, and every ledger, trial balance and VAT report derived
-- from it would inherit them.
--
-- No column is added to accounting_transactions. That table is rewritten
-- wholesale by replace_accounting_transactions_owned on every reprocess: the
-- rows are deleted and reinserted from the worker payload, which knows nothing
-- about tags. A tag column would be silently destroyed by the next reprocess.
-- A separate table referencing the transaction survives as long as the
-- transaction does, and is removed with it by the existing cascade.
--
-- Reprocess note: transaction ids are regenerated on replacement, so tags do
-- NOT survive a reprocess of the same statement. That is a known limitation of
-- this migration, not an oversight — carrying them across would require a
-- stable natural key for a statement line, which does not currently exist.
-- Recorded here so the next change does not rediscover it the hard way.

create table if not exists public.accounting_transaction_tags (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  transaction_id uuid not null references public.accounting_transactions(id) on delete cascade,
  -- Stored as entered so "Project Alpha" keeps its capitals; uniqueness is
  -- enforced case-insensitively below so "project alpha" cannot become a
  -- second, separate tag on the same transaction.
  tag text not null check (length(trim(tag)) between 1 and 64),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- One tag per transaction, regardless of casing.
create unique index if not exists accounting_transaction_tags_unique_idx
  on public.accounting_transaction_tags(transaction_id, lower(trim(tag)));

-- Reading a statement's tags: the dominant query, one row per transaction.
create index if not exists accounting_transaction_tags_transaction_idx
  on public.accounting_transaction_tags(transaction_id);

-- Listing the workspace tag vocabulary and filtering by tag. The vocabulary is
-- derived from this index rather than kept in a second table, so a tag cannot
-- exist in a list while belonging to nothing.
create index if not exists accounting_transaction_tags_workspace_tag_idx
  on public.accounting_transaction_tags(workspace_id, lower(trim(tag)));

alter table public.accounting_transaction_tags enable row level security;

drop policy if exists "Users can access accounting transaction tags" on public.accounting_transaction_tags;
create policy "Users can access accounting transaction tags" on public.accounting_transaction_tags
  for all using (
    workspace_id in (
      select workspace_id from public.profiles where id = auth.uid()
    )
  )
  with check (
    workspace_id in (
      select workspace_id from public.profiles where id = auth.uid()
    )
  );
