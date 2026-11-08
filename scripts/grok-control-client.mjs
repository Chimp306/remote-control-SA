/**
 * Headless owner adapter for Grok Control.
 * Dry run, with no credentials: GROK_DRY_RUN=1 node scripts/grok-control-client.mjs
 * Live: set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and GROK_OWNER_ACCESS_TOKEN
 * in the environment. Never pass them as arguments and never commit them.
 * A chat window is not connected until a host runs this adapter or an equivalent tool.
 */
import readline from 'node:readline';
import { jwtRole } from '../app/grok-control.js';
import { commandFromLine, createGrokAdapter, createSupabaseTransport, runDryDemo } from './grok-adapter.mjs';

if (process.env.GROK_DRY_RUN === '1') {
  await runDryDemo(line => console.log(JSON.stringify(line)));
  process.exit(0);
}

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

const transport = await createSupabaseTransport({ url, key, accessToken, refreshToken });
const adapter = createGrokAdapter({ transport, log: line => console.log(JSON.stringify(line)) });
await adapter.attach();
console.log(JSON.stringify({ type: 'subscribed' }));
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request;
  try { request = commandFromLine(trimmed); }
  catch (err) { console.error(err.message); return; }
  adapter.command(request.command, request.params).catch(err => console.error(err.message));
});
