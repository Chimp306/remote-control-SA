import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SessionEngine } from '../app/engine.js';
import {
  ackEvent,
  controlEvent,
  createChannelGate,
  createGrokSession,
  jwtRole,
  listenForCommands,
  realtimeAllows,
  runAcceptedCommand,
  settleChannelCommand,
  signInFailureMessage,
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

test('sign-in failures stay fixed sentences', () => {
  const secret = 'not-a-real-password';
  const messages = ['credentials', 'network', 'rejected', 'unknown'].map(kind => signInFailureMessage(kind));
  for (const message of messages) {
    assert.equal(message.includes(secret), false);
    assert.equal(message.toLowerCase().includes('service_role'), false);
    assert.equal(message.includes('@'), false);
  }
  assert.match(messages[0], /email or password/);
  assert.match(messages[1], /could not reach/);
});

test('a remote stop that disarms itself still counts as applied', async () => {
  const gate = session();
  gate.arm({ nextUserId: 'owner', nextDeviceId: 'sensor-a' });
  const decision = gate.evaluate(command(gate, 1, 'stop'), { ...ready, phase: 'running' }, 'owner');
  const hold = gate.hold();
  const result = await runAcceptedCommand({
    decision,
    hold,
    same: token => gate.same(token),
    selfOk: token => gate.selfTransition(token, 'stop'),
    operations: {
      stop: async () => {
        gate.localStop();
        return { applied: true, hardware: 'not-confirmed', reason: '' };
      },
    },
  });
  assert.equal(result.applied, true);
  assert.equal(result.hardware, 'not-confirmed');
  assert.equal(result.reason, '');
  assert.equal(gate.armed, false);
  assert.equal(gate.selfTransition({ ...hold, sessionId: 'other-session' }, 'stop'), false);
});

test('a stale start completion does not stop a later session', async () => {
  let stopped = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let current = true;
  const resultPromise = runAcceptedCommand({
    decision: { accept: true, applied: true, action: 'start', hardware: 'commanded', reason: '', command: { id: 'c', seq: 1, sessionId: 's' } },
    hold: { epoch: 1 },
    same: () => current,
    operations: {
      start: () => pending,
      stop: async () => { stopped += 1; return { applied: true, hardware: 'not-confirmed' }; },
    },
  });
  current = false;
  release({ applied: true, hardware: 'not-confirmed' });
  const result = await resultPromise;
  assert.equal(stopped, 0);
  assert.equal(result.reason, 'superseded');
  assert.equal(result.applied, false);
  assert.equal(result.hardware, 'not-sent');
  const failed = await runAcceptedCommand({
    decision: { accept: true, action: 'start', command: { id: 'd', seq: 2 } },
    hold: {},
    same: () => true,
    operations: { start: async () => ({ applied: false, hardware: 'not-sent', reason: 'calibration' }) },
  });
  assert.equal(failed.applied, false);
  assert.equal(failed.hardware, 'not-sent');
});

test('an old start completion does not stop a rearmed session', async () => {
  const gate = session();
  gate.arm({ nextUserId: 'owner', nextDeviceId: 'sensor-a' });
  const first = gate.evaluate(command(gate, 1, 'start'), ready, 'owner');
  const hold = gate.hold();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let stopped = 0;
  const oldResult = runAcceptedCommand({
    decision: first,
    hold,
    same: token => gate.same(token),
    operations: {
      start: () => pending.then(value => (gate.same(hold) ? value : { applied: false, hardware: 'not-sent', reason: 'superseded' })),
      stop: async () => { stopped += 1; return { applied: true, hardware: 'not-confirmed' }; },
    },
  });
  gate.localStop();
  gate.arm({ nextUserId: 'owner', nextDeviceId: 'sensor-a' });
  const restarted = gate.hold();
  const again = gate.evaluate(command(gate, 1, 'start', {}, { id: 'rearmed' }), ready, 'owner');
  const restartedResult = await runAcceptedCommand({
    decision: again,
    hold: restarted,
    same: token => gate.same(token),
    operations: {
      start: async () => ({ applied: true, hardware: 'not-confirmed' }),
      stop: async () => { stopped += 1; return { applied: true, hardware: 'not-confirmed' }; },
    },
  });
  release({ applied: true, hardware: 'not-confirmed' });
  const finished = await oldResult;
  assert.equal(finished.reason, 'superseded');
  assert.equal(finished.applied, false);
  assert.equal(stopped, 0);
  assert.equal(restartedResult.applied, true);
  assert.equal(gate.armed, true);
  assert.equal(gate.sessionId, restarted.sessionId);
});

test('an owner change invalidates the previous channel callback', () => {
  const gate = createChannelGate();
  const first = gate.bind('owner-a');
  const second = gate.bind('owner-b');
  assert.equal(gate.matches(first), false);
  assert.equal(gate.matches(second), true);
  gate.clear();
  assert.equal(gate.matches(second), false);
  const event = controlEvent({
    event: 'edge', id: 'e1', at: 10, sessionId: 's', epoch: 2, phase: 'cooldown',
    edgeCount: 1, pattern: 'synchronized', sensorFresh: true, pressureKpa: 0.2,
    threshold: 0.2, resetThreshold: 0.19, outputPercentA: 0, outputPercentB: 0,
  });
  assert.equal(event.event, 'edge');
  assert.equal(event.type, 'event');
  assert.equal(JSON.stringify(event).toLowerCase().includes('clench'), false);
});

function mockChannel() {
  const handlers = [];
  return {
    on(type, filter, handler) { handlers.push({ type, filter, handler }); },
    emit(event, payload) {
      for (const item of handlers) {
        if (item.type === 'broadcast' && item.filter?.event === event) item.handler({ payload });
      }
    },
  };
}

test('channel callbacks ack through a different binding object and a replaced channel stays silent', async () => {
  const gate = createChannelGate();
  const session = createGrokSession({ patterns, now: () => 1_000_000 });
  session.arm({ nextUserId: 'owner', nextDeviceId: 'sensor-a' });
  let host = null;
  const userId = 'owner';
  const ran = [];
  const acks = [];
  const pending = [];
  let release = null;
  function wire(channel) {
    const bound = gate.bind(userId);
    listenForCommands(channel, gate, bound, (payload, binding) => {
      const job = settleChannelCommand({
        binding,
        current: () => ({ binding: host, userId }),
        run() {
          ran.push(payload.id);
          if (payload.id === 'slow') return new Promise(resolve => { release = resolve; });
          const decision = session.evaluate(payload, ready, userId);
          const hold = session.hold();
          return runAcceptedCommand({
            decision,
            hold,
            same: token => session.same(token),
            operations: { stop: async () => ({ applied: true, hardware: 'not-confirmed', reason: '' }) },
          });
        },
        async publish(outcome) {
          acks.push(ackEvent(outcome, { sessionId: session.sessionId, epoch: session.epoch }));
        },
      });
      pending.push(job);
      return job;
    });
    host = { generation: bound.generation, userId: bound.userId };
    assert.notEqual(host, bound);
    return bound;
  }
  const first = mockChannel();
  wire(first);
  first.emit('command', command(session, 1, 'stop', {}, { id: 'stop-1' }));
  first.emit('command', command(session, 2, 'changePattern', { pattern: 'nope' }, { id: 'bad-pattern' }));
  await Promise.all(pending);
  const accepted = acks.find(item => item.commandId === 'stop-1');
  const rejected = acks.find(item => item.commandId === 'bad-pattern');
  assert.equal(accepted?.accepted, true);
  assert.equal(accepted?.applied, true);
  assert.equal(accepted?.type, 'ack');
  assert.equal(rejected?.accepted, false);
  assert.equal(rejected?.applied, false);
  assert.equal(rejected?.reason, 'pattern');

  first.emit('command', command(session, 3, 'stop', {}, { id: 'slow' }));
  assert.equal(ran.includes('slow'), true);
  const second = mockChannel();
  wire(second);
  first.emit('command', command(session, 4, 'stop', {}, { id: 'late' }));
  assert.equal(ran.includes('late'), false);
  release({ accept: true, applied: true, action: 'stop', hardware: 'not-confirmed', reason: '', command: { id: 'slow', seq: 3 } });
  await Promise.all(pending);
  assert.equal(acks.some(item => item.commandId === 'slow'), false);
  assert.equal(acks.some(item => item.commandId === 'late'), false);

  second.emit('command', command(session, 3, 'stop', {}, { id: 'next-stop' }));
  await Promise.all(pending);
  assert.equal(ran.includes('next-stop'), true);
  assert.equal(acks.some(item => item.commandId === 'next-stop' && item.accepted === true && item.applied === true), true);
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
  const startFn = player.slice(player.indexOf('async start()'), player.indexOf('async forceCutoff'));
  assert.equal(startFn.includes('onStop'), false);
  const pauseFn = player.slice(player.indexOf('async pause()'), player.indexOf('async start()'));
  assert.match(pauseFn, /localPause\(\)/);
  assert.match(pauseFn, /await opossum\.stop\(\)/);
  assert.match(player, /selfTransition/);
  assert.match(player, /publishGrokEvent\('fault'\)/);
  assert.match(player, /settleChannelCommand/);
  assert.equal(player.includes('binding !== grokBinding'), false);
  assert.match(player, /data-grok-auth/);
  assert.match(player, /signInFailureMessage/);
  const link = read('../app/grok-link.js');
  assert.match(link, /setTimeout\(\(\) => handler\(event, session\), 0\)/);
  assert.match(link, /gate\.bind\(expectedUserId\)/);
  assert.match(link, /listenForCommands/);
  assert.match(link, /failureKind/);
});
