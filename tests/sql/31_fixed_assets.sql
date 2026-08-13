-- Stage 7A: fixed assets — a register, depreciation, and disposal.
set client_min_messages = notice;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);

-- ── SEEDED STARTER ACCOUNTS ──────────────────────────────────────────────────
do $$
declare cost_acct uuid; gain_acct uuid;
begin
  select id into cost_acct from public.accounting_accounts
   where company_id = '22222222-0000-0000-0000-00000000000a' and code = '1500';
  select id into gain_acct from public.accounting_accounts
   where company_id = '22222222-0000-0000-0000-00000000000a' and code = '4900';
  perform t_report('§31 Fixed Assets at Cost was seeded onto the existing entity', cost_acct is not null);
  perform t_report('§31 Gain/Loss on Disposal was seeded onto the existing entity', gain_acct is not null);
end $$;

-- ── REGISTER, BEFORE ANY DEPRECIATION ────────────────────────────────────────
do $$
declare target_asset uuid;
begin
  insert into public.accounting_fixed_assets (
    company_id, workspace_id, description, asset_account_id, accumulated_depreciation_account_id,
    acquisition_date, cost, residual_value, depreciation_method, useful_life_months
  ) values (
    '22222222-0000-0000-0000-00000000000a',
    (select workspace_id from public.companies where id = '22222222-0000-0000-0000-00000000000a'),
    'Test Vehicle 1', '44444444-0000-0000-0000-000000001510', '44444444-0000-0000-0000-000000001590',
    '2026-11-01', 240000.00, 40000.00, 'straight_line', 60
  ) returning id into target_asset;

  perform t_report('§31 a new asset carries zero accumulated depreciation',
    (select accumulated_depreciation from public.accounting_fixed_asset_register('22222222-0000-0000-0000-00000000000a', '2026-11-30') where asset_id = target_asset) = 0);
  perform t_report('§31 net book value starts at cost',
    (select net_book_value from public.accounting_fixed_asset_register('22222222-0000-0000-0000-00000000000a', '2026-11-30') where asset_id = target_asset) = 240000.00);
end $$;

-- ── CONSTRAINTS ───────────────────────────────────────────────────────────────
do $$
declare ws uuid; refused boolean;
begin
  select workspace_id into ws from public.companies where id = '22222222-0000-0000-0000-00000000000a';

  refused := false;
  begin
    insert into public.accounting_fixed_assets (company_id, workspace_id, description, asset_account_id, accumulated_depreciation_account_id, acquisition_date, cost, depreciation_method, useful_life_months, depreciation_rate_percent)
    values ('22222222-0000-0000-0000-00000000000a', ws, 'Bad method', '44444444-0000-0000-0000-000000001510', '44444444-0000-0000-0000-000000001590', '2026-11-01', 1000, 'straight_line', 60, 20);
  exception when others then refused := true;
  end;
  perform t_report('§31 straight-line with a rate percent as well is refused', refused);

  refused := false;
  begin
    insert into public.accounting_fixed_assets (company_id, workspace_id, description, asset_account_id, accumulated_depreciation_account_id, acquisition_date, cost, residual_value)
    values ('22222222-0000-0000-0000-00000000000a', ws, 'Bad residual', '44444444-0000-0000-0000-000000001510', '44444444-0000-0000-0000-000000001590', '2026-11-01', 1000, 5000);
  exception when others then refused := true;
  end;
  perform t_report('§31 residual value exceeding cost is refused', refused);

  refused := false;
  begin
    insert into public.accounting_fixed_assets (company_id, workspace_id, description, asset_account_id, accumulated_depreciation_account_id, acquisition_date, cost)
    values ('22222222-0000-0000-0000-00000000000a', ws, 'Same account twice', '44444444-0000-0000-0000-000000001510', '44444444-0000-0000-0000-000000001510', '2026-11-01', 1000);
  exception when others then refused := true;
  end;
  perform t_report('§31 the asset account and its own accumulated depreciation account must differ', refused);

  refused := false;
  begin
    insert into public.accounting_fixed_assets (company_id, workspace_id, description, asset_account_id, accumulated_depreciation_account_id, acquisition_date, cost, disposal_date)
    values ('22222222-0000-0000-0000-00000000000a', ws, 'Disposed with no proceeds stated', '44444444-0000-0000-0000-000000001510', '44444444-0000-0000-0000-000000001590', '2026-01-01', 1000, '2026-11-01');
  exception when others then refused := true;
  end;
  perform t_report('§31 a disposal date with no proceeds figure is refused', refused);
