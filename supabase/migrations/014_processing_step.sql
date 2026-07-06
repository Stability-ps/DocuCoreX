-- Live processing step + start time so the UI can show the current stage
-- ("Detecting PDF type", "Running OCR", "Parsing transactions", "Reconciling")
-- with an elapsed timer while a statement is processing. Both nullable — the
-- code degrades gracefully if unset (older rows / migration not yet applied).
alter table if exists public.accounting_statement_runs
  add column if not exists processing_step text,
  add column if not exists processing_started_at timestamptz;

comment on column public.accounting_statement_runs.processing_step is
  'Human-readable current processing step shown in the UI while status = processing.';

-- Refresh the PostgREST schema cache so the new columns are recognised.
notify pgrst, 'reload schema';
