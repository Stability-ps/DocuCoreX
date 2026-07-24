-- Migration 016: processing-job idempotency + stale-job support.
--
-- Enforce AT MOST ONE active (queued/running) processing job per (document_id,
-- type). Repeated clicks, refreshes, retries, or concurrent API requests can no
-- longer create duplicate OCR/extraction jobs — a concurrent insert that races
-- past the application-level check is rejected by the database (unique violation),
-- and the caller attaches to the existing job instead. Completed/failed/cancelled
-- jobs are excluded, so a document can be re-processed once a prior run finishes.
create unique index if not exists processing_jobs_one_active_per_doc_type
  on public.processing_jobs (document_id, type)
  where status in ('queued', 'running');

-- Supports fast lookup of active jobs and age-based stale-job reclamation
-- (a job whose serverless worker died leaves a stuck 'running' row).
create index if not exists processing_jobs_active_updated_idx
  on public.processing_jobs (status, updated_at)
  where status in ('queued', 'running');
