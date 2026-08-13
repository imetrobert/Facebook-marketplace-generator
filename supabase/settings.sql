-- App-wide settings, set by the owner and inherited by everyone.
--
-- The model the app uses was a per-device choice in each seller's browser: two
-- sellers could be on different models without knowing it, and the owner had no
-- way to move anyone. It is one decision about the whole app, so it lives with
-- the app rather than on a phone.
--
-- Run this on the shared Supabase project after supabase/profiles.sql, which is
-- where has_app_access() and app_role() come from.
--
-- Safe to run after publishing rather than before: the browser falls back to
-- its own stored choice when this table is missing.

create table if not exists public.app_settings (
  app        text not null,
  key        text not null,
  value      text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  primary key (app, key)
);

alter table public.app_settings enable row level security;

-- Everyone granted the app reads the same settings — that is the whole point:
-- a member inherits the owner's choice rather than keeping their own.
drop policy if exists "app_settings select policy" on public.app_settings;
create policy "app_settings select policy" on public.app_settings
  for select to authenticated
  using (public.has_app_access(app));

-- Only an app admin may change one. A member sending the write themselves is
-- refused by the database, not merely by a hidden control in the browser.
drop policy if exists "app_settings insert policy" on public.app_settings;
create policy "app_settings insert policy" on public.app_settings
  for insert to authenticated
  with check (
    public.has_app_access(app)
    and public.app_role(app) = 'app_admin'
    and auth.uid() = updated_by
  );

drop policy if exists "app_settings update policy" on public.app_settings;
create policy "app_settings update policy" on public.app_settings
  for update to authenticated
  using (
    public.has_app_access(app)
    and public.app_role(app) = 'app_admin'
  )
  with check (
    public.has_app_access(app)
    and public.app_role(app) = 'app_admin'
    and auth.uid() = updated_by
  );

-- The model every seller uses. An empty value means "best available", which is
-- the app discovering the newest usable model for itself — the default, and
-- almost always the right answer.
insert into public.app_settings (app, key, value)
values ('fb-marketplace', 'model', '')
on conflict (app, key) do nothing;

-- What the owner has chosen, if anything:
--   select value from public.app_settings
--   where app = 'fb-marketplace' and key = 'model';
