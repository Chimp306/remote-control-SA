/**
 * Headless owner client for Grok Control.
 * Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, GROK_OWNER_ACCESS_TOKEN,
 * and optionally GROK_OWNER_REFRESH_TOKEN. Never commit those values.
 * Do not use the service-role key. This file is not started by the site.
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm';
import { jwtRole, topicForUser } from '../app/grok-control.js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_PUBLISHABLE_KEY;
const accessToken = process.env.GROK_OWNER_ACCESS_TOKEN;
const refreshToken = process.env.GROK_OWNER_REFRESH_TOKEN || '';

if (!url || !key || !accessToken) {
  console.error('Missing SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, or GROK_OWNER_ACCESS_TOKEN.');
  process.exit(1);
}
if (jwtRole(accessToken) === 'service_role' || jwtRole(key) === 'service_role') {
  console.error('The service role is refused.');
  process.exit(1);
}

const client = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
});
const { data, error } = await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
if (error || !data.session?.user?.id) {
  console.error('Owner session was not accepted.');
  process.exit(1);
}

const topic = topicForUser(data.session.user.id);
const channel = client.channel(topic, { config: { private: true, broadcast: { self: false } } });
channel.on('broadcast', { event: 'state' }, ({ payload }) => {
  console.log(JSON.stringify({ type: 'state', phase: payload?.phase, armed: payload?.armed, sessionId: payload?.sessionId, epoch: payload?.epoch }));
});
channel.on('broadcast', { event: 'ack' }, ({ payload }) => {
  console.log(JSON.stringify({ type: 'ack', accepted: payload?.accepted, applied: payload?.applied, hardware: payload?.hardware, reason: payload?.reason }));
});
channel.subscribe(status => {
  if (status === 'SUBSCRIBED') console.log(JSON.stringify({ type: 'subscribed' }));
  if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') console.error(status);
});
