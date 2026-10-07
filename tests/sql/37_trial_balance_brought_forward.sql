-- Trial balance brought-forward balances (migration 048).
--
-- A dedicated company: a prior year of activity, then a current period.
--   FY2025   Capital 10,000 · Loan 5,000 · Sales 3,000 · Bank charges 500
--            → cash 17,500, profit 2,500
--   current  Sales 1,200 · Bank charges 200 (2026-04 / 2026-05)
set client_min_messages = notice;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);

insert into public.companies (id, workspace_id, is_default, business_name)
values ('22222222-0000-0000-0000-00000000000d', '11111111-0000-0000-0000-000000000001', false, 'Brought Forward (Pty) Ltd');

create or replace function t_bf_account(code_ text) returns uuid language sql as $$
  select id from public.accounting_accounts
  where company_id = '22222222-0000-0000-0000-00000000000d' and code = code_;
$$;

create or replace function t_bf(code_ text, from_ date, to_ date, adjusted boolean default true)
returns table (opening numeric, debits numeric, credits numeric, closing numeric) language sql as $$
  select opening_balance, debits, credits, closing_balance
  from public.accounting_trial_balance('22222222-0000-0000-0000-00000000000d', from_, to_, adjusted)
  where (code_ is null and is_brought_forward) or code = code_;
$$;

-- Signed sum of closing balances (debit positive): zero for any valid TB.
create or replace function t_bf_signed(from_ date, to_ date, adjusted boolean default true)
returns numeric language sql as $$
  select coalesce(sum(case normal_balance when 'debit' then closing_balance else -closing_balance end), 0)
  from public.accounting_trial_balance('22222222-0000-0000-0000-00000000000d', from_, to_, adjusted);
$$;

do $$
declare c uuid := '22222222-0000-0000-0000-00000000000d';
begin
  perform public.accounting_post_journal(t_journal(c, '2025-03-01', t_bf_account('1000'), 10000, t_bf_account('3000'), 10000, 'BF-CAP'));
  perform public.accounting_post_journal(t_journal(c, '2025-06-01', t_bf_account('1000'), 5000, t_bf_account('2000'), 5000, 'BF-LOAN'));
  perform public.accounting_post_journal(t_journal(c, '2025-07-01', t_bf_account('1000'), 3000, t_bf_account('4000'), 3000, 'BF-SALE'));
  perform public.accounting_post_journal(t_journal(c, '2025-08-01', t_bf_account('5000'), 500, t_bf_account('1000'), 500, 'BF-FEE'));
  perform public.accounting_post_journal(t_journal(c, '2026-04-01', t_bf_account('1000'), 1200, t_bf_account('4000'), 1200, 'CUR-SALE'));
  perform public.accounting_post_journal(t_journal(c, '2026-05-01', t_bf_account('5000'), 200, t_bf_account('1000'), 200, 'CUR-FEE'));
end $$;

-- ── No closing journal: prior profit is carried as the unclosed row ─────────
do $$
declare r record; f constant date := '2026-03-01'; t constant date := '2027-02-28';
begin
  select * into r from t_bf('1000', f, t);
  perform t_report('§48.1 period starts after the first posting', r.opening = 17500, format('cash opening=%s', r.opening));
  perform t_report('§48.2 asset closing = brought forward + movement', r.closing = 18500 and r.debits = 1200 and r.credits = 200,
    format('cash closing=%s dr=%s cr=%s', r.closing, r.debits, r.credits));

  select * into r from t_bf('2000', f, t);
  perform t_report('§48.3 liability brought forward with no period activity', r.opening = 5000 and r.closing = 5000,
    format('loan opening=%s closing=%s', r.opening, r.closing));

  select * into r from t_bf('3000', f, t);
  perform t_report('§48.4 equity balance brought forward', r.closing = 10000, format('capital closing=%s', r.closing));

  select * into r from t_bf('4000', f, t);
  perform t_report('§48.5 revenue shows the period only', r.opening = 0 and r.closing = 1200, format('sales opening=%s closing=%s', r.opening, r.closing));
  select * into r from t_bf('5000', f, t);
  perform t_report('§48.5 expense shows the period only', r.opening = 0 and r.closing = 200, format('charges closing=%s', r.closing));

  select * into r from t_bf(null, f, t);
  perform t_report('§48.6 prior-year profit carried as one traceable row', r.closing = 2500, format('unclosed b/f=%s', r.closing));

  perform t_report('§48.8 no-closing-journal TB balances (signed closing sum)', t_bf_signed(f, t) = 0, format('signed sum=%s', t_bf_signed(f, t)));
  perform t_report('§48.9 period debit and credit movements agree',
    (select sum(debits) = sum(credits) from public.accounting_trial_balance('22222222-0000-0000-0000-00000000000d', f, t)));

  -- With no from_date nothing is brought forward: the 038 behaviour exactly.
  perform t_report('§48 whole-history TB has no brought-forward row',
    not exists (select 1 from public.accounting_trial_balance('22222222-0000-0000-0000-00000000000d', null, t) where is_brought_forward));
  select * into r from t_bf('4000', null, t);
  perform t_report('§48 whole-history revenue is all of it', r.closing = 4200, format('sales=%s', r.closing));
  perform t_report('§48 whole-history TB balances', t_bf_signed(null, t) = 0);
end $$;

-- ── Explicit closing journal at the prior year end ──────────────────────────
-- Dr Sales 3,000 · Cr Bank charges 500 · Cr Retained earnings 2,500
do $$
declare c uuid := '22222222-0000-0000-0000-00000000000d'; ws uuid; jid uuid;
begin
  select workspace_id into ws from public.companies where id = c;
  insert into public.accounting_journals (company_id, workspace_id, journal_date, reference, description, journal_type)
  values (c, ws, '2026-02-28', 'FY2025-CLOSE', 'year-end close', 'closing') returning id into jid;
  insert into public.accounting_journal_lines (journal_id, company_id, workspace_id, account_id, line_number, debit, credit) values
    (jid, c, ws, t_bf_account('4000'), 1, 3000, 0),
    (jid, c, ws, t_bf_account('5000'), 2, 0, 500),
    (jid, c, ws, t_bf_account('3100'), 3, 0, 2500);
  perform public.accounting_post_journal(jid);
end $$;

do $$
declare r record; f constant date := '2026-03-01'; t constant date := '2027-02-28';
begin
  perform t_report('§48.7 closed prior profit is not carried twice',
    not exists (select 1 from t_bf(null, f, t)), 'no unclosed row once a closing journal moved it');
  select * into r from t_bf('3100', f, t);
  perform t_report('§48.7 retained earnings carries the closed profit', r.opening = 2500 and r.closing = 2500,
    format('retained earnings opening=%s', r.opening));
  perform t_report('§48.7 equity total unchanged by closing (10,000 + 2,500)',
    (select sum(closing) from (select closing from t_bf('3000', f, t) union all select closing from t_bf('3100', f, t)) e) = 12500);
  perform t_report('§48.7 TB with a closing journal balances', t_bf_signed(f, t) = 0, format('signed sum=%s', t_bf_signed(f, t)));
  perform t_report('§48.7 unadjusted view keeps prior closing journals in the opening',
    (select opening from t_bf('3100', f, t, false)) = 2500 and t_bf_signed(f, t, false) = 0);

  -- Comparative: the prior year on its own is still the prior year's activity.
  select * into r from t_bf('4000', '2025-03-01', '2026-02-27');
  perform t_report('§48 comparative prior-year revenue intact', r.closing = 3000, format('FY2025 sales=%s', r.closing));
end $$;
