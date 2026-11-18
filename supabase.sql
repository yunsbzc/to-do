-- Run this once in your Supabase project: SQL Editor → New query → paste → Run.
-- It creates one row per person holding their lists, readable and writable only by them.

create table if not exists public.lists (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.lists enable row level security;

drop policy if exists "Read own lists" on public.lists;
create policy "Read own lists" on public.lists
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "Create own lists" on public.lists;
create policy "Create own lists" on public.lists
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "Update own lists" on public.lists;
create policy "Update own lists" on public.lists
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

grant select, insert, update on public.lists to authenticated;
