-- Phase 1: separate the three confidence metrics.
--
-- A single "confidence" column conflated three unrelated things and caused
-- repeated misdiagnosis: a ~79% figure read as an OCR failure when it was in
-- fact the mean of accounting-classification rule scores.
--
--   extraction_confidence     — how accurately the document was READ  (exists, migration 013)
--   classification_confidence — how confidently transactions were CATEGORISED  (new)
--   reconciliation_confidence — how internally CONSISTENT the statement is     (new)
--
-- The legacy `confidence` column is RETAINED and continues to carry the
-- classification score, exactly as it always has, so existing integrations keep
-- working unchanged. It is deprecated, not repurposed — changing its meaning
-- would break every reader silently.
alter table if exists public.accounting_statement_runs
  add column if not exists classification_confidence numeric,
  add column if not exists reconciliation_confidence numeric;

comment on column public.accounting_statement_runs.extraction_confidence is
  'Extraction Confidence 0-100: how accurately the document was extracted. Source: the Node extraction pipeline (selection.confidence).';

comment on column public.accounting_statement_runs.classification_confidence is
  'Classification Confidence 0-100: how confidently transactions were categorised. Source: classify_transaction / OpenAI in the accounting worker.';

comment on column public.accounting_statement_runs.reconciliation_confidence is
  'Reconciliation Confidence 0-100: how reliable the reconstructed statement is. Derived from balance, total and continuity checks.';

comment on column public.accounting_statement_runs.confidence is
  'DEPRECATED. Carries the classification score for backwards compatibility only. Read classification_confidence instead. Never an average of the three metrics.';

-- Historical rows: the legacy column has always held the classification score,
-- so backfilling it into the new column is a rename, not a reinterpretation.
-- extraction_confidence and reconciliation_confidence stay NULL for old runs —
-- they were never measured, and NULL is honest where 0 would be a lie.
update public.accounting_statement_runs
   set classification_confidence = confidence
 where classification_confidence is null
   and confidence is not null;

notify pgrst, 'reload schema';
