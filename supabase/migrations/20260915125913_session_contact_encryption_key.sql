-- Public half of an ephemeral guest-contact encryption key. Contact details
-- themselves are never stored in Postgres; this is deleted with the session.
alter table public.control_sessions add column contact_key text;
