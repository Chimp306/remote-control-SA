/**
 * One-shot reader and command sender for the Grok bridge.
 * A chat window is not connected until a host runs this command.
 * The pairing code stays in GROK_TOKEN_FILE or GROK_REFRESH_TOKEN and is never printed.
 */
import fs from 'node:fs';
import { STATE_LEASE_MS } from '../app/grok-control.js';
import { GROK_FUNCTION_URL, GROK_PUBLISHABLE_KEY } from '../app/grok-public.js';
import { createFunctionTransport, createGrokAdapter } from './grok-adapter.mjs';

const waitMs = Number(process.env.GROK_ACK_WAIT_MS || 8000);
const url = process.env.GROK_FUNCTION_URL || GROK_FUNCTION_URL;
const key = process.env.GROK_PUBLISHABLE_KEY || GROK_PUBLISHABLE_KEY;

function fail(message, code) {
  console.error(message);
  process.exit(code);
}

function tokenFromFile(path) {
  let text = '';
  try { text = fs.readFileSync(path, 'utf8'); }
  catch { fail('Pairing file could not be read.', 1); }
  const line = text.split(/\r?\n/).map(item => item.trim()).find(item => item && !item.startsWith('#'));
  const raw = line?.startsWith('GROK_REFRESH_TOKEN=') ? line.slice('GROK_REFRESH_TOKEN='.length).trim() : line;
  const token = String(raw || '').replace(/^['"]|['"]$/g, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(token)) fail('Pairing file is not usable.', 1);
  return token;
}

function pairingToken() {
  if (process.env.GROK_TOKEN_FILE) return tokenFromFile(process.env.GROK_TOKEN_FILE);
  const token = String(process.env.GROK_REFRESH_TOKEN || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(token)) fail('Set GROK_TOKEN_FILE or GROK_REFRESH_TOKEN.', 1);
  return token;
}

function fresh(state, now) {
  const lease = Number.isFinite(state?.leaseMs) ? state.leaseMs : STATE_LEASE_MS;
  return Number.isFinite(state?.publishedAt) && state.publishedAt <= now && now - state.publishedAt <= lease;
}

function paramsFor(name, rest) {
  if (name === 'changePattern') return { pattern: rest[0] };
  if (name === 'adjustCutoff') return { delta: Number(rest[0]) };
  if (name === 'setDowntime') return { min: Number(rest[0]), max: Number(rest[1]) };
  return {};
}

const [action, commandName, ...rest] = process.argv.slice(2);
if (!['status', 'send'].includes(action) || (action === 'send' && !commandName)) {
  fail('Use status, or send with a command name.', 1);
}

const token = pairingToken();
const transport = createFunctionTransport({ url, publishableKey: key, refreshToken: token, pollMs: 400 });
const adapter = createGrokAdapter({ transport });
const deadline = Date.now() + waitMs;
try {
  await adapter.attach();
  while (!adapter.latest() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
  const state = adapter.latest();
  if (!state || !fresh(state, Date.now())) {
    console.log(JSON.stringify({ type: 'state', stale: true, phase: state?.phase || null, publishedAt: state?.publishedAt || null }));
    process.exit(2);
  }
  if (action === 'status') {
    console.log(JSON.stringify({
      type: 'state', stale: false, phase: state.phase, armed: state.armed,
      epoch: state.epoch, sessionId: state.sessionId, sensorFresh: state.sensorFresh,
      pressureKpa: state.pressureKpa, edgeCount: state.edgeCount, pattern: state.pattern,
      outputPercentA: state.outputPercentA, outputPercentB: state.outputPercentB, publishedAt: state.publishedAt,
    }));
    process.exit(0);
  }
  const sent = await adapter.command(commandName, paramsFor(commandName, rest));
  const ackDeadline = Date.now() + waitMs;
  let ack = null;
  while (Date.now() < ackDeadline) {
    ack = adapter.acks().find(item => item.commandId === sent.envelope.id);
    if (ack) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ack) {
    console.error('No acknowledgement arrived before the wait ended.');
    process.exit(3);
  }
  console.log(JSON.stringify({
    type: 'ack', command: commandName, commandId: ack.commandId, accepted: ack.accepted,
    applied: ack.applied, hardware: ack.hardware, reason: ack.reason || '',
  }));
  process.exit(ack.applied === true ? 0 : 4);
} finally {
  transport.close();
}
