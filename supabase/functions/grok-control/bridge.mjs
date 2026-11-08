/**
 * Owner-token bridge for Grok Control. No Supabase Auth and no Realtime.
 * Tokens are 32 random bytes, hex encoded. Only SHA-256 digests are stored.
 * Command names and the 5 second lifetime match app/grok-control.js.
 */
export const SCHEMA = 1;
export const COMMAND_TTL_MS = 5000;
export const COMMAND_NAMES = Object.freeze([
  'start', 'stop', 'pause', 'changePattern', 'forceCutoff', 'adjustCutoff', 'setDowntime',
]);

export const ACCESS_MS = 15 * 60 * 1000;
export const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
export const ENROLL_MS = 24 * 60 * 60 * 1000;
export const MAX_BODY = 12000;
export const OWNER_ID = 'owner';

const TOKEN = /^[a-f0-9]{64}$/;
const STATE_KEYS = [
  'v', 'type', 'sessionId', 'epoch', 'armed', 'phase', 'sensorFresh', 'pressureKpa',
  'threshold', 'resetThreshold', 'edgeCount', 'pattern', 'outputPercentA', 'outputPercentB',
  'recoveryMin', 'recoveryMax', 'civetConnected', 'opossumConnected', 'link', 'publishedAt', 'leaseMs', 'lastSeq',
];

export async function sha256Hex(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function sameHash(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

export function createMemoryDb(now = () => Date.now()) {
  const rates = new Map();
  let enrollment = null;
  let owner = null;
  const accesses = [];
  let state = null;
  const commands = new Map();
  const events = [];
  const acks = [];
  return {
    async rate(key, limit, windowSec) {
      if (typeof key !== 'string' || key.length < 8 || key.length > 200) return false;
      const bucket = Math.floor(now() / 1000 / Math.max(1, windowSec));
      const mapKey = `${key}:${bucket}`;
      const attempts = (rates.get(mapKey) || 0) + 1;
      rates.set(mapKey, attempts);
      return attempts <= limit;
    },
    async ownerLive() {
      return Boolean(owner?.refreshHash && owner.refreshExpiresAt > now());
    },
    async saveEnrollment(codeHash, expiresAt) {
      enrollment = { codeHash, expiresAt, usedAt: null };
    },
    async loginEnrollment(codeHash, next) {
      if (!enrollment || enrollment.usedAt || enrollment.expiresAt <= now() || !sameHash(enrollment.codeHash, codeHash)) return false;
      enrollment = { ...enrollment, usedAt: now() };
      owner = { refreshHash: next.refreshHash, refreshExpiresAt: next.refreshExpiresAt };
      accesses.length = 0;
      accesses.push({ accessHash: next.accessHash, accessExpiresAt: next.accessExpiresAt });
      return true;
    },
    async loginRefresh(oldHash, next) {
      if (!owner?.refreshHash || owner.refreshExpiresAt <= now() || !sameHash(owner.refreshHash, oldHash)) return false;
      accesses.push({ accessHash: next.accessHash, accessExpiresAt: next.accessExpiresAt });
      return true;
    },
    async accessOk(accessHash) {
      return accesses.some(item => item.accessExpiresAt > now() && sameHash(item.accessHash, accessHash));
    },
    async logout(accessHash) {
      if (!accesses.some(item => item.accessExpiresAt > now() && sameHash(item.accessHash, accessHash))) return false;
      accesses.length = 0;
      owner = { refreshHash: null, refreshExpiresAt: 0 };
      return true;
    },
    async writeState(payload) {
      state = payload;
    },
    async readState() {
      return state;
    },
    async insertCommand(payload) {
      if (commands.has(payload.id)) return false;
      commands.set(payload.id, payload);
      return true;
    },
    async listCommands(nowMs) {
      return [...commands.values()].filter(item => item.expiresAt >= nowMs).slice(-20);
    },
    async insertEvent(payload) {
      events.push(payload);
      if (events.length > 50) events.shift();
    },
    async listEvents() {
      return events.slice(-20);
    },
    async insertAck(payload) {
      const index = acks.findIndex(item => item.commandId === payload.commandId);
      if (index >= 0) acks[index] = payload;
      else acks.push(payload);
      if (acks.length > 50) acks.shift();
    },
    async listAcks() {
      return acks.slice(-20);
    },
  };
}

export async function provisionEnrollment(db, now = Date.now()) {
  if (await db.ownerLive()) {
    const error = new Error('owner session already exists');
    error.code = 'owner-exists';
    throw error;
  }
  const token = randomToken();
  await db.saveEnrollment(await sha256Hex(token), now + ENROLL_MS);
  return token;
}

function failure(status, error, kind) {
  return { status, body: { error, kind } };
}

function cleanState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const next = {};
  for (const key of STATE_KEYS) if (value[key] !== undefined) next[key] = value[key];
  next.v = SCHEMA;
  next.type = 'state';
  return next;
}

function cleanCommand(value, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.v !== SCHEMA || typeof value.id !== 'string' || !value.id || value.id.length > 80) return null;
  if (!Number.isSafeInteger(value.seq) || value.seq < 1) return null;
  if (typeof value.sessionId !== 'string' || value.sessionId.length > 80) return null;
  if (!Number.isSafeInteger(value.epoch) || value.epoch < 0) return null;
  if (!Number.isFinite(value.issuedAt) || !Number.isFinite(value.expiresAt)) return null;
  if (value.expiresAt < value.issuedAt || value.expiresAt - value.issuedAt > COMMAND_TTL_MS) return null;
  if (value.expiresAt < now - 2000 || value.issuedAt > now + 2000) return null;
  if (!COMMAND_NAMES.includes(value.command)) return null;
  const params = value.params && typeof value.params === 'object' && !Array.isArray(value.params) ? value.params : {};
  if (JSON.stringify(params).length > 400) return null;
  return {
    v: SCHEMA,
    id: value.id,
    seq: value.seq,
    sessionId: value.sessionId,
    epoch: value.epoch,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    command: value.command,
    params,
  };
}

