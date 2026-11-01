import { hash, isToken, isClient, isCode, normalizeCode, randomToken, randomCode, verifyPassword, sanitizeState, sanitizeCommand, publicSession } from './core.js';

const API = Deno.env.get('SUPABASE_URL');
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const CORS_ORIGINS = new Set(['https://ctmp.uk', 'https://www.ctmp.uk', 'https://chimp306.github.io']);

class HttpError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

async function database(path, method = 'GET', body = undefined) {
  const response = await fetch(API + '/rest/v1/' + path, {
    method,
    headers: { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) { await response.text(); throw new HttpError('Service temporarily unavailable', 503); }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
const rpc = (name, args) => database('rpc/' + name, 'POST', args);
const one = async (table, filter) => (await database(table + '?' + filter + '&limit=1'))?.[0] || null;
const settings = () => one('ctmp_v2_settings', 'id=eq.true');
const activeSession = (id) => {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new HttpError('Invalid session');
  return one('ctmp_v2_sessions', 'id=eq.' + id + '&active=eq.true');
};
async function rate(key, limit, seconds = 60) {
  if (!(await rpc('ctmp_v2_rate', { p_key: key, p_limit: limit, p_window: seconds }))) throw new HttpError('Please wait briefly before trying again', 429);
}
async function owner(tokenHash) {
  const record = await one('ctmp_v2_owner_tokens', 'token_hash=eq.' + tokenHash + '&expires_at=gt.' + encodeURIComponent(new Date().toISOString()));
  if (!record) throw new HttpError('Unlock Debugging again', 401);
}
async function guest(tokenHash, sessionId) {
  const row = await activeSession(sessionId);
  if (!row || row.guest_hash !== tokenHash) throw new HttpError('This session has ended or is open in another tab', 401);
  return row;
}

export async function handler(request) {
  const origin = request.headers.get('origin') || '';
  const originAllowed = CORS_ORIGINS.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
  const headers = {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'authorization,apikey,content-type',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    ...(originAllowed ? { 'Access-Control-Allow-Origin': origin } : {}),
  };
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (origin && !originAllowed) return reply({ error: 'Origin not allowed' }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return reply({ error: 'POST required' }, 405);
  try {
    if (!API || !SERVICE) throw new HttpError('Backend configuration missing', 503);
    if (Number(request.headers.get('content-length')) > 12000) throw new HttpError('Request too large', 413);
    const text = await request.text();
    if (text.length > 12000) throw new HttpError('Request too large', 413);
    let body;
    try { body = JSON.parse(text); } catch { throw new HttpError('Invalid request'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError('Invalid request');
    const ip = (request.headers.get('x-forwarded-for') || request.headers.get('cf-connecting-ip') || 'unknown').split(',')[0].trim();
    const ipHash = await hash(ip);
    if (body.action === 'owner-login') {
      await rate('login-global', 15);
      await rate('login-ip:' + ipHash, 5);
      const config = await settings();
      if (!await verifyPassword(body.password, config)) throw new HttpError('Password not recognised', 401);
      const token = randomToken();
      await database('ctmp_v2_owner_tokens', 'POST', { token_hash: await hash(token), expires_at: new Date(Date.now() + 86400000).toISOString() });
      return reply({ token, best: config.best, serverNow: Date.now() });
    }
    if (body.action === 'guest-join') {
      await rate('join-global', 30);
      await rate('join-ip:' + ipHash, 10);
      if (!isCode(body.code) || !isClient(body.clientId)) throw new HttpError('Link unavailable', 404);
      const token = randomToken();
      const row = await rpc('ctmp_v2_join', { p_code: await hash(normalizeCode(body.code)), p_client: await hash(body.clientId), p_guest: await hash(token) });
      if (!row?.id) throw new HttpError('Link unavailable or already in use', 404);
      const config = await settings();
      return reply({ token, ...publicSession(row, config?.best || 0) });
    }
    const token = request.headers.get('authorization')?.replace(/^Bearer /i, '') || '';
    if (!isToken(token)) throw new HttpError('Authentication required', 401);
    const tokenHash = await hash(token);
    if (body.action === 'guest-poll' || body.action === 'guest-command') {
      await rate('guest:' + tokenHash, 600);
      const row = await guest(tokenHash, body.sessionId);
      if (body.action === 'guest-command') {
        let command;
        try { command = sanitizeCommand(body.command, row.toy); } catch (e) { throw new HttpError(e.message); }
        const sequence = await rpc('ctmp_v2_command', { p_session: row.id, p_guest: tokenHash, p_command: command });
        if (sequence < 0) throw new HttpError(sequence === -4 ? 'Control already superseded' : 'Controls are paused; wait for the host', 409);
        return reply({ accepted: true, commandSeq: sequence, serverNow: Date.now() });
      }
      await database('ctmp_v2_sessions?id=eq.' + row.id + '&active=eq.true&guest_hash=eq.' + tokenHash, 'PATCH', { guest_seen_at: new Date().toISOString() });
      return reply(publicSession(row, (await settings())?.best || 0));
    }
    await owner(tokenHash);
    await rate('owner:' + tokenHash, 360);
    if (body.action === 'owner-status') {
      const config = await settings();
      const session = await one('ctmp_v2_sessions', 'active=eq.true');
      return reply({ best: config?.best || 0, activeSessionId: session?.id || null, serverNow: Date.now() });
    }
    if (body.action === 'owner-logout') {
      await database('ctmp_v2_sessions?owner_hash=eq.' + tokenHash + '&active=eq.true', 'PATCH', { active: false, ended_at: new Date().toISOString(), state: {}, command: null, guest_hash: null, guest_client_hash: null });
      await database('ctmp_v2_owner_tokens?token_hash=eq.' + tokenHash, 'PATCH', { expires_at: new Date().toISOString() });
      return reply({ ok: true });
    }
    if (body.action === 'best-save') {
      if (body.simulation !== false || !Number.isSafeInteger(body.count) || body.count < 0 || body.count > 1000000) throw new HttpError('Invalid score');
      const active = await one('ctmp_v2_sessions', 'active=eq.true');
      if (active?.simulation) throw new HttpError('Test sessions cannot change the personal best', 409);
      return reply({ best: await rpc('ctmp_v2_best', { p_count: body.count }) });
    }
    if (body.action === 'session-create') {
      if (!['lush', 'opossum', 'vacuglide'].includes(body.toy) || typeof body.simulation !== 'boolean') throw new HttpError('Invalid session settings');
      const code = randomCode();
      const row = await rpc('ctmp_v2_create_session', { p_owner: tokenHash, p_code: await hash(code), p_toy: body.toy, p_simulation: body.simulation });
      return reply({ sessionId: row.id, code, serverNow: Date.now() });
    }
    if (body.action === 'session-end') {
      // This installation has one owner. A newly unlocked owner can also end a
      // session created before a refresh or token expiry; no orphaned links.
      await database('ctmp_v2_sessions?active=eq.true', 'PATCH', { active: false, ended_at: new Date().toISOString(), state: {}, command: null, guest_hash: null, guest_client_hash: null });
      return reply({ ok: true });
    }
    if (body.action === 'host-sync') {
      const row = await activeSession(body.sessionId);
      if (!row || row.owner_hash !== tokenHash) throw new HttpError('Session ended or replaced', 409);
      const state = sanitizeState(body.state, row.toy, row.simulation);
      const updated = await database('ctmp_v2_sessions?id=eq.' + row.id + '&active=eq.true&owner_hash=eq.' + tokenHash, 'PATCH', { state, state_at: new Date().toISOString() });
      if (!updated?.length) throw new HttpError('Session ended', 409);
      const best = row.simulation ? 0 : await rpc('ctmp_v2_best', { p_count: state.edgeCount });
      return reply({ best, command: row.command, commandSeq: row.command_seq, guestConnected: !!row.guest_seen_at && Date.now() - Date.parse(row.guest_seen_at) < 5000, serverNow: Date.now() });
    }
    throw new HttpError('Unknown action', 404);
  } catch (error) {
    return reply({ error: error instanceof HttpError ? error.message : 'Service temporarily unavailable' }, error instanceof HttpError ? error.status : 503);
  }
}

Deno.serve(handler);
