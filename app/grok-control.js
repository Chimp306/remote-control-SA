/**
 * Owner-only command policy for Grok Control.
 * This module does not connect to Bluetooth, Supabase, or the network.
 * The browser remains the only place that ticks the engine.
 */

export const SCHEMA = 1;
export const COMMAND_TTL_MS = 5000;
export const CLOCK_SKEW_MS = 2000;
export const STATE_LEASE_MS = 5000;
export const TOPIC_PREFIX = 'grok-control:';
export const COMMAND_NAMES = Object.freeze([
  'start', 'stop', 'pause', 'changePattern', 'forceCutoff', 'adjustCutoff', 'setDowntime',
]);

const ENVELOPE_KEYS = ['v', 'id', 'seq', 'sessionId', 'epoch', 'issuedAt', 'expiresAt', 'command', 'params'];

export function topicForUser(userId) {
  return `${TOPIC_PREFIX}${userId}`;
}

export function jwtRole(token) {
  if (typeof token !== 'string') return '';
  const part = token.split('.')[1];
  if (!part) return '';
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(globalThis.atob(padded + '='.repeat((4 - padded.length % 4) % 4)));
    return typeof json.role === 'string' ? json.role : '';
  } catch {
    return '';
  }
}

export function realtimeAllows({ role, userId, topic, op }) {
  if (role !== 'authenticated' || !userId) return false;
  if (op !== 'select' && op !== 'insert') return false;
  return topic === topicForUser(userId);
}

