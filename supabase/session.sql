-- One question, one answer: may this account use this app, and as what?
--
-- The app already asks has_app_access() on every entry. It now also needs the
-- caller's role, to decide whether to show the owner's tools — and asking two
-- questions about the same row, on every page load, to decide one thing would
-- be wasteful. This returns both.
--
-- Run this on the shared Supabase project after supabase/profiles.sql, which is
-- where has_app_access() and app_role() come from.
--
-- Safe to deploy after the site rather than before: the browser falls back to
-- has_app_access() when this function is missing, and simply treats everyone as
-- a member until it exists.

create or replace function public.app_session(app_name text)
  returns json language sql stable security definer
  set search_path = public
as $$
  select json_build_object(
    -- The grant itself. Same function the row level security policies use, so
    -- the answer here cannot drift from the answer the database enforces.
    'access', coalesce(public.has_app_access(app_name), false),
    -- Null for an account with no grant, which is the same as no role. The
    -- browser only ever compares this against 'app_admin'.
    'role',   public.app_role(app_name)
  );
$$;

grant execute on function public.app_session(text) to authenticated, service_role;

-- Check it, as the SQL Editor's superuser — auth.uid() is null there, so expect
-- access false and a null role. The real answer only appears from the app.
--   select public.app_session('fb-marketplace');
