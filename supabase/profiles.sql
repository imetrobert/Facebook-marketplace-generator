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

drop policy if exists "read own profile"   on public.profiles;
drop policy if exists "insert own profile" on public.profiles;
drop policy if exists "update own profile" on public.profiles;
drop policy if exists "delete own profile" on public.profiles;

create policy "read own profile" on public.profiles
  for select using (auth.uid() = user_id);

create policy "insert own profile" on public.profiles
  for insert with check (auth.uid() = user_id);

create policy "update own profile" on public.profiles
  for update using (auth.uid() = user_id)
             with check (auth.uid() = user_id);

create policy "delete own profile" on public.profiles
  for delete using (auth.uid() = user_id);

-- Deleting an account takes its profile with it, via the cascade above.

-- Quick check that isolation works. Signed out, this must return zero rows
-- even though the table has data:
--   select count(*) from public.profiles;
