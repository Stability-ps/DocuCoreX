-- Confirmed and rejected inter-account transfer pairings.
--
-- Money moved between two accounts the same business owns is neither income nor
-- expense. Unmatched, one transfer inflates both sides of the profit and loss by
-- its full amount. This table records the human decision about a candidate pair.
--
-- It stores DECISIONS, not detections. Candidates are recomputed from the
-- transactions each time they are needed, because the matching rules will change
-- and a stored candidate would preserve the reasoning of whatever version wrote
-- it. Only what a person decided is durable, and only that is worth keeping.
--
-- A rejection is as valuable as a confirmation: without it the same wrong pair
-- is re-offered after every reprocess, and "not a transfer" has to be decided
-- again. Both are recorded, both are reversible by deleting the row, and both
-- carry who decided and when.
--
-- Reprocess note: transaction ids are regenerated when
-- replace_accounting_transactions_owned rewrites a run, so decisions about that
-- run's transactions are removed by the cascade below. This is the same
-- limitation recorded for tags in migration 031 and has the same cause — there
-- is no stable natural key for a statement line. Recorded so it is a known
-- constraint rather than a surprise.

create table if not exists public.accounting_transfer_matches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- The paying side. Kept explicitly rather than as an unordered pair: which
  -- account the money left is part of the accounting fact.
  outbound_transaction_id uuid not null references public.accounting_transactions(id) on delete cascade,
  inbound_transaction_id uuid not null references public.accounting_transactions(id) on delete cascade,
  status text not null check (status in ('confirmed', 'rejected')),
  -- The evidence shown at the time of the decision, retained so a later reader
  -- can see what the accountant was looking at — not to be re-evaluated.
  evidence jsonb not null default '[]'::jsonb,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz not null default now(),
  -- Guards the degenerate pairing the application also rejects.
  constraint accounting_transfer_matches_distinct_legs
    check (outbound_transaction_id <> inbound_transaction_id)
);

-- One decision per pair. Re-deciding updates rather than accumulating a history
-- of contradictions; the audit trail in accounting_action_audit is where the
-- sequence of changes belongs.
create unique index if not exists accounting_transfer_matches_pair_idx
  on public.accounting_transfer_matches(outbound_transaction_id, inbound_transaction_id);

-- "Has either leg already been decided?" — asked for every candidate, so both
-- directions are indexed.
create index if not exists accounting_transfer_matches_outbound_idx
  on public.accounting_transfer_matches(workspace_id, outbound_transaction_id);
create index if not exists accounting_transfer_matches_inbound_idx
  on public.accounting_transfer_matches(workspace_id, inbound_transaction_id);

alter table public.accounting_transfer_matches enable row level security;

drop policy if exists "Users can access accounting transfer matches" on public.accounting_transfer_matches;
create policy "Users can access accounting transfer matches" on public.accounting_transfer_matches
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
