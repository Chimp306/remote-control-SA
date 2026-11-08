-- Fresh Grok Control bridge for project ctmp-grok (kmswwrfglbdbwoapusfw) only.
-- Do not apply this file to the older project, and do not apply the older
-- migration files to ctmp-grok. It does not touch freq_entries, ctmp_v2_*,
-- auth.users, or realtime.
--
-- No anon or authenticated policy is created. The service role bypasses RLS
-- and is used only inside the grok-control Edge Function. Callers authenticate
-- with an owner token that this database stores only as a SHA-256 hex digest.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.grok_enrollment (
  id smallint primary key default 1 check (id = 1),
  code_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.grok_session (
  id smallint primary key default 1 check (id = 1),
  refresh_hash text,
  refresh_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.grok_access (
  access_hash text primary key,
  expires_at timestamptz not null
);

create table if not exists public.grok_state (
  id smallint primary key default 1 check (id = 1),
  payload jsonb not null,
  published_at timestamptz not null default now()
);

create table if not exists public.grok_command (
  id text primary key,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.grok_event (
  id text primary key,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.grok_ack (
  command_id text primary key,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.grok_rate (
  key text not null,
  bucket bigint not null,
  attempts integer not null default 1,
  created_at timestamptz not null default now(),
  primary key (key, bucket)
);

alter table public.grok_enrollment enable row level security;
alter table public.grok_session enable row level security;
alter table public.grok_access enable row level security;
alter table public.grok_state enable row level security;
alter table public.grok_command enable row level security;
alter table public.grok_event enable row level security;
alter table public.grok_ack enable row level security;
alter table public.grok_rate enable row level security;

revoke all on public.grok_enrollment, public.grok_session, public.grok_access, public.grok_state, public.grok_command, public.grok_event, public.grok_ack, public.grok_rate from public, anon, authenticated;
grant all on public.grok_enrollment, public.grok_session, public.grok_access, public.grok_state, public.grok_command, public.grok_event, public.grok_ack, public.grok_rate to service_role;

create or replace function public.grok_rate(p_key text, p_limit integer, p_window integer)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
  v_bucket bigint;
begin
  if p_key is null or length(p_key) < 8 or length(p_key) > 200 then
    return false;
  end if;
  v_bucket := floor(extract(epoch from now()) / greatest(p_window, 1));
  delete from public.grok_rate where created_at < now() - interval '1 day';
  insert into public.grok_rate (key, bucket)
  values (p_key, v_bucket)
  on conflict (key, bucket) do update set attempts = public.grok_rate.attempts + 1
  returning attempts into v_count;
  return v_count <= p_limit;
end;
$$;

-- Privileged one-time enrollment. Returns the plaintext code only to this SQL
-- session. The table stores SHA-256 hex. Refuses while a live refresh token exists.
create or replace function public.grok_provision_enrollment()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  token text;
begin
  if exists (
    select 1 from public.grok_session
    where refresh_hash is not null and refresh_expires_at > now()
  ) then
    raise exception 'owner session already exists';
  end if;
  token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.grok_enrollment (id, code_hash, expires_at, used_at)
  values (1, encode(extensions.digest(token, 'sha256'), 'hex'), now() + interval '24 hours', null)
  on conflict (id) do update
    set code_hash = excluded.code_hash,
        expires_at = excluded.expires_at,
        used_at = null,
        created_at = now();
  return token;
end;
$$;

create or replace function public.grok_clear_owner()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.grok_session where id = 1;
  delete from public.grok_access;
  delete from public.grok_enrollment where id = 1;
  delete from public.grok_state where id = 1;
  delete from public.grok_command;
  delete from public.grok_event;
  delete from public.grok_ack;
end;
$$;

create or replace function public.grok_login_enrollment(
  p_code_hash text,
  p_refresh_hash text,
  p_refresh_expires timestamptz,
  p_access_hash text,
  p_access_expires timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  consumed integer;
begin
  update public.grok_enrollment
  set used_at = now()
  where id = 1
    and code_hash = p_code_hash
    and used_at is null
    and expires_at > now();
  get diagnostics consumed = row_count;
  if consumed <> 1 then
    return false;
  end if;
  insert into public.grok_session (id, refresh_hash, refresh_expires_at)
  values (1, p_refresh_hash, p_refresh_expires)
  on conflict (id) do update
    set refresh_hash = excluded.refresh_hash,
        refresh_expires_at = excluded.refresh_expires_at,
        updated_at = now();
  delete from public.grok_access;
  insert into public.grok_access (access_hash, expires_at) values (p_access_hash, p_access_expires);
  return true;
end;
$$;

create or replace function public.grok_login_refresh(
  p_refresh_hash text,
  p_access_hash text,
  p_access_expires timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.grok_session
    where id = 1 and refresh_hash = p_refresh_hash and refresh_expires_at > now()
  ) then
    return false;
  end if;
  delete from public.grok_access where expires_at <= now();
  insert into public.grok_access (access_hash, expires_at) values (p_access_hash, p_access_expires);
  return true;
end;
$$;

create or replace function public.grok_access_ok(p_access_hash text)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1 from public.grok_access
    where access_hash = p_access_hash and expires_at > now()
  );
$$;

create or replace function public.grok_logout(p_access_hash text)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.grok_access
    where access_hash = p_access_hash and expires_at > now()
  ) then
    return false;
  end if;
  delete from public.grok_access;
  update public.grok_session
  set refresh_hash = null, refresh_expires_at = null, updated_at = now()
  where id = 1;
  return true;
end;
$$;

revoke all on function
  public.grok_rate(text, integer, integer),
  public.grok_provision_enrollment(),
  public.grok_clear_owner(),
  public.grok_login_enrollment(text, text, timestamptz, text, timestamptz),
  public.grok_login_refresh(text, text, timestamptz),
  public.grok_access_ok(text),
  public.grok_logout(text)
from public, anon, authenticated;

grant execute on function
  public.grok_rate(text, integer, integer),
  public.grok_login_enrollment(text, text, timestamptz, text, timestamptz),
  public.grok_login_refresh(text, text, timestamptz),
  public.grok_access_ok(text),
  public.grok_logout(text)
to service_role;

grant execute on function public.grok_provision_enrollment(), public.grok_clear_owner() to postgres, service_role;
