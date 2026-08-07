-- Classification provenance on the transaction.
--
-- Until now a transaction recorded WHAT it was classified as and a single
-- `confidence` number, but nothing about WHO decided or on what evidence. The
-- review UI reconstructed the source by reading the number: >=90 was shown as
-- "Rule", 70-89 as "Learned", below 70 as "AI". None of that was true. On a real
-- 615-row statement it labelled 434 unresolved rows as AI-classified when AI had
-- never seen them — and could not have, since AI classification runs during
-- workbook export, after these rows are written.
--
-- A reviewer deciding whether to trust a category needs to know where it came
-- from. That is a fact to record, not a number to infer.
--
--   classification_source     — who decided
--   classification_strength   — how much weight that decision carries
--   classification_confidence — how sure THAT decision is, which is not how
--                               accurately the row was extracted
--   classification_reason     — the evidence, in words, for the review screen
--   normalized_merchant       — the merchant behind the bank's wording, kept
--                               SEPARATE so the original description is never
--                               overwritten. Reserved; nothing writes it yet.
--
-- All nullable. Rows written before this migration have no provenance, and NULL
-- says so honestly where a default would invent one.
alter table if exists public.accounting_transactions
  add column if not exists classification_source text,
  add column if not exists classification_strength text,
  add column if not exists classification_confidence numeric(5,2),
  add column if not exists classification_reason text,
  add column if not exists normalized_merchant text;

comment on column public.accounting_transactions.classification_source is
  'Who classified this row: deterministic | learned_rule | ai | manual | unresolved. NULL for rows written before provenance was recorded.';

comment on column public.accounting_transactions.classification_strength is
  'Standing of the deciding rule: hard | learned | soft | none. Decides what a later stage may revise.';

comment on column public.accounting_transactions.classification_confidence is
  'Classification Confidence 0-100: how sure we are of the CATEGORY. Never the extraction confidence — a row can be read perfectly and still be hard to categorise.';

comment on column public.accounting_transactions.classification_reason is
  'The evidence for the classification, in words, for the review screen.';

comment on column public.accounting_transactions.normalized_merchant is
  'Merchant identified behind the bank wording. Stored separately: `description` is bank evidence and is never overwritten. Reserved for the merchant-normalisation change.';

comment on column public.accounting_transactions.confidence is
  'DEPRECATED for classification. Carries the legacy per-row score; read classification_confidence instead. For AI-recovered rows this is capped as an EXTRACTION signal (see the AI recovery cap) and must not be raised by classification.';

-- No backfill. The legacy `confidence` column cannot tell us who decided, which
-- is the entire point of this migration; guessing a source for historical rows
-- would recreate the defect it exists to remove.

notify pgrst, 'reload schema';