async function issue(db, now) {
  const refresh = randomToken();
  const access = randomToken();
  const next = {
    refreshHash: await sha256Hex(refresh),
    refreshExpiresAt: now + REFRESH_MS,
    accessHash: await sha256Hex(access),
    accessExpiresAt: now + ACCESS_MS,
  };
  return { refresh, access, next };
}

export async function handleGrokRequest({ body, accessToken = '', ip = 'unknown', db, now = Date.now() }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return failure(400, 'Invalid request', 'bad');
  const action = body.action;
  const ipHash = (await sha256Hex(ip)).slice(0, 32);
  if (action === 'login') {
    if (!await db.rate(`login:${ipHash}`, 8, 600)) return failure(429, 'Please wait briefly before trying again.', 'rate');
    const enrollment = typeof body.enrollment === 'string' ? body.enrollment.trim().toLowerCase() : '';
    const refresh = typeof body.refresh === 'string' ? body.refresh.trim().toLowerCase() : '';
    if (TOKEN.test(enrollment)) {
      const issued = await issue(db, now);
      if (!await db.loginEnrollment(await sha256Hex(enrollment), issued.next)) return failure(401, 'Sign-in did not complete.', 'credentials');
      return {
        status: 200,
        body: {
          ownerId: OWNER_ID,
          access: issued.access,
          refresh: issued.refresh,
          accessExpiresAt: issued.next.accessExpiresAt,
          refreshExpiresAt: issued.next.refreshExpiresAt,
        },
      };
    }
    if (TOKEN.test(refresh)) {
      const access = randomToken();
      const accessExpiresAt = now + ACCESS_MS;
      const ok = await db.loginRefresh(await sha256Hex(refresh), { accessHash: await sha256Hex(access), accessExpiresAt });
      if (!ok) return failure(401, 'Sign-in did not complete.', 'credentials');
      return { status: 200, body: { ownerId: OWNER_ID, access, refresh, accessExpiresAt, refreshExpiresAt: now + REFRESH_MS } };
    }
    return failure(401, 'Sign-in did not complete.', 'credentials');
  }
  if (!TOKEN.test(accessToken) || !await db.accessOk(await sha256Hex(accessToken))) {
    return failure(401, 'Sign-in did not complete.', 'credentials');
  }
  if (action === 'logout') {
    await db.logout(await sha256Hex(accessToken));
    return { status: 200, body: { ok: true } };
  }
  if (action === 'sync') {
    if (!await db.rate('grok-sync', 90, 60)) return failure(429, 'Please wait briefly before trying again.', 'rate');
    const state = cleanState(body.state);
    if (state) await db.writeState(state);
    for (const item of Array.isArray(body.events) ? body.events.slice(0, 20) : []) {
      if (item && typeof item.id === 'string' && item.id.length <= 80) await db.insertEvent(item);
    }
    for (const item of Array.isArray(body.acks) ? body.acks.slice(0, 20) : []) {
      if (item && typeof item.commandId === 'string') await db.insertAck(item);
    }
    return { status: 200, body: { commands: await db.listCommands(now) } };
  }
  if (action === 'send') {
    if (!await db.rate('grok-send', 30, 60)) return failure(429, 'Please wait briefly before trying again.', 'rate');
    const command = cleanCommand(body.command, now);
    if (!command) return failure(400, 'Invalid request', 'bad');
    const saved = await db.insertCommand(command);
    if (!saved) return failure(409, 'That command was already seen.', 'replay');
    return { status: 200, body: { ok: true } };
  }
  if (action === 'read') {
    if (!await db.rate('grok-read', 90, 60)) return failure(429, 'Please wait briefly before trying again.', 'rate');
    return {
      status: 200,
      body: {
        state: await db.readState(),
        events: await db.listEvents(typeof body.afterEvent === 'string' ? body.afterEvent : ''),
        acks: await db.listAcks(typeof body.afterAck === 'string' ? body.afterAck : ''),
      },
    };
  }
  return failure(400, 'Invalid request', 'bad');
}

