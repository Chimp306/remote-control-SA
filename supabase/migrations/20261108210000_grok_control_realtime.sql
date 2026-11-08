-- Do not apply this file to ctmp-grok. That project uses grok_bridge.sql.
-- Owner-only Grok Control broadcasts.
-- Does not read or write freq_entries or ctmp_v2_*.
-- Realtime checks these policies when a private channel is joined, then rolls
-- the check back. Broadcast payloads are not stored as device history.
-- https://supabase.com/docs/guides/realtime/authorization
--
-- private: true on the client is not sufficient while Realtime "Allow public
-- access" remains enabled. Disable that setting so joins without private: true
-- are rejected. These policies still refuse anon and every other user.

drop policy if exists grok_control_receive on realtime.messages;
drop policy if exists grok_control_send on realtime.messages;

create policy grok_control_receive
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and (select realtime.topic()) = 'grok-control:' || (select auth.uid())::text
);

create policy grok_control_send
on realtime.messages
for insert
to authenticated
with check (
  realtime.messages.extension = 'broadcast'
  and (select realtime.topic()) = 'grok-control:' || (select auth.uid())::text
);
