-- Shared rate-limit counters (050).
set client_min_messages = notice;

-- Counts within a window, refuses past the limit, and reports when to retry.
do $$
declare r record; i int; allowed_count int := 0; last record;
begin
  for i in 1..5 loop
    select * into r from public.consume_rate_limit('test:counts', 3, 3600);
    if r.allowed then allowed_count := allowed_count + 1; end if;
    last := r;
  end loop;
  perform t_report('§50 a key is allowed exactly limit times per window', allowed_count = 3, format('allowed %s of 5', allowed_count));
  perform t_report('§50 a refused call says when to retry', not last.allowed and last.retry_after_ms > 0 and last.retry_after_ms <= 3600 * 1000,
    format('retry_after_ms=%s', last.retry_after_ms));
end $$;

-- Keys are independent.
do $$
declare r record;
begin
  select * into r from public.consume_rate_limit('test:other-key', 3, 3600);
  perform t_report('§50 one key''s hits do not count against another', r.allowed);
end $$;

-- A finished window does not count; the key's old rows are cleared.
do $$
declare r record; leftover int;
begin
  insert into public.rate_limit_windows (key, window_start, hits) values ('test:stale', now() - interval '2 hours', 999);
  select * into r from public.consume_rate_limit('test:stale', 3, 3600);
  select count(*) into leftover from public.rate_limit_windows where key = 'test:stale' and window_start < now() - interval '1 hour';
  perform t_report('§50 hits from a finished window do not count', r.allowed);
  perform t_report('§50 the key''s finished windows are deleted', leftover = 0, format('%s stale rows left', leftover));
end $$;

-- Bad arguments are refused rather than creating odd rows.
do $$
declare refused int := 0;
begin
  begin perform public.consume_rate_limit('', 3, 60); exception when others then refused := refused + 1; end;
  begin perform public.consume_rate_limit('k', 0, 60); exception when others then refused := refused + 1; end;
  begin perform public.consume_rate_limit('k', 3, 0); exception when others then refused := refused + 1; end;
  begin perform public.consume_rate_limit('k', 3, 86401); exception when others then refused := refused + 1; end;
  begin perform public.consume_rate_limit(repeat('k', 201), 3, 60); exception when others then refused := refused + 1; end;
  perform t_report('§50 invalid arguments are refused', refused = 5, format('%s of 5 refused', refused));
end $$;

-- Client roles can neither call the function nor touch the table.
do $$
declare blocked int := 0;
begin
  begin set local role anon; perform public.consume_rate_limit('test:anon', 3, 60); exception when insufficient_privilege then blocked := blocked + 1; end;
  reset role;
  begin set local role authenticated; perform public.consume_rate_limit('test:auth', 3, 60); exception when insufficient_privilege then blocked := blocked + 1; end;
  reset role;
  begin set local role authenticated; perform count(*) from public.rate_limit_windows; exception when insufficient_privilege then blocked := blocked + 1; end;
  reset role;
  begin set local role anon; delete from public.rate_limit_windows; exception when insufficient_privilege then blocked := blocked + 1; end;
  reset role;
  perform t_report('§50 anon and authenticated cannot call it or read/write the table', blocked = 4, format('%s of 4 blocked', blocked));
end $$;

-- The service role can.
do $$
declare r record;
begin
  set local role service_role;
  select * into r from public.consume_rate_limit('test:service', 3, 60);
  reset role;
  perform t_report('§50 the service role can consume a limit', r.allowed);
end $$;

delete from public.rate_limit_windows where key like 'test:%';
