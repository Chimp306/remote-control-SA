/**
 * Owner JWT transport for Grok Control. The service role is refused.
 * Broadcasts are not stored. private:true still needs the realtime.messages policies.
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm';
import { API_URL, PUBLISHABLE_KEY } from './config.js?v=20261108-v215';
import { jwtRole, topicForUser } from './grok-control.js?v=20261108-v215';

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
  let channel = null;
  let userId = null;

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
      if (error) throw error;
      userId = requireUser(data.session);
      return userId;
    },
    async signOut() {
      userId = null;
      await this.close();
      try { await client.auth.signOut(); } catch { /* the page already disarmed */ }
    },
    async open(onCommand) {
      const { data } = await client.auth.getSession();
      userId = requireUser(data.session);
      await this.close();
      const topic = topicForUser(userId);
      const next = client.channel(topic, { config: { private: true, broadcast: { self: false } } });
      next.on('broadcast', { event: 'command' }, ({ payload }) => onCommand(payload));
      channel = next;
      await new Promise((resolve, reject) => {
        next.subscribe(status => {
          if (status === 'SUBSCRIBED') resolve();
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error(status));
        });
      });
      return topic;
    },
    async publish(event, payload) {
      if (!channel) return { sent: false };
      const result = await channel.send({ type: 'broadcast', event, payload });
      return { sent: result === 'ok' };
    },
    async close() {
      if (!channel) return;
      const current = channel;
      channel = null;
      await client.removeChannel(current);
    },
  };
}
