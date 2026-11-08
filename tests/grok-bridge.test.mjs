import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { COMMAND_NAMES, COMMAND_TTL_MS, SCHEMA } from '../app/grok-control.js';
import { createGrokAdapter, createFunctionTransport } from '../scripts/grok-adapter.mjs';
import { startGrokTestServer } from '../scripts/grok-test-server.mjs';
import {
  COMMAND_NAMES as BRIDGE_COMMANDS,
  COMMAND_TTL_MS as BRIDGE_TTL,
  SCHEMA as BRIDGE_SCHEMA,
  createMemoryDb,
  createRestDb,
  handleGrokRequest,
  provisionEnrollment,
  sha256Hex,
} from '../supabase/functions/grok-control/bridge.mjs';

const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');

test('short rate keys are rejected and a normal sync is not', async () => {
  const db = createMemoryDb();
  assert.equal(await db.rate('sync', 90, 60), false);
  assert.equal(await db.rate('grok-sync', 90, 60), true);
  const code = await provisionEnrollment(db);
  const login = await handleGrokRequest({ body: { action: 'login', enrollment: code }, db, ip: 'rate' });
  const synced = await handleGrokRequest({
    body: { action: 'sync', state: { v: 1, type: 'state', sessionId: 's', epoch: 1, armed: true, phase: 'idle' } },
    accessToken: login.body.access,
    db,
  });
  assert.equal(synced.status, 200);
  assert.notEqual(synced.body.kind, 'rate');
});

