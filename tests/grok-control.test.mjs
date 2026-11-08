import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SessionEngine } from '../app/engine.js';
import {
  ackEvent,
  createGrokSession,
  jwtRole,
  realtimeAllows,
  stateEvent,
  topicForUser,
} from '../app/grok-control.js';
import { mapRequestPath } from '../scripts/site-paths.mjs';

const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
const patterns = ['synchronized', 'sine-wave'];

function token(role) {
  return `h.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.s`;
}

function session() {
  return createGrokSession({ patterns, now: () => 1_000_000 });
}

function armed() {
  const gate = session();
  const result = gate.arm({ nextUserId: 'owner', nextDeviceId: 'sensor-a' });
  return { gate, result };
}

function command(gate, seq, name, params = {}, extra = {}) {
  return {
    v: 1,
    id: extra.id || `cmd-${seq}`,
    seq,
    sessionId: extra.sessionId || gate.sessionId,
    epoch: extra.epoch ?? gate.epoch,
    issuedAt: 1_000_000,
    expiresAt: 1_004_000,
    command: name,
    params,
  };
}

const ready = {
  phase: 'idle',
  sensorFresh: true,
  outputPermitted: true,
  deviceId: 'sensor-a',
  threshold: 0.2,
  cutoffMin: 0.2,
  cutoffMax: 0.22,
};

