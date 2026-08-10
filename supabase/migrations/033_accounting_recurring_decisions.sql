-- Confirmed and dismissed recurring payment patterns.
--
-- A recurring pattern is an observation about timing, not an accounting entry.
-- It changes no ledger and no VAT treatment. What it does change is what
-- forecasting is allowed to treat as a commitment, which is why the decision is
-- recorded rather than inferred fresh every time: a projection built on
-- "probably monthly" is a guess wearing a number, and a projection built on a
-- confirmed obligation is not.
--
-- Keyed by MERCHANT, not by transaction. Unlike tags (031) and transfer matches
-- (032), which attach to specific rows and cascade away when a reprocess
-- regenerates transaction ids, a recurring decision is about a payee's rhythm.
-- That outlives any particular statement, so keying it to the merchant makes it
-- survive reprocessing — the limitation recorded in 031 and 032 does not apply
-- here, and this is the reason why.
--
-- Merchant is stored as entered and matched case-insensitively, matching the
-- convention established for tags.

create table if not exists public.accounting_recurring_decisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  merchant text not null check (length(trim(merchant)) between 1 and 200),
  status text not null check (status in ('confirmed', 'dismissed')),
  -- What was observed when the decision was made. Retained so a later reader can
  -- see the evidence, not so it can be re-evaluated: patterns are recomputed
  -- from transactions, because the detection rules will change.
  observed jsonb not null default '{}'::jsonb,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz not null default now()
);

-- One decision per merchant per workspace. Re-deciding updates in place; the
-- sequence of changes belongs in accounting_action_audit.
create unique index if not exists accounting_recurring_decisions_merchant_idx
  on public.accounting_recurring_decisions(workspace_id, lower(trim(merchant)));

alter table public.accounting_recurring_decisions enable row level security;

drop policy if exists "Users can access accounting recurring decisions" on public.accounting_recurring_decisions;
create policy "Users can access accounting recurring decisions" on public.accounting_recurring_decisions
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