test('a confirmed 401 signs the link out and a network failure does not', async () => {
  const store = new Map();
  const originalFetch = globalThis.fetch;
  globalThis.localStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
  };
  let mode = 'ok';
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.action === 'login') {
      return new Response(JSON.stringify({
        ownerId: 'owner', access: 'ab'.repeat(32), refresh: 'cd'.repeat(32),
        accessExpiresAt: Date.now() + 60_000, refreshExpiresAt: Date.now() + 3_600_000,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (mode === 'auth') {
      return new Response(JSON.stringify({ error: 'Sign-in did not complete.', kind: 'credentials' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    if (mode === 'down') throw new Error('offline');
    return new Response(JSON.stringify({ commands: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const source = read('../app/grok-link.js').replace(/\?v=[^'"]+/g, '');
  const entry = new URL('../app/grok-link.runtime.mjs', import.meta.url);
  fs.writeFileSync(entry, source);
  try {
    const { createGrokLink } = await import(entry.href);
    const events = [];
    const rejected = createGrokLink();
    rejected.onAuth(event => events.push(event));
    await rejected.signIn('a'.repeat(64));
    await new Promise(resolve => setTimeout(resolve, 0));
    mode = 'auth';
    const opened = await rejected.open(() => {}, 'owner');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(events.includes('SIGNED_OUT'), true);
    const stale = await rejected.publish('state', { v: 1 }, { generation: opened.generation, userId: opened.userId });
    assert.equal(stale.sent, false);
    mode = 'down';
    const kept = [];
    const offline = createGrokLink();
    offline.onAuth(event => kept.push(event));
    await offline.signIn('b'.repeat(64));
    await new Promise(resolve => setTimeout(resolve, 0));
    const live = await offline.open(() => {}, 'owner');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(kept.includes('SIGNED_OUT'), false);
    const still = await offline.publish('state', { v: 1 }, { generation: live.generation, userId: live.userId });
    assert.equal(still.sent, true);
    offline.drop();
  } finally {
    globalThis.fetch = originalFetch;
    fs.unlinkSync(entry);
  }
});

test('enrollment is one-time, a stranger cannot read, and a command replay is rejected', async () => {
  const db = createMemoryDb();
  const code = await provisionEnrollment(db);
  assert.equal(code.length, 64);
  assert.equal(await sha256Hex('abc'), createHash('sha256').update('abc').digest('hex'));
  const first = await handleGrokRequest({ body: { action: 'login', enrollment: code }, db, ip: 'a' });
  assert.equal(first.status, 200);
  assert.equal(first.body.ownerId, 'owner');
  const replay = await handleGrokRequest({ body: { action: 'login', enrollment: code }, db, ip: 'a' });
  assert.equal(replay.status, 401);
  assert.equal(JSON.stringify(replay.body).includes(code), false);
  await assert.rejects(() => provisionEnrollment(db), /owner session already exists/);
  const state = { v: 1, type: 'state', sessionId: 'session-private', epoch: 4, armed: true, phase: 'idle', sensorFresh: true };
  const published = await handleGrokRequest({
    body: { action: 'sync', state },
    accessToken: first.body.access,
    db,
  });
  assert.equal(published.status, 200);
  const stranger = await handleGrokRequest({
    body: { action: 'read' },
    accessToken: 'ab'.repeat(32),
    db,
    ip: 'b',
  });
  assert.equal(stranger.status, 401);
  assert.equal(JSON.stringify(stranger.body).includes('session-private'), false);
  const seen = await handleGrokRequest({ body: { action: 'read' }, accessToken: first.body.access, db });
  assert.equal(seen.body.state.sessionId, 'session-private');
  const command = {
    v: 1, id: 'cmd-1', seq: 1, sessionId: 'session-private', epoch: 4,
    issuedAt: 5_000, expiresAt: 10_000, command: 'stop', params: {},
  };
  const sent = await handleGrokRequest({ body: { action: 'send', command }, accessToken: first.body.access, db, now: 5_000 });
  assert.equal(sent.status, 200);
  const duplicate = await handleGrokRequest({ body: { action: 'send', command }, accessToken: first.body.access, db, now: 5_000 });
  assert.equal(duplicate.status, 409);
  const expired = { ...command, id: 'cmd-old', issuedAt: 1_000, expiresAt: 6_000 };
  const rejected = await handleGrokRequest({ body: { action: 'send', command: expired }, accessToken: first.body.access, db, now: 9_000 });
  assert.equal(rejected.status, 400);
  const second = await handleGrokRequest({ body: { action: 'login', refresh: first.body.refresh }, db, ip: 'a' });
  assert.equal(second.status, 200);
  const stillThere = await handleGrokRequest({ body: { action: 'read' }, accessToken: first.body.access, db });
  assert.equal(stillThere.body.state.sessionId, 'session-private');
  const strangerRefresh = await handleGrokRequest({ body: { action: 'login', refresh: '11'.repeat(32) }, db, ip: 'a' });
  assert.equal(strangerRefresh.status, 401);
});

test('the function transport round-trips state and a stop without a service key', async () => {
  const started = await startGrokTestServer();
  const login = await fetch(started.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'login', enrollment: started.enrollment }),
  }).then(response => response.json());
  await fetch(started.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-grok-access': login.access },
    body: JSON.stringify({
      action: 'sync',
      state: { v: 1, type: 'state', sessionId: 'session-live', epoch: 2, armed: true, phase: 'running', sensorFresh: true },
    }),
  });
  const clock = Date.now();
  const transport = createFunctionTransport({ url: started.url, refreshToken: login.refresh, pollMs: 40 });
  const adapter = createGrokAdapter({ transport, now: () => clock });
  try {
    await adapter.attach();
    assert.equal(adapter.latest().sessionId, 'session-live');
    assert.equal(adapter.latest().armed, true);
    const sent = await adapter.command('stop');
    assert.equal(sent.envelope.sessionId, 'session-live');
    assert.equal(sent.envelope.epoch, 2);
    assert.equal(sent.envelope.expiresAt - sent.envelope.issuedAt, 5000);
    const queued = await started.db.listCommands(clock);
    assert.equal(queued.some(item => item.command === 'stop' && item.sessionId === 'session-live'), true);
    const hidden = await fetch(started.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-grok-access': 'cd'.repeat(32) },
      body: JSON.stringify({ action: 'read' }),
    });
    const hiddenBody = await hidden.text();
    assert.equal(hidden.status, 401);
    assert.equal(hiddenBody.includes('session-live'), false);
    assert.equal(hiddenBody.includes(login.refresh), false);
  } finally {
    transport.close();
    started.server.closeAllConnections?.();
    await new Promise(resolve => started.server.close(resolve));
  }
});

test('the real client process sends a command through the local bridge', async () => {
  const started = await startGrokTestServer();
  const login = await fetch(started.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'login', enrollment: started.enrollment }),
  }).then(response => response.json());
  await fetch(started.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-grok-access': login.access },
    body: JSON.stringify({
      action: 'sync',
      state: { v: 1, type: 'state', sessionId: 'session-proc', epoch: 7, armed: true, phase: 'idle', sensorFresh: true },
    }),
  });
  const child = spawn(process.execPath, ['scripts/grok-control-client.mjs'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, GROK_FUNCTION_URL: started.url, GROK_REFRESH_TOKEN: login.refresh, GROK_PUBLISHABLE_KEY: 'sb_publishable_public' },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  const startedAt = Date.now();
  while (!out.includes('"type":"state"') && Date.now() - startedAt < 4000) {
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.match(out, /session-proc/);
  child.stdin.write('{"command":"pause"}\n');
  const sendStarted = Date.now();
  while (!out.includes('"command":"pause"') && Date.now() - sendStarted < 3000) {
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.match(out, /"type":"send"/);
  assert.equal(out.includes(login.refresh), false);
  assert.equal(err.includes(login.refresh), false);
  child.kill('SIGKILL');
  started.server.closeAllConnections?.();
  await new Promise(resolve => started.server.close(resolve));
});

test('database calls send the secret on apikey only, and the SQL stays private', async () => {
  const calls = [];
  const db = createRestDb({
    url: 'https://kmswwrfglbdbwoapusfw.supabase.co',
    key: 'server-side-key',
    fetchImpl: async (url, options) => {
      calls.push({ url, headers: options.headers, body: options.body });
      return { ok: true, status: 200, text: async () => 'true' };
    },
  });
  assert.equal(await db.rate('login:abcdef1234567890', 8, 600), true);
  assert.equal(calls[0].headers.apikey, 'server-side-key');
  assert.equal(calls[0].headers.Authorization, undefined);
  const legacy = [];
  const legacyDb = createRestDb({
    url: 'https://kmswwrfglbdbwoapusfw.supabase.co',
    key: 'eyJlegacy.service.role',
    fetchImpl: async (url, options) => {
      legacy.push(options.headers);
      return { ok: true, status: 200, text: async () => 'true' };
    },
  });
  await legacyDb.rate('grok-sync', 90, 60);
  assert.equal(legacy[0].apikey, 'eyJlegacy.service.role');
  assert.equal(legacy[0].Authorization, 'Bearer eyJlegacy.service.role');
  assert.equal(calls[0].url.includes('/rest/v1/rpc/grok_rate'), true);
  const sql = read('../supabase/migrations/20261108234500_grok_bridge.sql');
  const executable = sql.replace(/--.*$/gm, '');
  assert.match(sql, /grok_provision_enrollment/);
  assert.match(executable, /extensions\.digest\(token, 'sha256'\)/);
  assert.match(executable, /revoke all on function/);
  assert.match(executable, /from public, anon, authenticated/);
  assert.equal(executable.includes('freq_entries'), false);
  assert.equal(executable.includes('ctmp_v2'), false);
  assert.equal(executable.includes('realtime'), false);
  assert.equal(sql.includes('sb_secret_'), false);
  assert.equal(sql.includes('sb_publishable_'), false);
  assert.equal(/\b[a-f0-9]{64}\b/.test(sql), false);
  const source = read('../supabase/functions/grok-control/index.ts');
  assert.match(source, /SUPABASE_SECRET_KEYS/);
  assert.match(source, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.equal(source.includes('sb_secret_'), false);
  const config = read('../supabase/config.toml');
  assert.match(config, /\[functions\.grok-control\][\s\S]*verify_jwt = false/);
  assert.deepEqual(BRIDGE_COMMANDS, COMMAND_NAMES);
  assert.equal(BRIDGE_TTL, COMMAND_TTL_MS);
  assert.equal(BRIDGE_SCHEMA, SCHEMA);
});
