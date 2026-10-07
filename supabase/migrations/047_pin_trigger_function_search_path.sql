-- Pin search_path on the ledger-integrity trigger functions.
--
-- These six were the only functions in the schema declared without
-- `set search_path`. They are SECURITY INVOKER and every table they touch is
-- schema-qualified, so nothing here is exploitable today; pinning the path
-- makes their resolution independent of the caller's session settings, the
-- same as every other function in this schema. Behaviour is unchanged.
--
-- Covered by tests/sql/36_function_search_path.sql.

alter function public.accounting_postings_only_via_gate() set search_path = public;
alter function public.accounting_postings_are_append_only() set search_path = public;
alter function public.accounting_journal_lines_frozen_once_posted() set search_path = public;
alter function public.accounting_reconciliation_items_frozen_when_complete() set search_path = public;
alter function public.accounting_audit_events_are_append_only() set search_path = public;
alter function public.accounting_import_are_append_only() set search_path = public;
