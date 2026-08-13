-- Daily run caps for this app.
--
-- The Gemini key now lives in an Edge Function rather than in each seller's
-- browser, which means every run spends the owner's quota instead of the
-- seller's own. One seller looping the flow could exhaust it for everybody, so
-- runs are counted and capped per account per day.
--
-- Run this on the shared Supabase project after supabase/profiles.sql, which is
-- where has_app_access() comes from.

-- What counts as "today".
--
-- The sellers are in Montreal, so a UTC day would roll the cap over at 8pm
-- local — someone would be cut off mid-evening and freed again before bed. The
-- day is the seller's day.
create or replace function public.app_day()
  returns date language sql stable
  set search_path = public
as $$
  select (now() at time zone 'America/Toronto')::date;
$$;

create table if not exists public.app_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  app     text not null,
  day     date not null default public.app_day(),
  runs    int  not null default 0,
  primary key (user_id, app, day)
);

-- How many runs a day an account gets.
--
-- A row with a null user_id is the default for the whole app; a row naming a
-- user overrides it for that one account. Raising someone's limit is an insert,
-- not a deploy — the same principle as the access grant itself.
create table if not exists public.app_run_limits (
  app         text not null,
  user_id     uuid references auth.users(id) on delete cascade,
  daily_limit int  not null check (daily_limit >= 0),
  unique nulls not distinct (app, user_id)
);

alter table public.app_usage      enable row level security;
alter table public.app_run_limits enable row level security;

-- A seller may read their own counter and the limit that applies to them, which
-- is what the app shows in the UI. Nobody may write either from the browser:
-- the counter is incremented by the Edge Function with the service role, so a
-- seller cannot award themselves more runs by calling PostgREST directly.
drop policy if exists "app_usage select policy" on public.app_usage;
create policy "app_usage select policy" on public.app_usage
  for select to authenticated
  using (public.has_app_access(app) and auth.uid() = user_id);

drop policy if exists "app_run_limits select policy" on public.app_run_limits;
create policy "app_run_limits select policy" on public.app_run_limits
  for select to authenticated
  using (public.has_app_access(app));

-- The default allowance. Each photo analysis and each listing generation is one
-- run, so 25 is roughly a dozen complete listings a day.
insert into public.app_run_limits (app, user_id, daily_limit)
values ('fb-marketplace', null, 25)
on conflict (app, user_id) do nothing;

/* ── Reading the quota ──────────────────────────────────────────── */

create or replace function public.app_run_limit(app_name text, who uuid default auth.uid())
  returns int language sql stable security definer
  set search_path = public
as $$
  select coalesce(
    (select daily_limit from public.app_run_limits where app = app_name and user_id = who),
    (select daily_limit from public.app_run_limits where app = app_name and user_id is null),
    0
  );
$$;

create or replace function public.app_runs_today(app_name text, who uuid default auth.uid())
  returns int language sql stable security definer
  set search_path = public
as $$
  select coalesce(
    (select runs from public.app_usage
      where user_id = who and app = app_name and day = public.app_day()),
    0);
$$;

-- What the app puts on screen: used, the limit, and what is left.
create or replace function public.app_quota(app_name text)
  returns json language sql stable security definer
  set search_path = public
as $$
  select json_build_object(
    'used',      public.app_runs_today(app_name),
    'limit',     public.app_run_limit(app_name),
    'remaining', greatest(public.app_run_limit(app_name) - public.app_runs_today(app_name), 0)
  );
$$;

/* ── Spending a run ─────────────────────────────────────────────── */

-- Called by the Edge Function once a Gemini call has actually succeeded, so a
-- failed or retried request costs the seller nothing.
--
-- Returns how many runs remain after this one. The insert is atomic, so two
-- requests arriving together cannot both read the same count and double-spend.
create or replace function public.record_app_run(app_name text, who uuid)
  returns int language plpgsql security definer
  set search_path = public
as $$
declare
  used int;
begin
  insert into public.app_usage (user_id, app, day, runs)
  values (who, app_name, public.app_day(), 1)
  on conflict (user_id, app, day)
    do update set runs = public.app_usage.runs + 1
  returning runs into used;

  return greatest(public.app_run_limit(app_name, who) - used, 0);
end;
$$;

-- Only the Edge Function may spend a run. Without this a seller could call the
-- function through PostgREST — harmlessly for their own row, but there is no
-- reason to leave it reachable.
revoke execute on function public.record_app_run(text, uuid) from public, anon, authenticated;
grant  execute on function public.record_app_run(text, uuid) to service_role;

-- These are read-only and scoped to the caller, so the browser may ask.
grant execute on function public.app_day()                    to authenticated, service_role;
grant execute on function public.app_quota(text)              to authenticated, service_role;
grant execute on function public.app_run_limit(text, uuid)    to authenticated, service_role;
grant execute on function public.app_runs_today(text, uuid)   to authenticated, service_role;