export function createGrokSession({ patterns, now = () => Date.now() } = {}) {
  const allow = new Set(patterns || []);
  let armed = false;
  let epoch = 0;
  let sessionId = null;
  let userId = null;
  let deviceId = null;
  let localLatch = null;
  let lastSeq = 0;
  const seen = [];

  function reject(reason, command = null) {
    return { accept: false, applied: false, action: null, reason, hardware: 'not-sent', command };
  }

  function remember(id) {
    if (!id || seen.includes(id)) return;
    seen.push(id);
    if (seen.length > 100) seen.shift();
  }

  function parse(raw, at) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'malformed' };
    if (Object.keys(raw).some(key => !ENVELOPE_KEYS.includes(key))) return { ok: false, reason: 'malformed' };
    if (raw.v !== SCHEMA || typeof raw.id !== 'string' || !raw.id || raw.id.length > 80) return { ok: false, reason: 'malformed' };
    if (!Number.isSafeInteger(raw.seq) || raw.seq < 1) return { ok: false, reason: 'malformed' };
    if (typeof raw.sessionId !== 'string' || typeof raw.command !== 'string') return { ok: false, reason: 'malformed' };
    if (!Number.isSafeInteger(raw.epoch) || raw.epoch < 0) return { ok: false, reason: 'malformed' };
    if (!Number.isFinite(raw.issuedAt) || !Number.isFinite(raw.expiresAt)) return { ok: false, reason: 'malformed' };
    if (raw.expiresAt < raw.issuedAt || raw.expiresAt - raw.issuedAt > COMMAND_TTL_MS) return { ok: false, reason: 'expiry' };
    if (raw.issuedAt > at + CLOCK_SKEW_MS || at > raw.expiresAt) return { ok: false, reason: 'expiry' };
    if (!COMMAND_NAMES.includes(raw.command)) return { ok: false, reason: 'unknown-command' };
    const params = raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params) ? raw.params : {};
    if (raw.command !== 'changePattern' && raw.command !== 'adjustCutoff' && raw.command !== 'setDowntime' && Object.keys(params).length) {
      return { ok: false, reason: 'malformed' };
    }
    return { ok: true, command: { ...raw, params } };
  }

  function decide(raw, view, transportUserId) {
    const at = now();
    const parsed = parse(raw, at);
    if (!parsed.ok) return reject(parsed.reason);
    const command = parsed.command;
    if (transportUserId !== userId || !userId) return reject('wrong-owner', command);
    if (!armed || !sessionId) return reject('disarmed', command);
    if (command.sessionId !== sessionId) return reject('wrong-session', command);
    if (seen.includes(command.id)) return reject('replay', command);
    if (command.epoch !== epoch) {
      remember(command.id);
      return reject('stale-epoch', command);
    }
    if (command.seq <= lastSeq) {
      remember(command.id);
      return reject('replay-or-stale-sequence', command);
    }
    if (command.seq !== lastSeq + 1) return reject('out-of-order', command);
    if (view?.deviceId !== deviceId) {
      remember(command.id);
      lastSeq = command.seq;
      return reject('device-mismatch', command);
    }
    if (localLatch && command.command !== 'stop') {
      remember(command.id);
      lastSeq = command.seq;
      return reject(localLatch === 'pause' ? 'local-pause' : 'local-latch', command);
    }
    const base = { accept: true, applied: true, hardware: 'commanded', command, reason: '' };
    if (command.command === 'stop') return { ...base, action: 'stop' };
    if (command.command === 'start') {
      if (view.phase === 'running') return { ...base, applied: false, action: null, reason: 'already-running', hardware: 'not-sent' };
      if (view.phase !== 'idle' && view.phase !== 'stopped') return { ...reject('not-idle', command), accept: false };
      if (!view.sensorFresh) return consumeReject('stale-sensor', command);
      if (!view.outputPermitted) return consumeReject('calibration', command);
      return { ...base, action: 'start' };
    }
    if (command.command === 'pause') {
      if (!['running', 'cooldown', 'settling'].includes(view.phase)) return consumeReject('not-active', command);
      return { ...base, action: 'pause' };
    }
    if (command.command === 'forceCutoff') {
      if (view.phase !== 'running') return consumeReject('not-running', command);
      if (!view.sensorFresh) return consumeReject('stale-sensor', command);
      return { ...base, action: 'forceCutoff', hardware: 'commanded' };
    }
    if (command.command === 'changePattern') {
      const pattern = command.params?.pattern;
      if (Object.keys(command.params || {}).some(key => key !== 'pattern')) return consumeReject('malformed', command);
      if (!allow.has(pattern)) return consumeReject('pattern', command);
      if (!['running', 'cooldown', 'settling'].includes(view.phase)) return consumeReject('not-active', command);
      return { ...base, action: 'changePattern', params: { pattern } };
    }
    if (command.command === 'adjustCutoff') {
      const delta = command.params?.delta;
      if (Object.keys(command.params || {}).some(key => key !== 'delta') || (delta !== 0.1 && delta !== -0.1)) return consumeReject('delta', command);
      const next = Math.round((view.threshold + delta) * 100) / 100;
      if (next < view.cutoffMin || next > view.cutoffMax) return consumeReject('cutoff-bounds', command);
      return { ...base, action: 'adjustCutoff', params: { delta } };
    }
    const min = command.params?.min;
    const max = command.params?.max;
    if (Object.keys(command.params || {}).some(key => key !== 'min' && key !== 'max')) return consumeReject('malformed', command);
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max > 300 || max < min) return consumeReject('downtime', command);
    return { ...base, action: 'setDowntime', params: { min, max } };
  }

  function consumeReject(reason, command) {
    remember(command.id);
    lastSeq = command.seq;
    return reject(reason, command);
  }

  return {
    get armed() { return armed; },
    get epoch() { return epoch; },
    get sessionId() { return sessionId; },
    get userId() { return userId; },
    get deviceId() { return deviceId; },
    get localLatch() { return localLatch; },
    arm({ nextUserId, nextDeviceId }) {
      if (!nextUserId || !nextDeviceId) return { ok: false, reason: 'missing-identity' };
      sessionId = globalThis.crypto.randomUUID();
      epoch += 1;
      armed = true;
      localLatch = null;
      lastSeq = 0;
      seen.length = 0;
      userId = nextUserId;
      deviceId = nextDeviceId;
      return { ok: true, sessionId, epoch };
    },
    disarm(reason = 'disarm') {
      armed = false;
      localLatch = reason;
      epoch += 1;
      return { epoch, sessionId };
    },
    localStop() { return this.disarm('stop'); },
    localPause() {
      localLatch = 'pause';
      epoch += 1;
      return { epoch };
    },
    authLost() {
      userId = null;
      return this.disarm('auth');
    },
    noteDevice(nextDeviceId) {
      if (armed && nextDeviceId && nextDeviceId !== deviceId) return this.disarm('device');
      return { epoch, sessionId };
    },
    hold() {
      return { epoch, sessionId, armed, localLatch };
    },
    same(hold) {
      return Boolean(hold) && hold.epoch === epoch && hold.sessionId === sessionId && hold.armed === armed && hold.localLatch === localLatch;
    },
    selfTransition(hold, latch) {
      if (!hold || hold.sessionId !== sessionId || localLatch !== latch) return false;
      if (epoch !== hold.epoch + 1) return false;
      if (latch === 'pause') return armed === hold.armed;
      return armed === false;
    },
    evaluate(raw, view, transportUserId) {
      const decision = decide(raw, view, transportUserId);
      if (decision.accept && decision.command) {
        remember(decision.command.id);
        lastSeq = decision.command.seq;
      }
      return decision;
    },
  };
}