end $$;

-- ── A DEPRECIATION JOURNAL IS LOGGED AS A MOVEMENT, AND THE REGISTER SEES IT ──
do $$
declare target_asset uuid; jid uuid; ad numeric; nbv numeric;
begin
  select id into target_asset from public.accounting_fixed_assets
   where company_id = '22222222-0000-0000-0000-00000000000a' and description = 'Test Vehicle 1';
  perform t_report('§31 the asset from the previous block is still there', target_asset is not null);

  jid := t_journal('22222222-0000-0000-0000-00000000000a', '2026-11-30',
    '44444444-0000-0000-0000-000000006200', 3333.33,
    '44444444-0000-0000-0000-000000001590', 3333.33, 'DEP-NOV');
  perform public.accounting_post_journal(jid);

  insert into public.accounting_asset_movements (fixed_asset_id, company_id, workspace_id, journal_id, movement_type, movement_date)
  values (target_asset, '22222222-0000-0000-0000-00000000000a',
    (select workspace_id from public.companies where id = '22222222-0000-0000-0000-00000000000a'),
    jid, 'depreciation', '2026-11-30');

  select accumulated_depreciation, net_book_value into ad, nbv
    from public.accounting_fixed_asset_register('22222222-0000-0000-0000-00000000000a', '2026-11-30')
   where asset_id = target_asset;
  perform t_report('§31 accumulated depreciation reflects the posted journal', ad = 3333.33, format('ad=%s', ad));
  perform t_report('§31 net book value is cost less accumulated depreciation', nbv = 236666.67, format('nbv=%s', nbv));

  perform t_report('§31 asAt before the posting date sees none of it',
    (select accumulated_depreciation from public.accounting_fixed_asset_register('22222222-0000-0000-0000-00000000000a', '2026-11-29') where asset_id = target_asset) = 0);
end $$;

-- ── ONE DEPRECIATION MOVEMENT PER ASSET PER MONTH ────────────────────────────
do $$
declare target_asset uuid; jid uuid; refused boolean := false;
begin
  select id into target_asset from public.accounting_fixed_assets
   where company_id = '22222222-0000-0000-0000-00000000000a' and description = 'Test Vehicle 1';

  jid := t_journal('22222222-0000-0000-0000-00000000000a', '2026-11-30',
    '44444444-0000-0000-0000-000000006200', 100.00,
    '44444444-0000-0000-0000-000000001590', 100.00, 'DEP-NOV-DUP');
  perform public.accounting_post_journal(jid);

  begin
    insert into public.accounting_asset_movements (fixed_asset_id, company_id, workspace_id, journal_id, movement_type, movement_date)
    values (target_asset, '22222222-0000-0000-0000-00000000000a',
      (select workspace_id from public.companies where id = '22222222-0000-0000-0000-00000000000a'),
      jid, 'depreciation', '2026-11-30');
  exception when others then refused := true;
  end;
  perform t_report('§31 a second depreciation movement in the same month is refused', refused);

  -- A different month is unaffected.
  refused := false;
  jid := t_journal('22222222-0000-0000-0000-00000000000a', '2026-12-31',
    '44444444-0000-0000-0000-000000006200', 3333.33,
    '44444444-0000-0000-0000-000000001590', 3333.33, 'DEP-DEC');
  perform public.accounting_post_journal(jid);
  begin
    insert into public.accounting_asset_movements (fixed_asset_id, company_id, workspace_id, journal_id, movement_type, movement_date)
    values (target_asset, '22222222-0000-0000-0000-00000000000a',
      (select workspace_id from public.companies where id = '22222222-0000-0000-0000-00000000000a'),
      jid, 'depreciation', '2026-12-31');
  exception when others then refused := true;
  end;
  perform t_report('§31 the next calendar month is not blocked by this month''s movement', not refused);

  perform t_report('§31 two months of depreciation accumulate',
    (select accumulated_depreciation from public.accounting_fixed_asset_register('22222222-0000-0000-0000-00000000000a', '2026-12-31') where asset_id = target_asset) = 6666.66);
