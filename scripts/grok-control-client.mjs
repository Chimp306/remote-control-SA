/**
 * Headless owner adapter for Grok Control.
 * Dry run, with no credentials: GROK_DRY_RUN=1 node scripts/grok-control-client.mjs
 * Live: set GROK_FUNCTION_URL, GROK_PUBLISHABLE_KEY, and GROK_REFRESH_TOKEN
 * in the environment. Never pass them as arguments and never commit them.
 * A chat window is not connected until a host runs this adapter or an equivalent tool.
 */
import readline from 'node:readline';
import { jwtRole } from '../app/grok-control.js';
import { bindCommandInput, createFunctionTransport, createGrokAdapter, createMockTransport, runDryDemo } from './grok-adapter.mjs';

if (process.env.GROK_DRY_RUN === '1') {
  await runDryDemo(line => console.log(JSON.stringify(line)));
  process.exit(0);
}

if (process.env.GROK_DRY_RUN === 'listen') {
  const transport = createMockTransport();
  const adapter = createGrokAdapter({ transport, log: line => console.log(JSON.stringify(line)) });
  await adapter.attach();
  const input = readline.createInterface({ input: process.stdin });
  bindCommandInput(adapter, input, {
    writeError: message => console.error(message),
    onState: payload => transport.emitState(payload),
  });
  await new Promise(resolve => input.on('close', resolve));
  process.exit(0);
}

const url = process.env.GROK_FUNCTION_URL;
const key = process.env.GROK_PUBLISHABLE_KEY || '';
const refreshToken = process.env.GROK_REFRESH_TOKEN || '';
if (!url || !refreshToken) {
  console.error('Missing GROK_FUNCTION_URL or GROK_REFRESH_TOKEN.');
  process.exit(1);
}
if (jwtRole(refreshToken) === 'service_role' || refreshToken.startsWith('sb_secret_') || jwtRole(key) === 'service_role') {
  console.error('The service role is refused.');
  process.exit(1);
}

const transport = createFunctionTransport({ url, publishableKey: key, refreshToken });
const adapter = createGrokAdapter({ transport, log: line => console.log(JSON.stringify(line)) });
await adapter.attach();
console.log(JSON.stringify({ type: 'subscribed' }));
const input = readline.createInterface({ input: process.stdin });
bindCommandInput(adapter, input, { writeError: message => console.error(message) });
