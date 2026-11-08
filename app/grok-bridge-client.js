/**
 * Browser and Node client for the grok-control function.
 * The refresh token stays in the caller-supplied store. The access token stays in memory.
 */
const REFRESH_KEY = 'ctmp-grok-refresh-v1';

export function browserRefreshStore() {
  return {
    get() {
      try { return localStorage.getItem(REFRESH_KEY) || ''; } catch { return ''; }
    },
    set(value) {
      try { localStorage.setItem(REFRESH_KEY, value); } catch { /* private mode */ }
    },
    clear() {
      try { localStorage.removeItem(REFRESH_KEY); } catch { /* private mode */ }
    },
  };
}

export function createGrokBridgeClient({ url, publishableKey = '', fetchImpl = fetch, store, now = () => Date.now() }) {
  let access = '';
  let accessExpiresAt = 0;
  const seenEvents = new Set();
  const seenAcks = new Set();
  async function post(body, withAccess) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(publishableKey ? { apikey: publishableKey } : {}),
          ...(withAccess && access ? { 'x-grok-access': access } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch {
      const error = new Error('Sign-in could not reach the account service.');
      error.kind = 'network';
      throw error;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(response.status === 429 ? 'Please wait briefly before trying again.' : 'Sign-in did not complete.');
      error.kind = payload?.kind || (response.status === 429 ? 'rate' : 'credentials');
      throw error;
    }
    return payload;
  }
  async function login(body) {
    const result = await post(body, false);
    if (typeof result.refresh !== 'string' || typeof result.access !== 'string') {
      const error = new Error('Sign-in did not complete.');
      error.kind = 'credentials';
      throw error;
    }
    access = result.access;
    accessExpiresAt = result.accessExpiresAt;
    store?.set?.(result.refresh);
    return result;
  }
  return {
    hasRefresh() { return Boolean(store?.get?.()); },
    async loginEnrollment(enrollment) { return login({ action: 'login', enrollment }); },
    async loginRefresh() {
      const refresh = store?.get?.() || '';
      if (!refresh) {
        const error = new Error('Sign-in did not complete.');
        error.kind = 'credentials';
        throw error;
      }
      return login({ action: 'login', refresh });
    },
    async ensureAccess() {
      if (access && accessExpiresAt - now() > 30_000) return access;
      await this.loginRefresh();
      return access;
    },
    async logout() {
      try { if (access) await post({ action: 'logout' }, true); } catch { /* local sign-out still proceeds */ }
      access = '';
      accessExpiresAt = 0;
      store?.clear?.();
    },
    async sync({ state = null, events = [], acks = [] } = {}) {
      await this.ensureAccess();
      return post({ action: 'sync', state, events, acks }, true);
    },
    async send(command) {
      await this.ensureAccess();
      return post({ action: 'send', command }, true);
    },
    async read() {
      await this.ensureAccess();
      const result = await post({ action: 'read' }, true);
      const events = (result.events || []).filter(item => item?.id && !seenEvents.has(item.id));
      const acks = (result.acks || []).filter(item => item?.commandId && !seenAcks.has(item.commandId));
      for (const item of events) seenEvents.add(item.id);
      for (const item of acks) seenAcks.add(item.commandId);
      return { ...result, events, acks };
    },
  };
}