end $$;

-- ── A SHARED ACCUMULATED-DEPRECIATION ACCOUNT DOES NOT CROSS-CONTAMINATE ─────
do $$
declare target_asset1 uuid; target_asset2 uuid; cost_acct uuid; jid uuid; ad1 numeric; ad2 numeric;
begin
  select id into target_asset1 from public.accounting_fixed_assets
   where company_id = '22222222-0000-0000-0000-00000000000a' and description = 'Test Vehicle 1';
  select id into cost_acct from public.accounting_accounts
   where company_id = '22222222-0000-0000-0000-00000000000a' and code = '1500';

  -- Same accumulated-depreciation control account (1590) as asset 1, but a
  -- different asset account and its own separate journals.
  insert into public.accounting_fixed_assets (
    company_id, workspace_id, description, asset_account_id, accumulated_depreciation_account_id,
    acquisition_date, cost, residual_value, depreciation_method, depreciation_rate_percent
  ) values (
    '22222222-0000-0000-0000-00000000000a',
    (select workspace_id from public.companies where id = '22222222-0000-0000-0000-00000000000a'),
    'Test Equipment 2', cost_acct, '44444444-0000-0000-0000-000000001590',
    '2026-11-01', 10000.00, 0, 'reducing_balance', 20
  ) returning id into target_asset2;

  jid := t_journal('22222222-0000-0000-0000-00000000000a', '2026-11-30',
    '44444444-0000-0000-0000-000000006200', 166.67,
    '44444444-0000-0000-0000-000000001590', 166.67, 'DEP-NOV-EQUIP');
  perform public.accounting_post_journal(jid);
  insert into public.accounting_asset_movements (fixed_asset_id, company_id, workspace_id, journal_id, movement_type, movement_date)
  values (target_asset2, '22222222-0000-0000-0000-00000000000a',
    (select workspace_id from public.companies where id = '22222222-0000-0000-0000-00000000000a'),
    jid, 'depreciation', '2026-11-30');

  select accumulated_depreciation into ad1 from public.accounting_fixed_asset_register('22222222-0000-0000-0000-00000000000a', '2026-11-30') where asset_id = target_asset1;
  select accumulated_depreciation into ad2 from public.accounting_fixed_asset_register('22222222-0000-0000-0000-00000000000a', '2026-11-30') where asset_id = target_asset2;

  perform t_report('§31 asset 1 is unaffected by asset 2 posting to the same control account', ad1 = 3333.33, format('ad1=%s', ad1));
  perform t_report('§31 asset 2 carries only its own postings to that shared account', ad2 = 166.67, format('ad2=%s', ad2));
end $$;

-- ── DISPOSAL IS A RECOGNISED JOURNAL TYPE ────────────────────────────────────
do $$
declare jid uuid; posted_status text;
begin
  jid := t_journal('22222222-0000-0000-0000-00000000000a', '2026-11-30',
    '44444444-0000-0000-0000-000000001590', 100.00,
    '44444444-0000-0000-0000-000000001510', 100.00, 'DISP-TEST');
  update public.accounting_journals set journal_type = 'disposal' where id = jid;
  perform public.accounting_post_journal(jid);
  select status into posted_status from public.accounting_journals where id = jid;
  perform t_report('§31 a disposal journal posts through the ordinary gate', posted_status = 'posted');
end $$;
