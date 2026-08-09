-- Seller profiles, one row per user.
--
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste ->
-- Run. It is safe to run more than once.
--
-- The profile is stored as a single jsonb document rather than a column per
-- field. The shape is versioned in js/profile.js and merged over defaults on
-- read, so adding a new setting later never needs a database migration.

create table if not exists public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Without this, the anon key could read every row. With it, the database
-- itself enforces that a signed-in user only ever touches their own — the app
-- is not trusted to get that right.
alter table public.profiles enable row level security;

-- Two conditions, not one.
--
-- `user_id = auth.uid()` keeps sellers out of each other's rows. On its own it
-- is not enough here: this Supabase project is shared with several other apps,
-- so every one of their users can sign in, and without the first condition any
-- of them could create a seller profile in this app.
--
-- `has_app_access('fb-marketplace')` is the per-app grant, held in the
-- project's `app_access` table. It is the same check js/app.js makes in the
-- browser, so the two cannot drift apart — but this one is the real boundary.
--
-- `app_role(...) = 'app_admin'` lets someone running this app on the owner's
-- behalf see every seller's profile. Note it applies to reads only: the write
-- rules stay `user_id = auth.uid()`, so not even an app admin can create or
-- alter a row belonging to someone else.
--
-- Requires has_app_access() and app_role() to exist on the project first.

drop policy if exists "profiles select policy" on public.profiles;
drop policy if exists "profiles insert policy" on public.profiles;
drop policy if exists "profiles update policy" on public.profiles;
drop policy if exists "profiles delete policy" on public.profiles;

create policy "profiles select policy" on public.profiles
  for select to authenticated
  using (
    public.has_app_access('fb-marketplace')
    and (public.app_role('fb-marketplace') = 'app_admin' or auth.uid() = user_id)
  );

create policy "profiles insert policy" on public.profiles
  for insert to authenticated
  with check (public.has_app_access('fb-marketplace') and auth.uid() = user_id);

create policy "profiles update policy" on public.profiles
  for update to authenticated
  using      (public.has_app_access('fb-marketplace') and auth.uid() = user_id)
  with check (public.has_app_access('fb-marketplace') and auth.uid() = user_id);

create policy "profiles delete policy" on public.profiles
  for delete to authenticated
  using (public.has_app_access('fb-marketplace') and auth.uid() = user_id);

-- Deleting an account takes its profile with it, via the cascade above.
--
-- Policy names match what is deployed, so re-running this replaces those
-- policies rather than adding a second set alongside them.

-- Quick check that isolation works. Signed out, this must return zero rows
-- even though the table has data:
--   select count(*) from public.profiles;
