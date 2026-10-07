-- Every function this schema defines pins its search_path (migration 047).
--
-- A function without one resolves names against the caller's session path. For
-- a SECURITY DEFINER function that is an escalation route; for the ledger guards
-- it would make their behaviour depend on who calls them. Checked as a single
-- invariant so a new function that forgets the clause fails here.
set client_min_messages = notice;

do $$
declare unpinned text;
begin
  select string_agg(p.proname, ', ' order by p.proname) into unpinned
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     -- t_report / t_journal are this harness's own helpers (20_helpers.sql).
     and p.proname not like 't\_%'
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     and p.prolang in (select oid from pg_language where lanname in ('plpgsql', 'sql'))
     and not exists (
       select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'
     );
  perform t_report('§47 every public function pins search_path', unpinned is null,
    coalesce('unpinned: ' || unpinned, 'none unpinned'));
end $$;
