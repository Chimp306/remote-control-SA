-- Follow-up for ctmp-grok after the base bridge migration.
-- The hosted database already has that base as version 20261108224632.
-- Do not edit or re-apply the base file as the fix. PostgREST loads
-- pg-safeupdate, which rejects a DELETE with no WHERE clause (SQLSTATE 21000)
-- even when the statement is inside a function.
--
-- These replacements keep the same locks, grants, and results. Each delete
-- names the primary key, which is NOT NULL, so every existing row is removed
-- and an empty table stays empty.

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
  perform pg_catalog.pg_advisory_xact_lock(611082345);
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
  delete from public.grok_access where access_hash is not null;
  insert into public.grok_access (access_hash, expires_at) values (p_access_hash, p_access_expires);
  return true;
end;
$$;

create or replace function public.grok_logout(p_access_hash text)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(611082345);
  if not exists (
    select 1 from public.grok_access
    where access_hash = p_access_hash and expires_at > now()
  ) then
    return false;
  end if;
  delete from public.grok_access where access_hash is not null;
  update public.grok_session
  set refresh_hash = null, refresh_expires_at = null, updated_at = now()
  where id = 1;
  return true;
end;
$$;

revoke all on function
  public.grok_clear_owner(),
  public.grok_login_enrollment(text, text, timestamptz, text, timestamptz),
  public.grok_logout(text)
from public, anon, authenticated;

grant execute on function
  public.grok_login_enrollment(text, text, timestamptz, text, timestamptz),
  public.grok_logout(text)
to service_role;

grant execute on function public.grok_clear_owner() to postgres, service_role;
