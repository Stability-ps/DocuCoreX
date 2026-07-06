-- Processing metadata from the multi-parser extraction pipeline, persisted on the
-- accounting run so the Review page can show how the statement was extracted and
-- whether it reconciles. All nullable — the code degrades gracefully if unset.
alter table if exists public.accounting_statement_runs
  add column if not exists parser_method text,
  add column if not exists extraction_confidence numeric,
  add column if not exists detected_pdf_type text,
  add column if not exists ocr_used boolean,
  add column if not exists route_reason text,
  add column if not exists extraction_warnings jsonb,
  add column if not exists validation_status text,
  add column if not exists reconciliation_difference numeric,
  add column if not exists missing_transaction_count integer,
  add column if not exists requires_review boolean;

comment on column public.accounting_statement_runs.parser_method is
  'Extraction pipeline parser: pdfjs | pdfplumber | ocr | hybrid.';

-- Refresh the PostgREST schema cache so the new columns are recognised.
notify pgrst, 'reload schema';
