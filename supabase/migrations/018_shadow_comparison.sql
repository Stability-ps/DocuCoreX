-- Shadow-mode observation (Phase C). Records what Azure Document Intelligence
-- WOULD have produced for a statement the production pipeline already accepted,
-- so the benefit can be measured before any production behaviour changes.
--
-- Nothing in this table feeds extraction, acceptance or the exported workbook.
-- It is written best-effort after the workbook has already been generated; a
-- failure here can never affect a run.
create table if not exists public.extraction_shadow_comparisons (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  run_id uuid not null,
  document_id uuid,
  -- The provider the pipeline actually adopted (pdfplumber | ocr | hybrid | ...).
  current_provider text not null,
  -- False when Azure was unconfigured, failed or timed out.
  azure_available boolean not null default false,
  would_azure_have_been_better boolean not null default false,
  reason text,
  -- Per-metric rows: [{metric, current, azure, difference, favours}].
  metrics jsonb not null default '[]'::jsonb,
  -- {current, azure, ties} tallies behind the verdict.
  score jsonb,
  -- Content-free Azure diagnostics: pages, tables, paragraphs, words,
  -- confidence, duration_ms. NEVER the extracted document text.
  azure_debug jsonb,
  azure_duration_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists extraction_shadow_comparisons_workspace_idx
  on public.extraction_shadow_comparisons (workspace_id, created_at desc);
create index if not exists extraction_shadow_comparisons_run_idx
  on public.extraction_shadow_comparisons (run_id);

alter table public.extraction_shadow_comparisons enable row level security;

drop policy if exists "Users can read their shadow comparisons" on public.extraction_shadow_comparisons;
create policy "Users can read their shadow comparisons"
  on public.extraction_shadow_comparisons for select
  using (workspace_id in (select workspace_id from public.profiles where id = auth.uid()));

comment on table public.extraction_shadow_comparisons is
  'Observational only (Phase C). Azure Document Intelligence run in shadow against an already-accepted extraction. Never influences output.';

notify pgrst, 'reload schema';
