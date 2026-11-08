/**
 * Owner-token transport for Grok Control. The service role is never loaded.
 * There is no Supabase Auth session and no Realtime channel.
 */
import { GROK_FUNCTION_URL, GROK_PUBLISHABLE_KEY } from './grok-public.js?v=20261108-v221';
import { browserRefreshStore, createGrokBridgeClient } from './grok-bridge-client.js?v=20261108-v221';
import { createChannelGate } from './grok-control.js?v=20261108-v221';

export function grokEndpoint() {
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('bridge')) {
    return `${location.origin}/functions/v1/grok-control`;
  }
  return GROK_FUNCTION_URL;
}

export function createGrokLink() {
  const client = createGrokBridgeClient({
    url: grokEndpoint(),
    publishableKey: GROK_PUBLISHABLE_KEY,
    store: browserRefreshStore(),
  });
  const gate = createChannelGate();
  let handler = null;
  let onCommand = null;
  let bound = null;
  let timer = null;
  let pendingState = null;
  const pendingEvents = [];
  const pendingAcks = [];

  function emit(event, session) {
    setTimeout(() => handler?.(event, session), 0);
  }

  function drop() {
    gate.clear();
    bound = null;
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function tick() {
    if (!bound || !gate.matches(bound)) return;
    const token = bound;
    try {
      const result = await client.sync({
        state: pendingState,
        events: pendingEvents.splice(0, 20),
        acks: pendingAcks.splice(0, 20),
      });
      pendingState = null;
      if (!gate.matches(token)) return;
      for (const command of result.commands || []) onCommand?.(command, token);
    } catch (err) {
      if (err?.kind !== 'credentials' || !gate.matches(token)) return;
      drop();
      emit('SIGNED_OUT', null);
    }
  }

  return {
    onAuth(next) { handler = next; },
    async restore() {
      if (!client.hasRefresh()) return false;
      const result = await client.loginRefresh();
      emit('SIGNED_IN', { user: { id: result.ownerId } });
      return true;
    },
    async signIn(enrollment) {
      const result = await client.loginEnrollment(enrollment);
      emit('SIGNED_IN', { user: { id: result.ownerId } });
      return result.ownerId;
    },
    async pair(code) {
      const result = await client.redeemPair(code);
      emit('SIGNED_IN', { user: { id: result.ownerId } });
      return result.ownerId;
    },
    botRefresh() {
      return '';
    },
    takeRefresh() {
      try { return localStorage.getItem('ctmp-grok-refresh-v1') || ''; } catch { return ''; }
    },
    drop,
    async signOut() {
      drop();
      try { await client.logout(); } catch { /* the page already disarmed */ }
      emit('SIGNED_OUT', null);
    },
    async open(commandHandler, expectedUserId) {
      bound = gate.bind(expectedUserId);
      onCommand = commandHandler;
      if (timer) clearInterval(timer);
      timer = setInterval(() => { void tick(); }, 1000);
      void tick();
      return { topic: 'grok-bridge', generation: bound.generation, userId: expectedUserId };
    },
    async publish(event, payload, token) {
      if (token && !gate.matches(token)) return { sent: false };
      if (event === 'state') pendingState = payload;
      else if (event === 'event') pendingEvents.push(payload);
      else if (event === 'ack') pendingAcks.push(payload);
      return { sent: true };
    },
    async close() {
      this.drop();
    },
  };
}
