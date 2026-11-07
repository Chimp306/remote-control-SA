-- Personal date log, separate from device-control tables.
-- The browser uses the signed-in user's JWT. ctmp-control is not granted a path
-- to this table. service_role bypasses row level security on this platform, so
-- its table grants are revoked here and the FREQ page must not use that key.

create table if not exists public.freq_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  occurred_on date not null,
  count integer not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint freq_entries_count_range check (count >= 0 and count <= 99),
  constraint freq_entries_note_length check (char_length(note) <= 280),
  constraint freq_entries_occurred_floor check (occurred_on >= date '2000-01-01')
);

create index if not exists freq_entries_owner_day
  on public.freq_entries (user_id, occurred_on desc, created_at desc);

create or replace function public.freq_entries_stamp()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'sign-in required';
  end if;
  if new.occurred_on > (current_date + 1) then
    raise exception 'date outside log range';
  end if;
  new.user_id = auth.uid();
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists freq_entries_stamp on public.freq_entries;
create trigger freq_entries_stamp
  before insert or update on public.freq_entries
  for each row execute function public.freq_entries_stamp();

alter table public.freq_entries enable row level security;
alter table public.freq_entries force row level security;

revoke all on table public.freq_entries from public, anon, authenticated, service_role;
revoke all on function public.freq_entries_stamp() from public, anon, authenticated, service_role;

grant select, insert, update, delete on table public.freq_entries to authenticated;
grant execute on function public.freq_entries_stamp() to authenticated;

drop policy if exists freq_entries_select_own on public.freq_entries;
drop policy if exists freq_entries_insert_own on public.freq_entries;
drop policy if exists freq_entries_update_own on public.freq_entries;
drop policy if exists freq_entries_delete_own on public.freq_entries;

create policy freq_entries_select_own
  on public.freq_entries
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy freq_entries_insert_own
  on public.freq_entries
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

create policy freq_entries_update_own
  on public.freq_entries
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy freq_entries_delete_own
  on public.freq_entries
  for delete
  to authenticated
  using (user_id = (select auth.uid()));
