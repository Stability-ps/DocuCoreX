-- §5 balanced, §6 unbalanced, §7 cent precision.
set client_min_messages = notice;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);


-- ── §5 BALANCED JOURNAL ─────────────────────────────────────────────────────
do $$
declare
  jid uuid; n int; d numeric; c numeric; st text;
  right_entity boolean; right_date boolean; right_accounts boolean; in_fy boolean;
begin
  jid := t_journal('22222222-0000-0000-0000-00000000000a', '2025-06-15', '44444444-0000-0000-0000-000000001100', 1000.00, '44444444-0000-0000-0000-000000002100', 1000.00, 'JV-001');
  perform public.accounting_post_journal(jid);

  select count(*), sum(debit), sum(credit) into n, d, c
  from public.accounting_postings where journal_id = jid;
  select status into st from public.accounting_journals where id = jid;

  select bool_and(company_id = '22222222-0000-0000-0000-00000000000a')          into right_entity   from public.accounting_postings where journal_id = jid;
  select bool_and(posting_date = '2025-06-15') into right_date  from public.accounting_postings where journal_id = jid;
  select (count(*) = 2) into right_accounts from public.accounting_postings
    where journal_id = jid and account_id in ('44444444-0000-0000-0000-000000001100', '44444444-0000-0000-0000-000000002100');
  -- The financial year is derived from the posting date rather than stored.
  select exists (
    select 1 from public.accounting_financial_years fy
    where fy.company_id = '22222222-0000-0000-0000-00000000000a' and '2025-06-15' between fy.start_date and fy.end_date
  ) into in_fy;

  perform t_report('§5 journal becomes posted', st = 'posted', format('status=%s', st));
  perform t_report('§5 exactly two posting rows', n = 2, format('rows=%s', n));
  perform t_report('§5 debits = credits = 1000.00', d = 1000.00 and c = 1000.00,
    format('dr=%s cr=%s diff=%s', d, c, d - c));
  perform t_report('§5 correct entity', right_entity);
  perform t_report('§5 correct posting date', right_date);
  perform t_report('§5 correct accounts', right_accounts);
  perform t_report('§5 date falls in the entity financial year', in_fy, 'FY2026 2025-03-01..2026-02-28');
end $$;

-- ── §6 UNBALANCED JOURNAL ───────────────────────────────────────────────────
do $$
declare jid uuid; n int; st text; raised boolean := false; msg text; before_rows int;
begin
  select count(*) into before_rows from public.accounting_postings;
  jid := t_journal('22222222-0000-0000-0000-00000000000a', '2025-06-16', '44444444-0000-0000-0000-000000001100', 1000.00, '44444444-0000-0000-0000-000000002100', 999.99, 'JV-002');
  begin
    perform public.accounting_post_journal(jid);
  exception when others then raised := true; msg := sqlerrm;
  end;

  select count(*) into n from public.accounting_postings where journal_id = jid;
  select status into st from public.accounting_journals where id = jid;

  perform t_report('§6 posting rejected', raised, coalesce(msg, 'no error raised'));
  perform t_report('§6 no posting rows for that journal', n = 0, format('rows=%s', n));
  perform t_report('§6 no partial posting anywhere',
    (select count(*) from public.accounting_postings) = before_rows);
  perform t_report('§6 journal remains draft', st = 'draft', format('status=%s', st));
end $$;

-- ── §7 CENT-LEVEL PRECISION ─────────────────────────────────────────────────
do $$
declare
  jid uuid; ws uuid; d numeric; c numeric; vals numeric[]; col_type text;
begin
  select workspace_id into ws from public.companies where id = '22222222-0000-0000-0000-00000000000a';
  insert into public.accounting_journals (company_id, workspace_id, journal_date, reference)
  values ('22222222-0000-0000-0000-00000000000a', ws, '2025-06-17', 'JV-CENTS') returning id into jid;

  -- 0.10 + 0.20 + 0.30 + 1234.56 + 99999.99 = 101235.15
  insert into public.accounting_journal_lines (journal_id, company_id, workspace_id, account_id, line_number, debit, credit) values
    (jid, '22222222-0000-0000-0000-00000000000a', ws, '44444444-0000-0000-0000-000000001100', 1, 0.10, 0),
    (jid, '22222222-0000-0000-0000-00000000000a', ws, '44444444-0000-0000-0000-000000001100', 2, 0.20, 0),
    (jid, '22222222-0000-0000-0000-00000000000a', ws, '44444444-0000-0000-0000-000000001100', 3, 0.30, 0),
    (jid, '22222222-0000-0000-0000-00000000000a', ws, '44444444-0000-0000-0000-000000001100', 4, 1234.56, 0),
    (jid, '22222222-0000-0000-0000-00000000000a', ws, '44444444-0000-0000-0000-000000001100', 5, 99999.99, 0),
    (jid, '22222222-0000-0000-0000-00000000000a', ws, '44444444-0000-0000-0000-000000002100', 6, 0, 101235.15);

  perform public.accounting_post_journal(jid);
  select sum(debit), sum(credit) into d, c from public.accounting_postings where journal_id = jid;
  select array_agg(debit order by debit) into vals
    from public.accounting_postings where journal_id = jid and debit > 0;

  select format_type(a.atttypid, a.atttypmod) into col_type
  from pg_attribute a
  where a.attrelid = 'public.accounting_postings'::regclass and a.attname = 'debit';

  perform t_report('§7 amounts stored as exact decimal', col_type = 'numeric(18,2)', format('column type=%s', col_type));
  perform t_report('§7 0.10 + 0.20 + 0.30 sums exactly to 0.60',
    (select sum(debit) from public.accounting_postings where journal_id = jid and debit < 1) = 0.60,
    format('sum=%s', (select sum(debit) from public.accounting_postings where journal_id = jid and debit < 1)));
  perform t_report('§7 journal balances to the cent', d = c and d = 101235.15, format('dr=%s cr=%s', d, c));
  perform t_report('§7 no floating-point drift in stored values',
    vals::text = '{0.10,0.20,0.30,1234.56,99999.99}', format('values=%s', vals::text));
  -- The contrast that makes the point: the same arithmetic in float8.
  perform t_report('§7 (control) float8 would drift',
    (0.1::float8 + 0.2::float8) <> 0.3::float8,
    format('float8 0.1+0.2 = %s', (0.1::float8 + 0.2::float8)::text));
end $$;