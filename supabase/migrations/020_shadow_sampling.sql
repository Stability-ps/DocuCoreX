-- Shadow-mode sampling gate. Azure is only run where it has a realistic chance
-- of improving extraction; statements whose extraction is already complete are
-- SKIPPED and the skip is recorded rather than silently dropped.
--
-- Recording skips matters: "0 sampled candidates in 50 statements" is itself
-- strong evidence that promoting Azure is unjustified, and that only reads if
-- the skipped runs are counted alongside the sampled ones.
alter table if exists public.extraction_shadow_comparisons
  add column if not exists shadow_skipped boolean not null default false,
  add column if not exists shadow_skip_reason text,
  -- The signals behind the decision, so a reviewer can see why it was sampled.
  add column if not exists sample_reason text,
  add column if not exists extraction_confidence numeric,
  add column if not exists reconciliation_confidence numeric,
  add column if not exists reconciliation_difference numeric;

comment on column public.extraction_shadow_comparisons.shadow_skipped is
  'True when the sampling gate skipped this statement — extraction was already complete, so Azure was never called and no cost incurred.';

comment on column public.extraction_shadow_comparisons.shadow_skip_reason is
  'Why the statement was skipped. Null when it was sampled.';

comment on column public.extraction_shadow_comparisons.sample_reason is
  'Why the statement WAS sampled — the extraction shortfall that made Azure worth trying. Null when skipped.';

create index if not exists extraction_shadow_comparisons_skipped_idx
  on public.extraction_shadow_comparisons (workspace_id, shadow_skipped, created_at desc);

notify pgrst, 'reload schema';
