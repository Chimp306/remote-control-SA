/**
 * Turn a one-time enrollment file into a pairing file for the page and the bot.
 * The code is never printed. Set GROK_ENROLLMENT_FILE and GROK_TOKEN_FILE.
 */
import fs from 'node:fs';
import { GROK_FUNCTION_URL, GROK_PUBLISHABLE_KEY } from '../app/grok-public.js';
import { createGrokBridgeClient } from '../app/grok-bridge-client.js';

const enrollmentPath = process.env.GROK_ENROLLMENT_FILE || '';
const tokenPath = process.env.GROK_TOKEN_FILE || '';
const url = process.env.GROK_FUNCTION_URL || GROK_FUNCTION_URL;
const key = process.env.GROK_PUBLISHABLE_KEY || GROK_PUBLISHABLE_KEY;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!enrollmentPath || !tokenPath) fail('Set GROK_ENROLLMENT_FILE and GROK_TOKEN_FILE.');
let enrollment = '';
try { enrollment = fs.readFileSync(enrollmentPath, 'utf8').trim().toLowerCase(); }
catch { fail('Enrollment file could not be read.'); }
if (!/^[a-f0-9]{64}$/.test(enrollment)) fail('Enrollment file is not usable.');

const store = { value: '', get() { return this.value; }, set(value) { this.value = value; }, clear() { this.value = ''; } };
const client = createGrokBridgeClient({ url, publishableKey: key, store });
let refresh = '';
try {
  const result = await client.loginEnrollment(enrollment);
  refresh = result.refresh;
} catch {
  fail('Pairing did not complete.');
}
fs.writeFileSync(tokenPath, `${refresh}\n`, { mode: 0o600 });
try { fs.chmodSync(tokenPath, 0o600); } catch { /* the write mode already restricts it */ }
console.log(JSON.stringify({ type: 'paired', file: tokenPath }));
