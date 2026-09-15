-- Service-only storage. Signing in does NOT grant host rights.
create table public.control_hosts (
  user_id uuid primary key references auth.users(id) on delete cascade
);
create table public.control_guests (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.control_hosts(user_id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  token text not null check (token ~ '^[2-9A-HJ-NP-Z]{16}$'),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (id,host_id)
);
create index control_guests_host on public.control_guests(host_id);
create table public.control_sessions (
  host_id uuid primary key references public.control_hosts(user_id) on delete cascade,
  profile_id uuid not null,
  session text not null unique check (session ~ '^[0-9a-f]{48}$'),
  edge_key text not null,
  lease_until timestamptz not null,
  foreign key (profile_id,host_id) references public.control_guests(id,host_id) on delete cascade
);
create index control_sessions_profile on public.control_sessions(profile_id,host_id);
alter table public.control_hosts enable row level security;
alter table public.control_guests enable row level security;
alter table public.control_sessions enable row level security;
revoke all on public.control_hosts,public.control_guests,public.control_sessions from public,anon,authenticated;
grant all on public.control_hosts,public.control_guests,public.control_sessions to service_role;
-- No anon/authenticated policies: all access goes through the verifying Edge
-- Function. Explicit service policies document the intended server-only access.
create policy control_hosts_backend on public.control_hosts to service_role using (true) with check (true);
create policy control_guests_backend on public.control_guests to service_role using (true) with check (true);
create policy control_sessions_backend on public.control_sessions to service_role using (true) with check (true);
