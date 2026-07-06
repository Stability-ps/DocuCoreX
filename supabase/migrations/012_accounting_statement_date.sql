-- Persist the statement's own date (from the PDF) so the display name and
-- sorting derive from statement metadata, never the upload/current date.
alter table if exists public.accounting_statement_runs
  add column if not exists statement_date date;

comment on column public.accounting_statement_runs.statement_date is
  'Statement date read from the PDF (fallback for naming when no period end exists). Never the upload date.';
