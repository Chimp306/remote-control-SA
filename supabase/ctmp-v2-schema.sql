-- Additive V2 schema. Existing control_* tables/functions remain for rollback.
-- No browser role has direct table or function access. Only ctmp-control's
-- server-held service credential can use this schema through its checks.
create table if not exists public.ctmp_v2_settings (
  id boolean primary key default true check (id),
  password_salt text not null,
  password_hash text not null,
  iterations integer not null check (iterations >= 600000),
  best integer not null default 0 check (best >= 0),
  updated_at timestamptz not null default now()
);
create table if not exists public.ctmp_v2_owner_tokens (
  token_hash text primary key,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table if not exists public.ctmp_v2_sessions (
  id uuid primary key default gen_random_uuid(),
  code_hash text unique not null,
  owner_hash text not null references public.ctmp_v2_owner_tokens(token_hash),
  toy text not null check (toy in ('lush','opossum','vacuglide')),
  simulation boolean not null default false,
  active boolean not null default true,
  guest_hash text,
  guest_client_hash text,
  guest_seen_at timestamptz,
  state jsonb not null default '{}',
  state_at timestamptz,
  command jsonb,
  command_seq bigint not null default 0,
  client_seq bigint not null default 0,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create unique index if not exists ctmp_v2_one_active on public.ctmp_v2_sessions ((true)) where active;
create index if not exists ctmp_v2_guest_lookup on public.ctmp_v2_sessions (guest_hash) where active;
create table if not exists public.ctmp_v2_rates (
  key text not null,
  bucket bigint not null,
  attempts integer not null default 1,
  created_at timestamptz not null default now(),
  primary key (key,bucket)
);
alter table public.ctmp_v2_settings enable row level security;
alter table public.ctmp_v2_owner_tokens enable row level security;
alter table public.ctmp_v2_sessions enable row level security;
alter table public.ctmp_v2_rates enable row level security;
revoke all on public.ctmp_v2_settings, public.ctmp_v2_owner_tokens, public.ctmp_v2_sessions, public.ctmp_v2_rates from public, anon, authenticated;
grant all on public.ctmp_v2_settings, public.ctmp_v2_owner_tokens, public.ctmp_v2_sessions, public.ctmp_v2_rates to service_role;

create or replace function public.ctmp_v2_rate(p_key text, p_limit integer, p_window integer)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_count integer; v_bucket bigint;
begin
  v_bucket := floor(extract(epoch from now()) / greatest(p_window,1));
  delete from public.ctmp_v2_rates where created_at < now() - interval '1 day';
  insert into public.ctmp_v2_rates(key,bucket) values(p_key,v_bucket)
  on conflict(key,bucket) do update set attempts=public.ctmp_v2_rates.attempts+1
  returning attempts into v_count;
  return v_count <= p_limit;
end; $$;

create or replace function public.ctmp_v2_best(p_count integer)
returns integer language plpgsql security invoker set search_path = '' as $$
declare result integer;
begin
  update public.ctmp_v2_settings set best=greatest(best,least(greatest(p_count,0),1000000)),updated_at=now() where id=true returning best into result;
  return coalesce(result,0);
end; $$;

create or replace function public.ctmp_v2_create_session(p_owner text,p_code text,p_toy text,p_simulation boolean)
returns public.ctmp_v2_sessions language plpgsql security invoker set search_path = '' as $$
declare result public.ctmp_v2_sessions;
begin
  perform pg_advisory_xact_lock(611012026);
  update public.ctmp_v2_sessions set active=false,ended_at=now(),state='{}',command=null,guest_hash=null,guest_client_hash=null where active;
  insert into public.ctmp_v2_sessions(owner_hash,code_hash,toy,simulation) values(p_owner,p_code,p_toy,p_simulation) returning * into result;
  return result;
end; $$;

create or replace function public.ctmp_v2_join(p_code text,p_client text,p_guest text)
returns public.ctmp_v2_sessions language plpgsql security invoker set search_path = '' as $$
declare result public.ctmp_v2_sessions;
begin
  select * into result from public.ctmp_v2_sessions where code_hash=p_code and active for update;
  if not found then return null; end if;
  if result.guest_client_hash is not null and result.guest_client_hash <> p_client then return null; end if;
  update public.ctmp_v2_sessions set guest_client_hash=p_client,guest_hash=p_guest,guest_seen_at=now(),client_seq=0,command=null where id=result.id returning * into result;
  return result;
end; $$;

create or replace function public.ctmp_v2_command(p_session uuid,p_guest text,p_command jsonb)
returns bigint language plpgsql security invoker set search_path = '' as $$
declare result public.ctmp_v2_sessions; seq bigint;
begin
  select * into result from public.ctmp_v2_sessions where id=p_session and guest_hash=p_guest and active for update;
  if not found then return -1; end if;
  if result.state_at is null or result.state_at > now()+interval '1 second' or result.state_at < now()-interval '5 seconds' then return -2; end if;
  if result.state->>'phase' is distinct from 'running' and (p_command->>'percent')::numeric <> 0 then return -2; end if;
  if coalesce((result.state->>'epoch')::bigint,-1) <> (p_command->>'epoch')::bigint then return -3; end if;
  if (p_command->>'clientSeq')::bigint <= result.client_seq then return -4; end if;
  update public.ctmp_v2_sessions set command=p_command || jsonb_build_object('at',floor(extract(epoch from clock_timestamp())*1000)),command_seq=command_seq+1,client_seq=(p_command->>'clientSeq')::bigint,guest_seen_at=now()
  where id=p_session returning command_seq into seq;
  return seq;
end; $$;

revoke all on function public.ctmp_v2_rate(text,integer,integer), public.ctmp_v2_best(integer), public.ctmp_v2_create_session(text,text,text,boolean), public.ctmp_v2_join(text,text,text), public.ctmp_v2_command(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.ctmp_v2_rate(text,integer,integer), public.ctmp_v2_best(integer), public.ctmp_v2_create_session(text,text,text,boolean), public.ctmp_v2_join(text,text,text), public.ctmp_v2_command(uuid,text,jsonb) to service_role;
