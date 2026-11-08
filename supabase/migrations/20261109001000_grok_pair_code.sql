-- Four-character pairing for an owner that already exists.
-- Does not replace the owner refresh token and does not allow a first caller
-- to claim the owner. Apply after 20261108235500_grok_bridge_safe_delete.sql.
-- Every DELETE has a WHERE clause for pg-safeupdate.

create table if not exists public.grok_pair_code (
  id smallint primary key default 1 check (id = 1),
  code_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  attempts integer not null default 0,
  created_at timestamptz not null default now()
);

-- NULL session_id on grok_access is the already-enrolled host. Do not backfill it.
alter table public.grok_access add column if not exists session_id text;

create table if not exists public.grok_browser_refresh (
  refresh_hash text primary key,
  session_id text not null,
  expires_at timestamptz not null
);

alter table public.grok_pair_code enable row level security;
alter table public.grok_browser_refresh enable row level security;

revoke all on public.grok_pair_code, public.grok_browser_refresh from public, anon, authenticated;
grant all on public.grok_pair_code, public.grok_browser_refresh to service_role;

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
declare
  v_session text;
begin
  perform pg_catalog.pg_advisory_xact_lock(611082345);
  if exists (
    select 1 from public.grok_session
    where id = 1 and refresh_hash = p_refresh_hash and refresh_expires_at > now()
  ) then
    delete from public.grok_access where expires_at <= now();
    insert into public.grok_access (access_hash, expires_at, session_id)
    values (p_access_hash, p_access_expires, null);
    return true;
  end if;
  select session_id into v_session
  from public.grok_browser_refresh
  where refresh_hash = p_refresh_hash and expires_at > now();
  if not found then
    return false;
  end if;
  delete from public.grok_access where expires_at <= now();
  insert into public.grok_access (access_hash, expires_at, session_id)
  values (p_access_hash, p_access_expires, v_session);
  return true;
end;
$$;

create or replace function public.grok_logout(p_access_hash text)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_session text;
begin
  perform pg_catalog.pg_advisory_xact_lock(611082345);
  select session_id into v_session
  from public.grok_access
  where access_hash = p_access_hash and expires_at > now();
  if not found then
    return false;
  end if;
  if v_session is null then
    delete from public.grok_access
    where access_hash = p_access_hash and session_id is null;
    return true;
  end if;
  delete from public.grok_access where session_id = v_session;
  delete from public.grok_browser_refresh where session_id = v_session;
  return true;
end;
$$;

create or replace function public.grok_clear_owner()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(611082345);
  delete from public.grok_session where id = 1;
  delete from public.grok_access where access_hash is not null;
  delete from public.grok_enrollment where id = 1;
  delete from public.grok_state where id = 1;
  delete from public.grok_command where id is not null;
  delete from public.grok_event where id is not null;
  delete from public.grok_ack where command_id is not null;
  delete from public.grok_pair_code where id = 1;
  delete from public.grok_browser_refresh where refresh_hash is not null;
end;
$$;

create or replace function public.grok_mint_pair(
  p_access_hash text,
  p_code_hash text,
  p_expires timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(611082345);
  if not exists (
    select 1 from public.grok_access
    where access_hash = p_access_hash and expires_at > now() and session_id is null
  ) then
    return false;
  end if;
  insert into public.grok_pair_code (id, code_hash, expires_at, used_at, attempts)
  values (1, p_code_hash, p_expires, null, 0)
  on conflict (id) do update
    set code_hash = excluded.code_hash,
        expires_at = excluded.expires_at,
        used_at = null,
        attempts = 0,
        created_at = now();
  return true;
end;
$$;

-- 1 redeemed, 0 rejected, 2 throttled. A wrong guess burns the live code after 5 tries.
create or replace function public.grok_redeem_pair(
  p_code_hash text,
  p_ip_key text,
  p_access_hash text,
  p_access_expires timestamptz,
  p_refresh_hash text,
  p_refresh_expires timestamptz
)
returns smallint
language plpgsql
security invoker
set search_path = public
as $$
declare
  consumed integer;
  v_session text;
begin
  perform pg_catalog.pg_advisory_xact_lock(611082345);
  if not public.grok_rate('pair-global', 20, 600) or not public.grok_rate(p_ip_key, 5, 600) then
    return 2;
  end if;
  update public.grok_pair_code
  set used_at = now()
  where id = 1
    and code_hash = p_code_hash
    and used_at is null
    and expires_at > now()
    and attempts < 5;
  get diagnostics consumed = row_count;
  if consumed = 1 then
    v_session := gen_random_uuid()::text;
    insert into public.grok_browser_refresh (refresh_hash, session_id, expires_at)
    values (p_refresh_hash, v_session, p_refresh_expires)
    on conflict (refresh_hash) do update
      set session_id = excluded.session_id, expires_at = excluded.expires_at;
    insert into public.grok_access (access_hash, expires_at, session_id)
    values (p_access_hash, p_access_expires, v_session);
    return 1;
  end if;
  update public.grok_pair_code
  set attempts = attempts + 1
  where id = 1 and used_at is null and expires_at > now();
  update public.grok_pair_code
  set used_at = now()
  where id = 1 and used_at is null and attempts >= 5;
  return 0;
end;
$$;

revoke all on function
  public.grok_mint_pair(text, text, timestamptz),
  public.grok_redeem_pair(text, text, text, timestamptz, text, timestamptz),
  public.grok_clear_owner(),
  public.grok_logout(text),
  public.grok_login_refresh(text, text, timestamptz)
from public, anon, authenticated;

grant execute on function
  public.grok_mint_pair(text, text, timestamptz),
  public.grok_redeem_pair(text, text, text, timestamptz, text, timestamptz),
  public.grok_logout(text),
  public.grok_login_refresh(text, text, timestamptz)
to service_role;

grant execute on function public.grok_clear_owner() to postgres, service_role;
