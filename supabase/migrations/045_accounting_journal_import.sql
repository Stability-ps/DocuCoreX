-- Bulk journal import: the traceability link, and the duplicate-import
-- backstop.
-- Stage 8B of docs/ACCOUNTING_WORKSPACE_PLAN.md.
--
-- IDEMPOTENCY IS ENFORCED HERE, NOT ONLY IN THE APPLICATION. The application
-- checks, at preview time, whether a journal reference has already been
-- imported for this entity, and reports it as a rejected group with a clear
-- reason. That check alone is a UI convenience, not a control — nothing stops
-- the same file being validated twice from two open tabs and committed
-- twice. The partial unique index below is what actually prevents it: two
-- IMPORTED journals for one entity may not share a reference. A manually
-- created journal (import_batch_id null) is unaffected — accountants have
-- always been free to reuse reference text, and this migration does not
-- change that.
--
-- GROUP-LEVEL VALIDATION LIVES IN THE APPLICATION, NOT HERE. A journal is one
-- accounting unit — one bad line rejects every line sharing its reference,
-- never just the bad one — but that rule is about which ROWS become a
-- journal in the first place, decided before accounting_post_journal is ever
-- called. There is nothing for the database to additionally enforce beyond
-- the balance and tagging rules it already has.

alter table public.accounting_journals
  add column if not exists import_batch_id uuid references public.accounting_import_batches(id) on delete set null;

create unique index if not exists accounting_journals_one_import_per_reference
  on public.accounting_journals (company_id, lower(trim(reference)))
  where import_batch_id is not null and reference is not null;

create index if not exists accounting_journals_import_batch_idx
  on public.accounting_journals (import_batch_id) where import_batch_id is not null;
