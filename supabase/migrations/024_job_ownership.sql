-- Job ownership, so a caller timeout stops turning finished work into a failure.
--
-- Processing used to be owned end to end by the Vercel function: it called the
-- worker over HTTP and waited. When that wait ran out — 254s of a 280s budget,
-- with ~26s already spent on pre-extraction — the caller marked the run failed.
-- The worker did not stop. FastAPI does not cancel a running handler when the
-- client disconnects, and the worker writes run state itself, so it carried on
-- and could complete AFTER the run had been marked failed. Two writers, no
-- coordination, and a run whose recorded status depended on which one wrote last.
--
-- Ownership is now explicit and hands over at one point:
--
--   Vercel owns dispatch. It may fail a run only for a dispatch failure —
--   validation, auth, unreachable worker, no acceptance.
--
--   Render owns everything after it returns 202. From that moment Vercel must
--   not write a terminal state, however its own execution ends.
--
-- active_job_id is the fence. Every worker write is conditional on it, so a
-- superseded worker — one whose job was replaced by an explicit Force Reprocess
-- — matches zero rows and cannot overwrite the current attempt's results.
--
-- No status values are added: 'dispatching' exists only in the Vercel flow
-- between the existing 'queued' and 'processing', so the status CHECK constraint
-- from 003 is untouched and every existing reader keeps working.
--
-- processing_job_id is deliberately left alone. It remains the historical link
-- to the most recent processing_jobs row; active_job_id is the authorisation to
-- write, and conflating the two would make the fence ambiguous.

alter table public.accounting_statement_runs
  -- The one job permitted to write to this run. Null means no attempt is
  -- claimed: nothing is fenced in, so nothing is fenced out.
  add column if not exists active_job_id uuid,
  -- When Render acknowledged the job. This is the ownership handover: after
  -- this timestamp exists, a Vercel-side failure is not this run's failure.
  -- Also the reference point for stale-progress detection — a run accepted long
  -- ago with no movement is recoverable by explicit Reprocess, never
  -- automatically retried.
  add column if not exists job_accepted_at timestamptz,
  -- When a previous job was retired by Force Reprocess. Kept for diagnosis: a
  -- rejected stale write is expected here, not a defect.
  add column if not exists job_superseded_at timestamptz;

-- Progress writes arrive as "update this run where active_job_id = mine", which
-- is the hot path for every stage transition on every in-flight statement.
create index if not exists accounting_statement_runs_active_job_idx
  on public.accounting_statement_runs (id, active_job_id);

-- Finding runs that were accepted and then went quiet, for the stale-progress
-- indicator. Partial: only accepted, non-terminal runs can be stale.
create index if not exists accounting_statement_runs_stale_idx
  on public.accounting_statement_runs (job_accepted_at)
  where status = 'processing';

comment on column public.accounting_statement_runs.active_job_id is
  'The processing job authorised to write to this run. Worker writes are conditional on it; a superseded job matches zero rows and is rejected.';
comment on column public.accounting_statement_runs.job_accepted_at is
  'When the worker returned 202 and took ownership. After this, Vercel must not mark the run failed.';
comment on column public.accounting_statement_runs.job_superseded_at is
  'When a previous job was retired by an explicit Force Reprocess.';
