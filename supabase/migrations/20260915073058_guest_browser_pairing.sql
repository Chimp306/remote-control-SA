-- Four-character codes locate an approval queue. They grant NO control access.
alter table public.control_guests add column pair_code text unique;
alter table public.control_guests add constraint control_pair_code_format check (pair_code ~ '^[2-9A-HJ-NP-Z]{4}$');
create table public.control_pairings (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.control_guests(id) on delete cascade,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  check_number text not null,
  state text not null default 'pending' check (state in ('pending','approved','denied')),
  approved_token text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '10 minutes',
  unique (profile_id,request_hash),
  unique (profile_id,check_number)
);
alter table public.control_pairings enable row level security;
revoke all on public.control_pairings from public,anon,authenticated;
grant all on public.control_pairings to service_role;
create policy control_pairings_backend on public.control_pairings to service_role using (true) with check (true);

-- Invoker privileges, server-only EXECUTE. Serialise queue admission for each
-- profile to bound guessed-code spam to ten requests per ten-minute window.
create function public.request_control_pairing(guest_id uuid,request_hash text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare existing public.control_pairings; check_text text; result public.control_pairings;
begin
  perform 1 from public.control_guests where id=guest_id for update;
  if not found then return null; end if;
  delete from public.control_pairings where profile_id=guest_id and expires_at<now();
  select * into existing from public.control_pairings p where p.profile_id=guest_id and p.request_hash=request_control_pairing.request_hash;
  if found then return jsonb_build_object('check_number',existing.check_number); end if;
  if (select count(*) from public.control_pairings where profile_id=guest_id)>=10 then return null; end if;
  loop
    check_text:=lpad(floor(random()*10000)::integer::text,4,'0');
    exit when not exists(select 1 from public.control_pairings where profile_id=guest_id and check_number=check_text);
  end loop;
  insert into public.control_pairings(profile_id,request_hash,check_number)
    values(guest_id,request_hash,check_text) returning * into result;
  return jsonb_build_object('check_number',result.check_number);
end;
$$;
revoke all on function public.request_control_pairing(uuid,text) from public,anon,authenticated;
grant execute on function public.request_control_pairing(uuid,text) to service_role;
