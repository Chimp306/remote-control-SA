/**
 * Owner JWT transport for Grok Control. The service role is refused.
 * Broadcasts are not stored. private:true still needs the realtime.messages policies.
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm';
import { API_URL, PUBLISHABLE_KEY } from './config.js?v=20261108-v215';
import { createChannelGate, jwtRole, topicForUser } from './grok-control.js?v=20261108-v216';

export function projectUrl(apiUrl) {
  return new URL(apiUrl).origin;
}

export function createGrokLink() {
  const client = createClient(projectUrl(API_URL), PUBLISHABLE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
      storageKey: 'ctmp-grok-auth',
    },
  });
  const gate = createChannelGate();
  let channel = null;

  function requireUser(session) {
    const role = jwtRole(session?.access_token || '');
    if (role === 'service_role') throw new Error('The service role is not accepted.');
    if (!session?.user?.id) throw new Error('Sign in is required.');
    return session.user.id;
  }

  return {
    client,
    onAuth(handler) {
      client.auth.onAuthStateChange((event, session) => {
        setTimeout(() => handler(event, session), 0);
      });
    },
    async signIn(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error || !data.session) {
        const failure = new Error('sign-in failed');
        failure.kind = failureKind(error);
        throw failure;
      }
      try {
        return requireUser(data.session);
      } catch (err) {
        try { await client.auth.signOut(); } catch { /* nothing to keep */ }
        const failure = new Error('sign-in failed');
        failure.kind = /service role/i.test(String(err?.message || '')) ? 'rejected' : 'unknown';
        throw failure;
      }
    },
    drop() {
      gate.clear();
      const current = channel;
      channel = null;
      if (current) void client.removeChannel(current).catch(() => {});
    },
    async signOut() {
      this.drop();
      try { await client.auth.signOut(); } catch { /* the page already disarmed */ }
    },
    async open(onCommand, expectedUserId) {
      const bound = gate.bind(expectedUserId);
      const previous = channel;
      channel = null;
      if (previous) void client.removeChannel(previous).catch(() => {});
      const { data } = await client.auth.getSession();
      let id = '';
      try { id = requireUser(data.session); } catch { id = ''; }
      if (!id || id !== expectedUserId || !gate.matches(bound)) return { stale: true };
      const topic = topicForUser(id);
      const next = client.channel(topic, { config: { private: true, broadcast: { self: false } } });
      next.on('broadcast', { event: 'command' }, ({ payload }) => {
        if (!gate.matches(bound)) return;
        onCommand(payload, bound);
      });
      channel = next;
      await new Promise((resolve, reject) => {
        next.subscribe(status => {
          if (!gate.matches(bound)) { resolve(); return; }
          if (status === 'SUBSCRIBED') resolve();
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error(status));
        });
      });
      if (!gate.matches(bound)) {
        try { await client.removeChannel(next); } catch { /* already closed */ }
        if (channel === next) channel = null;
        return { stale: true };
      }
      return { topic, generation: bound.generation, userId: id };
    },
    async publish(event, payload, token) {
      if (!channel || (token && !gate.matches(token))) return { sent: false };
      const result = await channel.send({ type: 'broadcast', event, payload });
      return { sent: result === 'ok' };
    },
    async close() {
      this.drop();
    },
  };
}

function failureKind(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  if (code === 'invalid_credentials' || code === 'email_not_confirmed' || /invalid login credentials/i.test(message)) return 'credentials';
  if (/failed to fetch|network|load failed/i.test(message)) return 'network';
  return 'unknown';
}