export function stateEvent(view) {
  return {
    v: SCHEMA,
    type: 'state',
    sessionId: view.sessionId,
    epoch: view.epoch,
    armed: view.armed === true,
    phase: view.phase,
    sensorFresh: view.sensorFresh === true,
    pressureKpa: Number.isFinite(view.pressureKpa) ? Math.round(view.pressureKpa * 100) / 100 : null,
    threshold: view.threshold,
    resetThreshold: view.resetThreshold,
    edgeCount: view.edgeCount,
    pattern: view.pattern,
    outputPercentA: view.outputPercentA,
    outputPercentB: view.outputPercentB,
    recoveryMin: view.recoveryMin,
    recoveryMax: view.recoveryMax,
    civetConnected: view.civetConnected === true,
    opossumConnected: view.opossumConnected === true,
    link: view.link,
    publishedAt: view.publishedAt,
    leaseMs: STATE_LEASE_MS,
  };
}

export function createChannelGate() {
  let generation = 0;
  let userId = null;
  return {
    current() { return { generation, userId }; },
    bind(nextUserId) {
      generation += 1;
      userId = nextUserId || null;
      return { generation, userId };
    },
    clear() {
      generation += 1;
      userId = null;
      return { generation, userId };
    },
    matches(token) {
      return Boolean(token) && token.generation === generation && token.userId === userId && userId != null;
    },
  };
}

export function channelStillCurrent(binding, active) {
  if (!binding) return true;
  const host = active?.binding;
  if (!host || active.userId == null) return false;
  return binding.generation === host.generation && binding.userId === host.userId && binding.userId === active.userId;
}

export function listenForCommands(channel, gate, bound, onCommand) {
  channel.on('broadcast', { event: 'command' }, ({ payload }) => {
    if (!gate.matches(bound)) return;
    onCommand(payload, bound);
  });
}

export async function settleChannelCommand({ binding, current, run, publish }) {
  if (!channelStillCurrent(binding, current())) return { executed: false, published: false };
  const outcome = await run();
  if (!channelStillCurrent(binding, current())) return { executed: true, published: false, outcome };
  await publish(outcome);
  return { executed: true, published: true, outcome };
}

export function signInFailureMessage(kind) {
  if (kind === 'credentials') return 'That email or password was not accepted.';
  if (kind === 'network') return 'Sign-in could not reach the account service.';
  if (kind === 'rejected') return 'That credential is not accepted on this page.';
  return 'Sign-in did not complete. This page cannot create an account.';
}

export async function runAcceptedCommand({ decision, hold, same, selfOk, operations }) {
  if (!decision.accept || !decision.action) {
    return { ...decision, applied: false, hardware: decision.hardware || 'not-sent' };
  }
  if (!same(hold)) {
    return { ...decision, accept: false, applied: false, reason: 'superseded', hardware: 'not-sent' };
  }
  const outcome = await operations[decision.action](decision);
  const ownEffect = !same(hold) && selfOk?.(hold) === true;
  if (!same(hold) && !ownEffect) {
    return { ...decision, accept: false, applied: false, reason: 'superseded', hardware: 'not-sent' };
  }
  return {
    ...decision,
    applied: outcome?.applied === true,
    hardware: outcome?.hardware || 'not-confirmed',
    reason: outcome?.applied === true ? (outcome.reason || '') : (outcome?.reason || 'not-applied'),
  };
}

export function controlEvent(view) {
  return {
    v: SCHEMA,
    type: 'event',
    event: view.event,
    id: view.id,
    at: view.at,
    sessionId: view.sessionId || null,
    epoch: view.epoch || 0,
    phase: view.phase,
    edgeCount: view.edgeCount,
    pattern: view.pattern,
    sensorFresh: view.sensorFresh === true,
    pressureKpa: Number.isFinite(view.pressureKpa) ? Math.round(view.pressureKpa * 100) / 100 : null,
    threshold: view.threshold,
    resetThreshold: view.resetThreshold,
    outputPercentA: view.outputPercentA,
    outputPercentB: view.outputPercentB,
  };
}

export function ackEvent(decision, extra = {}) {
  return {
    v: SCHEMA,
    type: 'ack',
    commandId: decision.command?.id || null,
    seq: decision.command?.seq || null,
    sessionId: extra.sessionId || decision.command?.sessionId || null,
    epoch: extra.epoch ?? null,
    accepted: decision.accept === true,
    applied: decision.applied === true,
    hardware: extra.hardware || decision.hardware || 'not-confirmed',
    reason: decision.reason || '',
  };
}