test('only the authenticated owner may use the private topic', () => {
  const topic = topicForUser('owner');
  assert.equal(realtimeAllows({ role: 'anon', userId: null, topic, op: 'select' }), false);
  assert.equal(realtimeAllows({ role: 'authenticated', userId: 'other', topic, op: 'select' }), false);
  assert.equal(realtimeAllows({ role: 'authenticated', userId: 'owner', topic, op: 'select' }), true);
  assert.equal(realtimeAllows({ role: 'authenticated', userId: 'owner', topic, op: 'insert' }), true);
  assert.equal(realtimeAllows({ role: 'authenticated', userId: 'owner', topic, op: 'delete' }), false);
  assert.equal(jwtRole(token('service_role')), 'service_role');
  assert.notEqual(jwtRole(token('authenticated')), 'service_role');
  const sql = read('../supabase/migrations/20261108210000_grok_control_realtime.sql').replace(/--.*$/gm, '');
  assert.match(sql, /to authenticated/);
  assert.equal(sql.includes('freq_entries'), false);
  assert.equal(sql.includes('ctmp_v2'), false);
  assert.match(sql, /grok-control:' \|\| \(select auth\.uid\(\)\)::text/);
  assert.equal(sql.includes('to anon'), false);
});

test('expired, replayed, out-of-order, and foreign commands are rejected', () => {
  const { gate } = armed();
  const first = command(gate, 1, 'start');
  assert.equal(gate.evaluate(first, ready, 'owner').action, 'start');
  assert.equal(gate.evaluate(first, ready, 'owner').reason, 'replay');
  assert.equal(gate.evaluate(command(gate, 1, 'stop', {}, { id: 'other' }), ready, 'owner').reason, 'replay-or-stale-sequence');
  assert.equal(gate.evaluate(command(gate, 3, 'stop', {}, { id: 'skip' }), ready, 'owner').reason, 'out-of-order');
  const expired = command(gate, 2, 'stop', {}, { id: 'old' });
  expired.expiresAt = 999_000;
  assert.equal(gate.evaluate(expired, ready, 'owner').reason, 'expiry');
  assert.equal(gate.evaluate(command(gate, 2, 'stop', {}, { id: 'stranger', sessionId: 'nope' }), ready, 'owner').reason, 'wrong-session');
  assert.equal(gate.evaluate(command(gate, 2, 'stop', {}, { id: 'owner-b' }), ready, 'intruder').reason, 'wrong-owner');
});

test('local stop beats an in-flight start, and pause, fault, auth, and device changes block restart', () => {
  const { gate } = armed();
  const start = command(gate, 1, 'start');
  const decision = gate.evaluate(start, ready, 'owner');
  const hold = gate.hold();
  assert.equal(decision.action, 'start');
  gate.localStop();
  assert.equal(gate.same(hold), false);
  assert.equal(gate.armed, false);
  assert.equal(gate.evaluate(command(gate, 1, 'start', {}, { id: 'late', epoch: hold.epoch }), ready, 'owner').reason, 'disarmed');
  gate.arm({ nextUserId: 'owner', nextDeviceId: 'sensor-a' });
  gate.localPause();
  assert.equal(gate.evaluate(command(gate, 1, 'start'), { ...ready, phase: 'paused' }, 'owner').reason, 'local-pause');
  gate.authLost();
  assert.equal(gate.userId, null);
  assert.equal(gate.evaluate(command(gate, 1, 'start', {}, { id: 'after-auth' }), ready, 'owner').reason, 'wrong-owner');
  gate.arm({ nextUserId: 'owner', nextDeviceId: 'sensor-a' });
  assert.equal(gate.evaluate(command(gate, 1, 'start'), { ...ready, deviceId: 'sensor-b' }, 'owner').reason, 'device-mismatch');
  assert.equal(gate.evaluate(command(gate, 2, 'start', {}, { id: 'uncal' }), { ...ready, outputPermitted: false }, 'owner').reason, 'calibration');
  assert.equal(gate.evaluate(command(gate, 3, 'start', {}, { id: 'stale' }), { ...ready, sensorFresh: false }, 'owner').reason, 'stale-sensor');
  assert.equal(gate.evaluate(command(gate, 4, 'adjustCutoff', { delta: 1 }, { id: 'cap' }), ready, 'owner').reason, 'delta');
  assert.equal(gate.evaluate(command(gate, 5, 'changePattern', { pattern: 'custom' }, { id: 'pat' }), { ...ready, phase: 'running' }, 'owner').reason, 'pattern');
});

test('force cutoff enters recovery without changing the pressure sample', () => {
  let now = 10_000;
  const engine = new SessionEngine({ now: () => now, random: () => 0 });
  engine.configure({ threshold: 0.2, resetThreshold: 0.19, toy: 'opossum', mode: 'solo', rampSeconds: 0, recoveryMinSeconds: 5, recoveryMaxSeconds: 5, adaptiveEnabled: false });
  engine.updatePressure(0.18, now);
  engine.start();
  now += 100;
  engine.updatePressure(0.18, now);
  const before = engine.snapshot();
  const result = engine.requestRecovery('Remote cutoff.');
  const after = engine.snapshot();
  assert.equal(result.applied, true);
  assert.equal(after.pressure, before.pressure);
  assert.equal(after.pressureAt, before.pressureAt);
  assert.equal(after.phase, 'cooldown');
  assert.equal(after.edgeCount, before.edgeCount + 1);
  assert.equal(after.outputPercentA, 0);
  assert.equal(engine.requestRecovery().applied, false);
});

test('state and ack payloads omit secrets and mark hardware as commanded', () => {
  const state = stateEvent({
    sessionId: 's', epoch: 2, armed: true, phase: 'running', sensorFresh: true,
    pressureKpa: 0.184, threshold: 0.2, resetThreshold: 0.19, edgeCount: 1,
    pattern: 'synchronized', outputPercentA: 10, outputPercentB: 0,
    recoveryMin: 5, recoveryMax: 5, civetConnected: true, opossumConnected: true,
    link: 'live', publishedAt: 10,
  });
  assert.equal(state.pressureKpa, 0.18);
  assert.equal(JSON.stringify(state).includes('service_role'), false);
  assert.equal(state.leaseMs, 5000);
  const ack = ackEvent({ accept: true, applied: true, hardware: 'commanded', reason: '', command: { id: 'c', seq: 1, sessionId: 's' } }, { epoch: 2, hardware: 'commanded' });
  assert.equal(ack.hardware, 'commanded');
  assert.equal(ack.applied, true);
});

test('SOLO and SUC do not open the Grok channel', () => {
  const player = read('../app/simple-player.js');
  const suc = read('../suc/index.html');
  const solo = read('../SOLO/index.html');
  const grok = read('../GROK/index.html');
  assert.match(player, /const grokMode = \/\^\\\/GROK\\\/\?\$\//);
  assert.match(player, /if \(grokMode && !testMode\)/);
  assert.equal(suc.includes('grok-control'), false);
  assert.equal(solo.includes('grok-link'), false);
  assert.match(grok, /\/app\/simple-player\.js\?v=\$\{version\}/);
  assert.deepEqual(mapRequestPath('/GROK'), { redirect: '/GROK/' });
  assert.deepEqual(mapRequestPath('/GROK/'), { file: '/GROK/index.html' });
  assert.deepEqual(mapRequestPath('/SOLO/'), { file: '/SOLO/index.html' });
  const client = read('../scripts/grok-control-client.mjs');
  assert.match(client, /service role is refused/i);
  assert.equal(client.includes('SERVICE_ROLE'), false);
});
