import { API_URL, PUBLISHABLE_KEY } from './config.js';

export class Backend {
  constructor() { this.ownerToken = null; this.guestToken = null; this.clockOffset = 0; }
  async call(action, payload = {}, role = 'owner') {
    const start = Date.now();
    const token = role === 'guest' ? this.guestToken : this.ownerToken;
    const response = await fetch(API_URL, {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', apikey: PUBLISHABLE_KEY, ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify({ action, ...payload }), signal: AbortSignal.timeout(6500),
    });
    let result;
    try { result = await response.json(); } catch { throw new Error('Backend unavailable; check your connection'); }
    if (!response.ok) { const error = new Error(result.error || 'Request failed'); error.status = response.status; throw error; }
    if (Number.isFinite(result.serverNow)) this.clockOffset = result.serverNow - (start + Date.now()) / 2;
    return result;
  }
  async unlock(password) {
    const result = await this.call('owner-login', { password });
    this.ownerToken = result.token;
    return result;
  }
  async lock() { try { if (this.ownerToken) await this.call('owner-logout'); } finally { this.ownerToken = null; } }
  async join(code, clientId) {
    const result = await this.call('guest-join', { code, clientId }, 'guest');
    this.guestToken = result.token;
    return result;
  }
}