export function restHeaders(key, extra = {}) {
  const headers = { apikey: key, 'Content-Type': 'application/json', ...extra };
  // sb_secret keys are not JWTs and are rejected on Authorization. A legacy
  // service_role JWT still selects its database role through that header.
  if (typeof key === 'string' && key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  return headers;
}

export function createRestDb({ url, key, fetchImpl = fetch, now = () => Date.now() }) {
  async function rest(path, { method = 'GET', body, prefer } = {}) {
    const response = await fetchImpl(`${url}/rest/v1/${path}`, {
      method,
      headers: restHeaders(key, prefer ? { Prefer: prefer } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error('Service temporarily unavailable');
    return text ? JSON.parse(text) : null;
  }
  const rpc = (name, args) => rest(`rpc/${name}`, { method: 'POST', body: args });
  return {
    async rate(keyName, limit, windowSec) {
      return rpc('grok_rate', { p_key: keyName, p_limit: limit, p_window: windowSec });
    },
    async ownerLive() {
      const rows = await rest('grok_session?id=eq.1&select=refresh_expires_at');
      return Boolean(rows?.[0]?.refresh_expires_at && Date.parse(rows[0].refresh_expires_at) > now());
    },
    async saveEnrollment() {
      throw new Error('Enrollment is provisioned by privileged SQL.');
    },
    async loginEnrollment(codeHash, next) {
      return rpc('grok_login_enrollment', {
        p_code_hash: codeHash,
        p_refresh_hash: next.refreshHash,
        p_refresh_expires: new Date(next.refreshExpiresAt).toISOString(),
        p_access_hash: next.accessHash,
        p_access_expires: new Date(next.accessExpiresAt).toISOString(),
      });
    },
    async loginRefresh(oldHash, next) {
      return rpc('grok_login_refresh', {
        p_refresh_hash: oldHash,
        p_access_hash: next.accessHash,
        p_access_expires: new Date(next.accessExpiresAt).toISOString(),
      });
    },
    async accessOk(accessHash) {
      return rpc('grok_access_ok', { p_access_hash: accessHash });
    },
    async logout(accessHash) {
      return rpc('grok_logout', { p_access_hash: accessHash });
    },
    async writeState(payload) {
      await rest('grok_state?id=eq.1', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: { id: 1, payload, published_at: new Date(now()).toISOString() },
      });
    },
    async readState() {
      const rows = await rest('grok_state?id=eq.1&select=payload');
      return rows?.[0]?.payload || null;
    },
    async insertCommand(payload) {
      const response = await fetchImpl(`${url}/rest/v1/grok_command`, {
        method: 'POST',
        headers: restHeaders(key, { Prefer: 'return=minimal' }),
        body: JSON.stringify({ id: payload.id, payload }),
      });
      if (response.status === 409) return false;
      if (!response.ok) throw new Error('Service temporarily unavailable');
      return true;
    },
    async listCommands(nowMs) {
      const rows = await rest('grok_command?select=payload&order=created_at.desc&limit=20');
      return (rows || []).map(row => row.payload).filter(item => item?.expiresAt >= nowMs);
    },
    async insertEvent(payload) {
      await rest('grok_event', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { id: payload.id, payload } });
    },
    async listEvents() {
      const rows = await rest('grok_event?select=payload&order=created_at.desc&limit=20');
      return (rows || []).map(row => row.payload);
    },
    async insertAck(payload) {
      await rest('grok_ack', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: { command_id: payload.commandId, payload },
      });
    },
    async listAcks() {
      const rows = await rest('grok_ack?select=payload&order=created_at.desc&limit=20');
      return (rows || []).map(row => row.payload);
    },
  };
}
