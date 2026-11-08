/**
 * Owner-side command adapter. A chat product is not connected by itself.
 * Credentials stay in the environment. The service role is refused.
 */
import { COMMAND_NAMES, jwtRole, SCHEMA, topicForUser } from '../app/grok-control.js';
import { createGrokBridgeClient } from '../app/grok-bridge-client.js';

export function createGrokAdapter({ transport, now = () => Date.now(), ttlMs = 5000, log = () => {} }) {
  let latest = null;
  let seq = 0;
  let sessionId = null;
  let epoch = null;
  const acks = [];
  const events = [];
  const states = [];

  function noteState(payload) {
    if (!payload || payload.sessionId == null) return;
    const resumed = payload.sessionId === sessionId && payload.epoch === epoch;
    if (!resumed) {
      sessionId = payload.sessionId;
      epoch = payload.epoch;
      seq = Number.isSafeInteger(payload.lastSeq) ? payload.lastSeq : 0;
    } else if (Number.isSafeInteger(payload.lastSeq) && payload.lastSeq > seq) {
      seq = payload.lastSeq;
    }
    latest = payload;
    states.push(payload);
    log({
      type: 'state',
      sessionId: payload.sessionId,
      epoch: payload.epoch,
      armed: payload.armed,
      phase: payload.phase,
      edgeCount: payload.edgeCount,
      sensorFresh: payload.sensorFresh,
    });
  }

  return {
    latest() { return latest; },
    states() { return states; },
    events() { return events; },
    acks() { return acks; },
    async attach() {
      await transport.subscribe({
        onState: noteState,
        onAck(payload) { acks.push(payload); log({ type: 'ack', accepted: payload?.accepted, applied: payload?.applied, hardware: payload?.hardware, reason: payload?.reason }); },
        onEvent(payload) { events.push(payload); log({ type: 'event', event: payload?.event, edgeCount: payload?.edgeCount, phase: payload?.phase }); },
      });
    },
    command(name, params = {}) {
      if (!latest?.sessionId || latest.epoch == null) throw new Error('No live session state yet.');
      if (latest.armed !== true && name !== 'stop') throw new Error('The page is not armed.');
      seq += 1;
      const issuedAt = now();
      const envelope = {
        v: SCHEMA,
        id: globalThis.crypto.randomUUID(),
        seq,
        sessionId: latest.sessionId,
        epoch: latest.epoch,
        issuedAt,
        expiresAt: issuedAt + ttlMs,
        command: name,
        params,
      };
      log({ type: 'send', command: name, seq, sessionId: envelope.sessionId, epoch: envelope.epoch });
      return transport.send(envelope);
    },
  };
}

export function bindCommandInput(adapter, input, { writeError = () => {}, onState } = {}) {
  input.on('line', line => {
    const trimmed = String(line ?? '').trim();
    if (!trimmed) return;
    let parsed;
    try { parsed = JSON.parse(trimmed); }
    catch { writeError('Command was not understood.'); return; }
    if (parsed?.type === 'state' && onState) { onState(parsed); return; }
    let request;
    try { request = commandFromLine(trimmed); }
    catch (err) { writeError(err.message || 'Command was not understood.'); return; }
    let pending;
    try { pending = adapter.command(request.command, request.params); }
    catch (err) { writeError(err.message || 'Command was not sent.'); return; }
    Promise.resolve(pending).catch(err => writeError(err?.message || 'Command was not sent.'));
  });
}

export function commandFromLine(line) {
  let parsed;
  try { parsed = JSON.parse(line); } catch { throw new Error('Command was not understood.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Command was not understood.');
  if (typeof parsed.command !== 'string' || !COMMAND_NAMES.includes(parsed.command)) throw new Error('Unknown command.');
  const params = parsed.params && typeof parsed.params === 'object' && !Array.isArray(parsed.params) ? parsed.params : {};
  return { command: parsed.command, params };
}

export function createMockTransport() {
  const listeners = { state: [], ack: [], event: [] };
  return {
    listeners,
    async subscribe({ onState, onAck, onEvent }) {
      listeners.state.push(onState);
      listeners.ack.push(onAck);
      listeners.event.push(onEvent);
    },
    async send(envelope) {
      const ack = { v: 1, type: 'ack', commandId: envelope.id, seq: envelope.seq, accepted: true, applied: true, hardware: 'not-confirmed', reason: '' };
      for (const listener of listeners.ack) listener(ack);
      return { sent: true, envelope };
    },
    emitState(payload) { for (const listener of listeners.state) listener(payload); },
    emitEvent(payload) { for (const listener of listeners.event) listener(payload); },
  };
}

export async function runDryDemo(log = console.log) {
  const transport = createMockTransport();
  const adapter = createGrokAdapter({ transport, now: () => 1_000_000, log });
  await adapter.attach();
  transport.emitState({ v: 1, type: 'state', sessionId: 'session-demo', epoch: 3, armed: true, phase: 'idle', sensorFresh: true });
  transport.emitEvent({ v: 1, type: 'event', event: 'session', id: 'event-demo', at: 1_000_000, sessionId: 'session-demo', epoch: 3, phase: 'idle', edgeCount: 0 });
  const sent = await adapter.command('stop');
  const ack = adapter.acks()[0];
  log({ type: 'dry-run', sent: sent.sent, accepted: ack.accepted, applied: ack.applied, hardware: ack.hardware });
  return { sent, ack };
}

export function createFunctionTransport({ url, publishableKey = '', refreshToken, fetchImpl = fetch, pollMs = 1000 }) {
  if (jwtRole(refreshToken) === 'service_role' || String(refreshToken || '').startsWith('sb_secret_')) {
    throw new Error('The service role is refused.');
  }
  const store = {
    value: refreshToken,
    get() { return this.value || ''; },
    set(value) { this.value = value; },
    clear() { this.value = ''; },
  };
  const client = createGrokBridgeClient({ url, publishableKey, fetchImpl, store });
  let timer = null;
  return {
    async subscribe({ onState, onAck, onEvent }) {
      await client.loginRefresh();
      const pull = async () => {
        const result = await client.read();
        if (result.state) onState(result.state);
        for (const event of result.events || []) onEvent(event);
        for (const ack of result.acks || []) onAck(ack);
      };
      await pull();
      timer = setInterval(() => { void pull().catch(() => {}); }, pollMs);
    },
    async send(envelope) {
      await client.send(envelope);
      return { sent: true, envelope };
    },
    close() { if (timer) clearInterval(timer); },
  };
}

export async function createSupabaseTransport({ url, key, accessToken, refreshToken = '' }) {
  if (jwtRole(accessToken) === 'service_role' || jwtRole(key) === 'service_role') throw new Error('The service role is refused.');
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false } });
  const { data, error } = await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
  if (error || !data.session?.user?.id) throw new Error('Owner session was not accepted.');
  const topic = topicForUser(data.session.user.id);
  const channel = client.channel(topic, { config: { private: true, broadcast: { self: false } } });
  return {
    async subscribe({ onState, onAck, onEvent }) {
      channel.on('broadcast', { event: 'state' }, ({ payload }) => onState(payload));
      channel.on('broadcast', { event: 'ack' }, ({ payload }) => onAck(payload));
      channel.on('broadcast', { event: 'event' }, ({ payload }) => onEvent(payload));
      await new Promise((resolve, reject) => {
        channel.subscribe(status => {
          if (status === 'SUBSCRIBED') resolve();
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error(status));
        });
      });
    },
    async send(envelope) {
      const result = await channel.send({ type: 'broadcast', event: 'command', payload: envelope });
      return { sent: result === 'ok', envelope };
    },
  };
}
