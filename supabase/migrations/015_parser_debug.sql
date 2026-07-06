-- Full parser/OCR debug blob (selected parser, detected PDF type, per-stage
-- diagnostics, OCR engine debug, reason no transactions) persisted on the run so
-- the workspace can show WHY a run failed — not just "Failed 0%". Nullable; the
-- UI degrades gracefully when unset (older rows / migration not yet applied).
alter table if exists public.accounting_statement_runs
  add column if not exists parser_debug jsonb;

comment on column public.accounting_statement_runs.parser_debug is
  'Extraction parser + OCR diagnostics captured at processing time (esp. on failure).';

-- Refresh the PostgREST schema cache so the new column is recognised.
notify pgrst, 'reload schema';
