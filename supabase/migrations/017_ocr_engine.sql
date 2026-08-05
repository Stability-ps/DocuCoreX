-- Multi-engine OCR provenance for the extraction pipeline. Records WHICH OCR
-- engine produced the accepted result, which strategy the document analysis
-- chose, and the head-to-head comparison when more than one engine ran.
--
-- All nullable and additive — the code writes these on a best-effort path and
-- degrades gracefully (with a logged warning) when this migration has not yet
-- been applied, exactly like migrations 013/014/015.
alter table if exists public.accounting_statement_runs
  add column if not exists ocr_engine text,
  add column if not exists extraction_strategy text,
  add column if not exists acceptance_verdict text,
  add column if not exists ocr_engine_comparison jsonb;

comment on column public.accounting_statement_runs.ocr_engine is
  'OCR engine whose output was accepted: tesseract | mistral_ocr. Null when the result came from native extraction only.';

comment on column public.accounting_statement_runs.extraction_strategy is
  'Strategy chosen from the document analysis: native | native_then_ocr | ocr_primary.';

comment on column public.accounting_statement_runs.acceptance_verdict is
  'Single acceptance verdict: validated | review_required | failed. "validated" requires extraction, completeness, reconciliation AND cross-engine agreement to all pass.';

comment on column public.accounting_statement_runs.ocr_engine_comparison is
  'Per-engine head-to-head record: [{engine, score, confidence, chars, transactions, won}].';

-- Refresh the PostgREST schema cache so the new columns are recognised.
notify pgrst, 'reload schema';
