alter table if exists public.accounting_statement_runs
  add column if not exists error_message text,
  add column if not exists parser_debug jsonb not null default '{}'::jsonb,
  add column if not exists ocr_debug jsonb not null default '{}'::jsonb,
  add column if not exists last_step text,
  add column if not exists selected_parser text,
  add column if not exists detected_pdf_type text,
  add column if not exists requires_review boolean not null default false;
