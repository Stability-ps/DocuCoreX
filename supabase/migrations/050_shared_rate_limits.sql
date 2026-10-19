-- Shared rate-limit counters.
--
-- lib/rate-limit.ts kept its counters in a per-process Map. On Vercel every
-- function instance has its own Map, so a limit of 10 sign-ins per 15 minutes
-- was 10 per instance, and a burst spread across instances was barely limited
-- at all. These counters live in Postgres, so every instance shares them.
--
-- Fixed windows: a key's hits are counted per window of p_window_seconds,
-- aligned to the epoch. Keys are built server-side and hold no raw IP address
-- or user id, only a truncated SHA-256 of one (lib/shared-rate-limit.ts).
--
-- Only the service role may call consume_rate_limit or touch the table. If anon
-- or authenticated could call it, anyone could exhaust someone else's key (for
-- example a victim's sign-in bucket) by calling the RPC directly.
--
-- Safe to apply before or after the code that uses it: until it exists, the
-- RPC fails and the app falls back to the per-process limiter it has today.
--
-- Covered by tests/sql/39_shared_rate_limits.sql.

create table if not exists public.rate_limit_windows (
  key text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (key, window_start)
);

alter table public.rate_limit_windows enable row level security;
-- No policies on purpose: no client role reads or writes this table.
revoke all on table public.rate_limit_windows from public, anon, authenticated;
grant select, insert, update, delete on table public.rate_limit_windows to service_role;

create or replace function public.consume_rate_limit(p_key text, p_limit integer, p_window_seconds integer)
returns table (allowed boolean, retry_after_ms integer)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_window_start timestamptz;
  v_hits integer;
begin
  if p_key is null or length(p_key) = 0 or length(p_key) > 200
     or p_limit is null or p_limit < 1
     or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'consume_rate_limit: invalid arguments';
  end if;

  v_window_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  -- One statement, so concurrent callers cannot both read the old count.
  insert into public.rate_limit_windows as w (key, window_start, hits)
  values (p_key, v_window_start, 1)
  on conflict (key, window_start) do update set hits = w.hits + 1
  returning w.hits into v_hits;

  -- Housekeeping: this key's finished windows, and now and then everyone's
  -- windows older than a day (the longest window allowed).
  delete from public.rate_limit_windows where key = p_key and window_start < v_window_start;
  if random() < 0.01 then
    delete from public.rate_limit_windows where window_start < now() - interval '1 day';
  end if;

  allowed := v_hits <= p_limit;
  retry_after_ms := case
    when allowed then 0
    else greatest(0, ceil(extract(epoch from (v_window_start + make_interval(secs => p_window_seconds) - now())) * 1000))::integer
  end;
  return next;
end $$;

revoke all on function public.consume_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer) to service_role;
