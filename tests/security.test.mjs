import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { SessionEngine } from '../app/engine.js';
import { runDiagnostics } from '../app/diagnostics.js';
import {
  PATTERNS, PHASES, isToken, isClient, isCode, normalizeCode,
  sanitizeState, sanitizeCommand, hash, randomToken, randomCode,
  verifyPassword, publicSession,
} from '../supabase/functions/ctmp-control/core.js';

const validCommand = (overrides = {}) => ({
  percent: 50, pattern: 'steady', cooldownSeconds: 20, epoch: 3,
  clientSeq: 1, ...overrides,
});

test('opaque owner/guest tokens and browser client IDs have strict formats', () => {
  assert.equal(isToken('a'.repeat(64)), true);
  assert.equal(isClient('b'.repeat(32)), true);
  for (const value of [null, undefined, {}, [], 42, '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), ` ${'a'.repeat(64)}`]) {
    assert.equal(isToken(value), false);
  }
  for (const value of [null, {}, '', 'b'.repeat(31), 'b'.repeat(33), 'B'.repeat(32), 'z'.repeat(32)]) {
    assert.equal(isClient(value), false);
  }
});

test('short links normalize case but accept only six unambiguous letters', () => {
  assert.equal(normalizeCode('  abcdef  '), 'ABCDEF');
  assert.equal(isCode('  abcdef  '), true);
  for (const value of [null, {}, 123456, '', 'ABCDE', 'ABCDEFG', 'ABC1EF', 'ABC0EF', 'ABCIEF', 'ABCOEF', 'AB-CDE', 'ABC/EF']) {
    assert.equal(isCode(value), false);
  }
});

test('crypto-generated capabilities and links obey their validated formats', () => {
  assert.equal(isToken(randomToken()), true);
  assert.equal(isClient(randomToken(16)), true);
  for (let i = 0; i < 200; i++) assert.equal(isCode(randomCode()), true);
});

test('SHA-256 capability lookup digest matches a known vector', async () => {
  assert.equal(await hash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('public telemetry is an explicit projection, never the source object', () => {
  const input = {
    phase: 'running', pressure: 12.34, threshold: 15, resetThreshold: 13,
    edgeCount: 8, newRecord: true, outputPercent: 80, guestPercent: 80, pattern: 'pulse',
    cooldownSeconds: 18, cooldownEndsAt: 1234, remainingCooldown: 4,
    epoch: 7, reason: 'Ready', ownerToken: 'private', guestToken: 'private',
    password_hash: 'private', deviceToken: 'private', hostId: 'private',
    simulation: true, toy: 'vacuglide', mode: 'solo',
  };
  const state = sanitizeState(input, 'lush', false);
  assert.deepEqual(Object.keys(state).sort(), [
    'phase', 'toy', 'mode', 'simulation', 'pressure', 'threshold',
    'resetThreshold', 'edgeCount', 'newRecord', 'outputPercent', 'guestPercent',
    'outputPercentA', 'outputPercentB', 'guestPercentA', 'guestPercentB',
    'maxPercentA', 'maxPercentB',
    'pattern', 'cooldownSeconds', 'cooldownEndsAt', 'remainingCooldown',
    'epoch', 'reason',
  ].sort());
  assert.equal(state.toy, 'lush');
  assert.equal(state.mode, 'guest');
  assert.equal(state.simulation, false);
  assert.equal(state.pattern, 'pulse');
  assert.equal(state.pressure, 12.34);
  assert.equal(state.newRecord, true);
  assert.equal(JSON.stringify(state).includes('private'), false);
  assert.equal(input.toy, 'vacuglide');
});

test('record announcements accept only a strict host-provided boolean', () => {
  assert.equal(sanitizeState({ newRecord: true }, 'lush').newRecord, true);
  for (const value of [false, undefined, null, 0, 1, 'true', 'false', {}, []]) {
    assert.equal(sanitizeState({ newRecord: value }, 'lush').newRecord, false);
  }
});

test('all non-running phases report zero commanded output', () => {
  for (const phase of PHASES.filter((value) => value !== 'running')) {
    assert.equal(sanitizeState({ phase, outputPercent: 100 }, 'lush').outputPercent, 0);
    const dual = sanitizeState({ phase, outputPercent: 100, outputPercentA: 70, outputPercentB: 90, guestPercentA: 70, guestPercentB: 90 }, 'opossum');
    assert.equal(dual.outputPercent, 0, phase);
    assert.equal(dual.outputPercentA, 0, phase);
    assert.equal(dual.outputPercentB, 0, phase);
    assert.equal(dual.guestPercentA, 70, 'selected controls remain visible while output is paused');
    assert.equal(dual.guestPercentB, 90);
  }
  assert.equal(sanitizeState({ phase: 'made-up', outputPercent: 100 }, 'lush').phase, 'paused');
  assert.equal(sanitizeState({ phase: 'made-up', outputPercent: 100 }, 'lush').outputPercent, 0);
});

test('malformed telemetry fails closed and does not coerce strings', () => {
  for (const value of [null, undefined, [], 'running', 100]) {
    const state = sanitizeState(value, 'lush');
    assert.equal(state.phase, 'paused');
    assert.equal(state.outputPercent, 0);
    assert.equal(state.pressure, null);
    assert.equal(state.edgeCount, 0);
  }
  const state = sanitizeState({
    phase: 'running', outputPercent: '100', pressure: '15', threshold: Infinity,
    resetThreshold: NaN, edgeCount: '999', epoch: '9', reason: {},
    cooldownSeconds: '10', remainingCooldown: Infinity,
  }, 'lush');
  assert.equal(state.outputPercent, 0);
  assert.equal(state.pressure, null);
  assert.equal(state.threshold, null);
  assert.equal(state.resetThreshold, null);
  assert.equal(state.edgeCount, 0);
  assert.equal(state.epoch, 0);
  assert.equal(state.reason, '');
  assert.equal(state.cooldownSeconds, 20);
  assert.equal(state.remainingCooldown, 0);
});

test('host telemetry clamps display ranges and enforces the selected toy pattern', () => {
  const state = sanitizeState({
    phase: 'running', outputPercent: 999, guestPercent: -5, pressure: 999,
    threshold: 999, resetThreshold: -999, edgeCount: 3.9,
    cooldownSeconds: 999, remainingCooldown: 999, reason: 'x'.repeat(200),
    pattern: 'wave', epoch: Number.MAX_SAFE_INTEGER + 1,
  }, 'vacuglide');
  assert.equal(state.outputPercent, 100);
  assert.equal(state.guestPercent, 0);
  assert.equal(state.pressure, 100);
  assert.equal(state.threshold, 59.9);
  assert.equal(state.resetThreshold, -100);
  assert.equal(state.edgeCount, 3);
  assert.equal(state.cooldownSeconds, 30);
  assert.equal(state.remainingCooldown, 30);
  assert.equal(state.reason.length, 120);
  assert.equal(state.pattern, 'steady');
  assert.equal(state.epoch, 0);
});

test('Opossum telemetry aggregates independent channels without trusting scalar claims', () => {
  const state = sanitizeState({
    phase: 'running', outputPercent: 0, outputPercentA: 35, outputPercentB: 80,
    guestPercent: 0, guestPercentA: 25, guestPercentB: 95,
    maxPercentA: 70, maxPercentB: 100,
  }, 'opossum');
  assert.equal(state.outputPercent, 80);
  assert.equal(state.guestPercent, 95);
  assert.equal(state.outputPercentA, 35);
  assert.equal(state.outputPercentB, 80);
  assert.equal(state.guestPercentA, 25);
  assert.equal(state.guestPercentB, 95);
  assert.equal(state.maxPercentA, 70);
  assert.equal(state.maxPercentB, 100);
  for (const toy of ['lush', 'vacuglide']) {
    const single = sanitizeState({ ...state, outputPercent: 55, guestPercent: 65 }, toy);
    assert.equal(single.outputPercent, 55);
    assert.equal(single.guestPercent, 65);
    for (const field of ['outputPercentA', 'outputPercentB', 'guestPercentA', 'guestPercentB', 'maxPercentA', 'maxPercentB']) {
      assert.equal(single[field], 0, `${toy}: ${field}`);
    }
  }
});

test('legacy Opossum telemetry is A-only and malformed explicit channels fail closed', () => {
  const legacy = sanitizeState({ phase: 'running', outputPercent: 65, guestPercent: 75 }, 'opossum');
  assert.equal(legacy.outputPercentA, 65);
  assert.equal(legacy.outputPercentB, 0);
  assert.equal(legacy.guestPercentA, 75);
  assert.equal(legacy.guestPercentB, 0);
  assert.equal(legacy.maxPercentA, 100);
  assert.equal(legacy.maxPercentB, 100);
  for (const value of [null, '100', true, [], {}, NaN, Infinity, -Infinity]) {
    const state = sanitizeState({
      phase: 'running', outputPercent: 100, guestPercent: 100,
      outputPercentA: value, outputPercentB: value,
      guestPercentA: value, guestPercentB: value,
    }, 'opossum');
    for (const field of ['outputPercent', 'outputPercentA', 'outputPercentB', 'guestPercent', 'guestPercentA', 'guestPercentB']) {
      assert.equal(state[field], 0, `${field} must not fall back to an unrelated scalar`);
    }
  }
  const bounded = sanitizeState({ phase: 'running', outputPercentA: -1, outputPercentB: 101, guestPercentA: 1000, guestPercentB: -2, maxPercentA: -4, maxPercentB: 101 }, 'opossum');
  assert.equal(bounded.outputPercentA, 0);
  assert.equal(bounded.outputPercentB, 100);
  assert.equal(bounded.guestPercentA, 100);
  assert.equal(bounded.guestPercentB, 0);
  assert.equal(bounded.maxPercentA, 0);
  assert.equal(bounded.maxPercentB, 100);
});

test('guest commands accept only the exact approved control fields', () => {
  const command = validCommand();
  assert.deepEqual(sanitizeCommand(command, 'lush'), command);
  for (const extra of ['deviceToken', 'ownerToken', 'edgeCount', 'best', 'threshold', 'resetThreshold', 'powerCap', 'toy', 'simulation', 'active', 'state', 'valve', '__proto__']) {
    const supplied = JSON.parse(JSON.stringify(command));
    Object.defineProperty(supplied, extra, { value: 1, enumerable: true });
    assert.throws(() => sanitizeCommand(supplied, 'lush'), /Unsupported control/);
  }
  for (const value of [null, undefined, [], '100', 100]) {
    assert.throws(() => sanitizeCommand(value, 'lush'), /Invalid controls/);
  }
});

test('numeric command fields are mandatory finite numbers, never coercions', () => {
  for (const field of ['percent', 'cooldownSeconds', 'epoch', 'clientSeq']) {
    for (const value of [undefined, null, true, '50', {}, [], NaN, Infinity, -Infinity]) {
      assert.throws(() => sanitizeCommand(validCommand({ [field]: value }), 'lush'));
    }
  }
});

test('commands reject out-of-range outputs and cooldowns instead of clamping', () => {
  for (const percent of [-0.1, -1, 100.1, 101]) {
    assert.throws(() => sanitizeCommand(validCommand({ percent }), 'lush'), /outside limits/);
  }
  for (const cooldownSeconds of [0, 9.9, 30.1, 100]) {
    assert.throws(() => sanitizeCommand(validCommand({ cooldownSeconds }), 'lush'), /outside limits/);
  }
  for (const percent of [0, 100]) {
    for (const cooldownSeconds of [10, 30]) {
      assert.deepEqual(sanitizeCommand(validCommand({ percent, cooldownSeconds }), 'lush'), validCommand({ percent, cooldownSeconds }));
    }
  }
  assert.equal(sanitizeCommand(validCommand({ percent: 50.5 }), 'lush').percent, 51);
});

test('paired Opossum commands canonicalize their scalar aggregate including B-only output', () => {
  for (const [percentA, percentB] of [[0, 100], [100, 0], [10, 90], [90, 10], [0, 0], [20.4, 80.5]]) {
    const expected = validCommand({ percent: Math.max(Math.round(percentA), Math.round(percentB)), percentA: Math.round(percentA), percentB: Math.round(percentB) });
    for (const scalar of [undefined, 0, 100]) {
      const input = validCommand({ percent: scalar, percentA, percentB });
      if (scalar === undefined) delete input.percent;
      assert.deepEqual(sanitizeCommand(input, 'opossum'), expected);
    }
  }
  assert.deepEqual(sanitizeCommand(validCommand({ percent: 47.5 }), 'opossum'), validCommand({ percent: 48, percentA: 48, percentB: 0 }));
});

test('Opossum paired controls require both finite in-range channels and strict optional scalar', () => {
  for (const field of ['percentA', 'percentB']) {
    for (const value of [undefined, null, '50', true, {}, [], NaN, Infinity, -Infinity, -0.1, 100.1]) {
      assert.throws(() => sanitizeCommand(validCommand({ percentA: 50, percentB: 50, [field]: value }), 'opossum'));
    }
    const missing = validCommand({ percentA: 50, percentB: 50 });
    delete missing[field];
    assert.throws(() => sanitizeCommand(missing, 'opossum'));
  }
  for (const percent of [undefined, null, '0', true, {}, [], NaN, Infinity, -Infinity, -1, 101]) {
    assert.throws(() => sanitizeCommand(validCommand({ percent, percentA: 0, percentB: 60 }), 'opossum'));
  }
});

test('dual controls are forbidden for other devices and never authorize changing caps', () => {
  for (const toy of ['lush', 'vacuglide']) {
    for (const fields of [{ percentA: 0 }, { percentB: 0 }, { percentA: 0, percentB: 0 }]) {
      assert.throws(() => sanitizeCommand(validCommand(fields), toy), /Unsupported control/);
    }
  }
  for (const field of ['maxPercentA', 'maxPercentB', 'powerCapA', 'powerCapB', 'outputPercentA', 'outputPercentB', 'deviceToken', 'valve']) {
    assert.throws(() => sanitizeCommand(validCommand({ percentA: 10, percentB: 20, [field]: 100 }), 'opossum'), /Unsupported control/);
  }
});

test('sequence and epoch fields reject fractions, negatives and unsafe integers', () => {
  for (const epoch of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => sanitizeCommand(validCommand({ epoch }), 'lush'), /Invalid sequence/);
  }
  for (const clientSeq of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => sanitizeCommand(validCommand({ clientSeq }), 'lush'), /Invalid sequence/);
  }
  assert.equal(sanitizeCommand(validCommand({ epoch: 0 }), 'lush').epoch, 0);
});

test('Lush and Opossum support approved patterns; VacuGlide accepts steady only', () => {
  for (const toy of ['lush', 'opossum']) {
    for (const pattern of PATTERNS) {
      assert.equal(sanitizeCommand(validCommand({ pattern }), toy).pattern, pattern);
      assert.equal(sanitizeState({ phase: 'running', pattern }, toy).pattern, pattern);
    }
  }
  for (const pattern of ['pulse', 'wave', '', 'script', '<script>', undefined, {}, 1]) {
    assert.throws(() => sanitizeCommand(validCommand({ pattern }), 'vacuglide'), /Unsupported pattern/);
  }
  assert.equal(sanitizeCommand(validCommand(), 'vacuglide').pattern, 'steady');
});

test('public session responses expose no hashes, tokens, commands or password fields', () => {
  const now = 1700000000000;
  const row = {
    id: 'session-id', toy: 'lush', simulation: false,
    state: { phase: 'running', edgeCount: 4, outputPercent: 50 },
    state_at: new Date(now - 1000).toISOString(), command_seq: 7, client_seq: 8,
    owner_hash: 'private', code_hash: 'private', guest_hash: 'private',
    guest_client_hash: 'private', command: { deviceToken: 'private' },
    password_hash: 'private',
  };
  const result = publicSession(row, 12, now);
  assert.deepEqual(Object.keys(result).sort(), ['sessionId', 'state', 'best', 'hostOnline', 'serverNow', 'commandSeq', 'clientSeq'].sort());
  assert.equal(result.best, 12);
  assert.equal(result.hostOnline, true);
  assert.equal(result.state.edgeCount, 4);
  assert.equal(result.commandSeq, 7);
  assert.equal(result.clientSeq, 8);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('guest-visible host state becomes unavailable at the five-second freshness boundary', () => {
  const now = 1700000000000;
  const row = {
    id: 'session-id', toy: 'lush', simulation: false,
    state: { phase: 'running', outputPercent: 100, reason: 'Running' },
    state_at: new Date(now - 4999).toISOString(),
  };
  assert.equal(publicSession(row, 1, now).hostOnline, true);
  for (const state_at of [new Date(now - 5000).toISOString(), new Date(now - 5001).toISOString(), new Date(now + 1).toISOString(), null, '', 'invalid']) {
    const result = publicSession({ ...row, state_at }, 1, now);
    assert.equal(result.hostOnline, false);
    assert.equal(result.state.phase, 'paused');
    assert.equal(result.state.outputPercent, 0);
    assert.equal(result.state.reason, 'Host connection unavailable');
  }
});

test('stale Opossum state zeros both outputs but preserves separate selected levels', () => {
  const now = 1700000000000;
  const row = {
    id: 'session-id', toy: 'opossum', simulation: false,
    state: { phase: 'running', outputPercentA: 35, outputPercentB: 85, guestPercentA: 40, guestPercentB: 90 },
  };
  const fresh = publicSession({ ...row, state_at: new Date(now - 4999).toISOString() }, 0, now);
  assert.equal(fresh.state.outputPercent, 85);
  assert.equal(fresh.state.outputPercentA, 35);
  assert.equal(fresh.state.outputPercentB, 85);
  for (const state_at of [new Date(now - 5000).toISOString(), new Date(now + 1).toISOString(), null, 'invalid']) {
    const result = publicSession({ ...row, state_at }, 0, now);
    assert.equal(result.hostOnline, false);
    assert.equal(result.state.phase, 'paused');
    for (const field of ['outputPercent', 'outputPercentA', 'outputPercentB']) assert.equal(result.state[field], 0);
    assert.equal(result.state.guestPercentA, 40);
    assert.equal(result.state.guestPercentB, 90);
  }
});

test('simulation guest sessions do not expose the real personal record', () => {
  const now = 1700000000000;
  const result = publicSession({
    id: 'simulation-id', toy: 'lush', simulation: true,
    state_at: new Date(now).toISOString(), state: { phase: 'running' },
  }, 42, now);
  assert.equal(result.best, 0);
  assert.equal(result.state.simulation, true);
});

test('password verification matches salted PBKDF2, rejects wrong passwords and settings', async () => {
  // Deliberate public fixture, never an application credential.
  const password = 'public-test-fixture-only';
  const salt = '0123456789abcdef0123456789abcdef';
  const settings = {
    password_salt: salt, iterations: 600000,
    password_hash: pbkdf2Sync(password, Buffer.from(salt, 'hex'), 600000, 32, 'sha256').toString('hex'),
  };
  assert.equal(await verifyPassword(password, settings), true);
  assert.equal(await verifyPassword(`${password}-wrong`, settings), false);
  assert.equal(await verifyPassword(password, { ...settings, password_salt: 'a'.repeat(32) }), false);
  for (const invalid of [null, undefined, '', [], {}, 'x'.repeat(257)]) {
    assert.equal(await verifyPassword(invalid, settings), false);
  }
  for (const invalid of [null, {}, { ...settings, password_salt: 'bad' }, { ...settings, password_salt: 'a'.repeat(33) }, { ...settings, password_hash: 'bad' }, { ...settings, iterations: 599999 }, { ...settings, iterations: 1000001 }, { ...settings, iterations: '600000' }]) {
    assert.equal(await verifyPassword(password, invalid), false);
  }
});

// Import the actual Edge Function without starting a server or contacting any
// service. All subsequent database calls are intercepted and asserted below.
const fixtureOrigin = 'https://ctmp-security-fixture.invalid';
const fixtureService = 'public-test-service-placeholder';
const previousDeno = globalThis.Deno;
globalThis.Deno = {
  env: { get: name => ({ SUPABASE_URL: fixtureOrigin, SUPABASE_SERVICE_ROLE_KEY: fixtureService })[name] },
  serve: () => {},
};
const { handler } = await import('../supabase/functions/ctmp-control/index.ts');
if (previousDeno === undefined) delete globalThis.Deno;
else globalThis.Deno = previousDeno;

const ownerToken = 'a'.repeat(64);
const guestToken = 'b'.repeat(64);
const sessionId = '00000000-0000-4000-8000-000000000001';
const ownerHash = await hash(ownerToken);
const guestHash = await hash(guestToken);
const fixtureSession = (overrides = {}) => ({
  id: sessionId, owner_hash: ownerHash, guest_hash: guestHash,
  code_hash: 'c'.repeat(64), guest_client_hash: 'd'.repeat(64),
  active: true, toy: 'lush', simulation: false,
  state: { phase: 'running', epoch: 3, outputPercent: 50, edgeCount: 4 },
  state_at: new Date().toISOString(), guest_seen_at: new Date().toISOString(),
  command_seq: 0, client_seq: 0, command: null, ...overrides,
});
const apiRequest = (body, { token, origin = 'https://ctmp.uk', raw, headers = {} } = {}) => new Request(fixtureOrigin + '/functions/v1/ctmp-control', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  body: raw ?? JSON.stringify(body),
});

async function withDatabase(respond, run) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, fixtureOrigin, 'a test must never make a real network request');
    assert.equal(options.headers.apikey, fixtureService);
    assert.equal(options.headers.Authorization, `Bearer ${fixtureService}`);
    const call = {
      path: url.pathname.replace('/rest/v1/', ''), query: url.searchParams,
      method: options.method || 'GET', body: options.body === undefined ? undefined : JSON.parse(options.body),
    };
    calls.push(call);
    const result = await respond(call);
    return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try { await run(calls); } finally { globalThis.fetch = realFetch; }
}

test('Edge Function CORS, methods and malformed requests fail before database access', async () => {
  await withDatabase(() => assert.fail('unexpected database access'), async () => {
    const options = await handler(new Request(fixtureOrigin, { method: 'OPTIONS', headers: { origin: 'https://ctmp.uk' } }));
    assert.equal(options.status, 204);
    assert.equal(options.headers.get('access-control-allow-origin'), 'https://ctmp.uk');
    assert.equal(options.headers.get('cache-control'), 'no-store');
    assert.equal((await handler(new Request(fixtureOrigin, { method: 'GET' }))).status, 405);
    const evil = await handler(apiRequest({ action: 'owner-login' }, { origin: 'https://untrusted.example' }));
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.has('access-control-allow-origin'), false);
    for (const raw of ['{', 'null', '[]', '"owner-login"']) {
      assert.equal((await handler(apiRequest({}, { raw }))).status, 400);
    }
    assert.equal((await handler(apiRequest({}, { raw: 'x'.repeat(12001) }))).status, 413);
    assert.equal((await handler(apiRequest({}, { headers: { 'content-length': '12001' } }))).status, 413);
  });
});

test('all privileged actions reject missing and malformed credentials', async () => {
  await withDatabase(() => assert.fail('unauthenticated requests must not access storage'), async () => {
    for (const action of ['owner-status', 'owner-logout', 'best-save', 'session-create', 'session-end', 'host-sync', 'guest-poll', 'guest-command']) {
      for (const token of [undefined, 'not-a-token']) {
        const response = await handler(apiRequest({ action, sessionId, state: { phase: 'running' } }, { token }));
        assert.equal(response.status, 401, action);
      }
    }
  });
});

test('a guest bearer capability cannot perform owner actions', async () => {
  await withDatabase(call => {
    assert.equal(call.path, 'ctmp_v2_owner_tokens');
    assert.equal(call.query.get('token_hash'), `eq.${guestHash}`);
    assert.match(call.query.get('expires_at'), /^gt\./);
    return [];
  }, async () => {
    for (const action of ['owner-status', 'owner-logout', 'session-create', 'session-end', 'host-sync', 'best-save']) {
      assert.equal((await handler(apiRequest({ action, sessionId }, { token: guestToken }))).status, 401);
    }
  });
});

test('owner login verifies server-side PBKDF2 and stores only an expiring token hash', async () => {
  const password = 'public-login-test-fixture-only';
  const salt = '0123456789abcdef0123456789abcdef';
  const config = {
    password_salt: salt, iterations: 600000, best: 17,
    password_hash: pbkdf2Sync(password, Buffer.from(salt, 'hex'), 600000, 32, 'sha256').toString('hex'),
  };
  let stored;
  await withDatabase(call => {
    if (call.path === 'rpc/ctmp_v2_rate') return true;
    if (call.path === 'ctmp_v2_settings') return [config];
    assert.equal(call.path, 'ctmp_v2_owner_tokens');
    assert.equal(call.method, 'POST');
    stored = call.body;
    return [call.body];
  }, async () => {
    const response = await handler(apiRequest({ action: 'owner-login', password }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(isToken(result.token), true);
    assert.equal(stored.token_hash, await hash(result.token));
    assert.notEqual(stored.token_hash, result.token);
    assert.ok(Date.parse(stored.expires_at) > Date.now() + 23 * 3600000);
    assert.equal(result.best, 17);
    assert.deepEqual(Object.keys(stored).sort(), ['expires_at', 'token_hash']);
    assert.equal('password_hash' in result, false);
    assert.equal('password_salt' in result, false);
    assert.equal(JSON.stringify(result).includes(password), false);
  });
  await withDatabase(call => {
    if (call.path === 'rpc/ctmp_v2_rate') return true;
    if (call.path === 'ctmp_v2_settings') return [config];
    assert.fail('incorrect password must not create an owner capability');
  }, async () => {
    assert.equal((await handler(apiRequest({ action: 'owner-login', password: 'incorrect-public-fixture' }))).status, 401);
  });
});

test('guest authentication binds the token to the active session', async () => {
  await withDatabase(call => {
    if (call.path === 'rpc/ctmp_v2_rate') return true;
    assert.equal(call.path, 'ctmp_v2_sessions');
    assert.equal(call.query.get('active'), 'eq.true');
    return [fixtureSession({ guest_hash: 'e'.repeat(64) })];
  }, async () => {
    assert.equal((await handler(apiRequest({ action: 'guest-poll', sessionId }, { token: guestToken }))).status, 401);
    assert.equal((await handler(apiRequest({ action: 'guest-command', sessionId, command: validCommand() }, { token: ownerToken }))).status, 401);
  });
});

test('guest join rate limits and validates before looking up a code', async () => {
  await withDatabase(call => {
    assert.equal(call.path, 'rpc/ctmp_v2_rate');
    return true;
  }, async () => {
    for (const values of [{ code: 'ABCDEF', clientId: '' }, { code: 'ABCD', clientId: 'a'.repeat(32) }]) {
      assert.equal((await handler(apiRequest({ action: 'guest-join', ...values }))).status, 404);
    }
  });
  await withDatabase(call => {
    assert.equal(call.path, 'rpc/ctmp_v2_rate');
    return false;
  }, async () => {
    assert.equal((await handler(apiRequest({ action: 'guest-join', code: 'ABCDEF', clientId: 'a'.repeat(32) }))).status, 429);
  });
});

test('guest join stores hashed credentials and exposes only the public response', async () => {
  let joinedTokenHash;
  await withDatabase(async call => {
    if (call.path === 'rpc/ctmp_v2_rate') return true;
    if (call.path === 'rpc/ctmp_v2_join') {
      assert.equal(call.body.p_code, await hash('ABCDEF'));
      assert.equal(call.body.p_client, await hash('a'.repeat(32)));
      assert.equal(isToken(call.body.p_guest), true);
      joinedTokenHash = call.body.p_guest;
      return fixtureSession({ guest_hash: joinedTokenHash });
    }
    assert.equal(call.path, 'ctmp_v2_settings');
    return [{ best: 42, password_hash: 'private-password-fixture', password_salt: 'private-salt-fixture' }];
  }, async () => {
    const response = await handler(apiRequest({ action: 'guest-join', code: ' abcdef ', clientId: 'a'.repeat(32) }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(isToken(result.token), true);
    assert.equal(await hash(result.token), joinedTokenHash);
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.best, 42);
    for (const forbidden of ['owner_hash', 'guest_hash', 'guest_client_hash', 'code_hash', 'password_hash', 'password_salt', 'command']) {
      assert.equal(forbidden in result, false);
    }
    assert.equal(JSON.stringify(result).includes('private-password-fixture'), false);
  });
});

test('guest control rejects extra fields before any command RPC', async () => {
  await withDatabase(call => {
    if (call.path === 'rpc/ctmp_v2_rate') return true;
    if (call.path === 'ctmp_v2_sessions') return [fixtureSession()];
    assert.fail(`unexpected call ${call.path}`);
  }, async () => {
    for (const extras of [{ edgeCount: 999 }, { best: 999 }, { deviceToken: 'private' }, { threshold: 99 }, { valve: 'open' }]) {
      const response = await handler(apiRequest({ action: 'guest-command', sessionId, command: validCommand(extras) }, { token: guestToken }));
      assert.equal(response.status, 400);
    }
  });
});

test('guest command honors atomic stale/phase/epoch/replay rejection from storage', async () => {
  for (const result of [-1, -2, -3, -4]) {
    await withDatabase(call => {
      if (call.path === 'rpc/ctmp_v2_rate') return true;
      if (call.path === 'ctmp_v2_sessions') return [fixtureSession()];
      assert.equal(call.path, 'rpc/ctmp_v2_command');
      assert.deepEqual(call.body, { p_session: sessionId, p_guest: guestHash, p_command: validCommand() });
      return result;
    }, async () => {
      const response = await handler(apiRequest({ action: 'guest-command', sessionId, command: validCommand() }, { token: guestToken }));
      assert.equal(response.status, 409);
      assert.equal('accepted' in await response.json(), false);
    });
  }
});

test('Opossum guest commands reach the atomic gate only after canonicalizing both channels', async () => {
  for (const [phase, percentA, percentB, accepted] of [
    ['running', 0, 80, true], ['running', 35, 65, true],
    ['cooldown', 0, 80, false], ['paused', 75, 0, false],
    ['cooldown', 0, 0, true], ['fault', 0, 0, true],
  ]) {
    let commandSeen;
    await withDatabase(call => {
      if (call.path === 'rpc/ctmp_v2_rate') return true;
      if (call.path === 'ctmp_v2_sessions') return [fixtureSession({ toy: 'opossum', state: { phase, epoch: 3 } })];
      assert.equal(call.path, 'rpc/ctmp_v2_command');
      commandSeen = call.body.p_command;
      assert.equal(commandSeen.percentA, percentA);
      assert.equal(commandSeen.percentB, percentB);
      assert.equal(commandSeen.percent, Math.max(percentA, percentB), 'a forged scalar zero must not bypass the SQL phase gate');
      // Mirror the unchanged service-only RPC phase predicate. Assertions above
      // independently prove its input is canonical, not the raw guest payload.
      return phase !== 'running' && commandSeen.percent !== 0 ? -2 : 1;
    }, async () => {
      const response = await handler(apiRequest({ action: 'guest-command', sessionId, command: validCommand({ percent: 0, percentA, percentB }) }, { token: guestToken }));
      assert.equal(response.status, accepted ? 200 : 409, `${phase}: A=${percentA}, B=${percentB}`);
      assert.ok(commandSeen);
      if (accepted) assert.equal((await response.json()).accepted, true);
    });
  }
});

test('dual guest payloads retain atomic stale/epoch/replay rejections and reject cap injection', async () => {
  for (const result of [-1, -2, -3, -4]) {
    await withDatabase(call => {
      if (call.path === 'rpc/ctmp_v2_rate') return true;
      if (call.path === 'ctmp_v2_sessions') return [fixtureSession({ toy: 'opossum' })];
      assert.equal(call.path, 'rpc/ctmp_v2_command');
      assert.equal(call.body.p_command.percent, 80);
      return result;
    }, async () => {
      const command = validCommand({ percentA: 20, percentB: 80 });
      delete command.percent;
      assert.equal((await handler(apiRequest({ action: 'guest-command', sessionId, command }, { token: guestToken }))).status, 409);
    });
  }
  for (const toy of ['lush', 'vacuglide', 'opossum']) {
    await withDatabase(call => {
      if (call.path === 'rpc/ctmp_v2_rate') return true;
      if (call.path === 'ctmp_v2_sessions') return [fixtureSession({ toy })];
      assert.fail('unsupported dual/cap fields must fail before the command RPC');
    }, async () => {
      const command = validCommand({ percentA: 0, percentB: 90, ...(toy === 'opossum' ? { maxPercentB: 100 } : {}) });
      assert.equal((await handler(apiRequest({ action: 'guest-command', sessionId, command }, { token: guestToken }))).status, 400);
    });
  }
});

test('only the creating owner token can publish authoritative host telemetry', async () => {
  await withDatabase(call => {
    if (call.path === 'ctmp_v2_owner_tokens') return [{ token_hash: ownerHash }];
    if (call.path === 'rpc/ctmp_v2_rate') return true;
    if (call.path === 'ctmp_v2_sessions' && call.method === 'GET') return [fixtureSession({ owner_hash: 'e'.repeat(64) })];
    assert.fail('a different owner token must not publish or receive commands');
  }, async () => {
    assert.equal((await handler(apiRequest({ action: 'host-sync', sessionId, state: { phase: 'running' } }, { token: ownerToken }))).status, 409);
  });
});

test('owner session creation supports all three devices without exposing code hashes', async () => {
  for (const toy of ['lush', 'opossum', 'vacuglide']) {
    let created;
    await withDatabase(call => {
      if (call.path === 'ctmp_v2_owner_tokens') return [{ token_hash: ownerHash }];
      if (call.path === 'rpc/ctmp_v2_rate') return true;
      assert.equal(call.path, 'rpc/ctmp_v2_create_session');
      created = call.body;
      assert.equal(created.p_toy, toy);
      assert.equal(created.p_owner, ownerHash);
      assert.equal(created.p_simulation, false);
      assert.equal(isToken(created.p_code), true);
      return fixtureSession({ toy });
    }, async () => {
      const response = await handler(apiRequest({ action: 'session-create', toy, simulation: false }, { token: ownerToken }));
      assert.equal(response.status, 200, toy);
      const result = await response.json();
      assert.equal(isCode(result.code), true);
      assert.equal(await hash(result.code), created.p_code);
      assert.equal('code_hash' in result, false);
      assert.equal('owner_hash' in result, false);
      assert.equal(result.sessionId, sessionId);
    });
  }
});

test('host sync sanitizes state and fails if the session ended during its update', async () => {
  let published;
  await withDatabase(call => {
    if (call.path === 'ctmp_v2_owner_tokens') return [{ token_hash: ownerHash }];
    if (call.path === 'rpc/ctmp_v2_rate') return true;
    if (call.path === 'ctmp_v2_sessions' && call.method === 'GET') return [fixtureSession()];
    if (call.path === 'ctmp_v2_sessions' && call.method === 'PATCH') {
      assert.equal(call.query.get('active'), 'eq.true');
      assert.equal(call.query.get('owner_hash'), `eq.${ownerHash}`);
      published = call.body;
      return [];
    }
    assert.fail('a revoked session must not update scores or receive old commands');
  }, async () => {
    const response = await handler(apiRequest({ action: 'host-sync', sessionId, state: { phase: 'cooldown', outputPercent: 100, edgeCount: 4, deviceToken: 'private' } }, { token: ownerToken }));
    assert.equal(response.status, 409);
    assert.equal(published.state.outputPercent, 0);
    assert.equal('deviceToken' in published.state, false);
    assert.ok(Number.isFinite(Date.parse(published.state_at)));
  });
});

test('any freshly authenticated owner can end old links and clear guest access', async () => {
  let ended;
  await withDatabase(call => {
    if (call.path === 'ctmp_v2_owner_tokens') return [{ token_hash: ownerHash }];
    if (call.path === 'rpc/ctmp_v2_rate') return true;
    assert.equal(call.path, 'ctmp_v2_sessions');
    assert.equal(call.method, 'PATCH');
    assert.equal(call.query.get('active'), 'eq.true');
    assert.equal(call.query.has('owner_hash'), false, 'relogin must not orphan old links');
    ended = call.body;
    return [];
  }, async () => {
    assert.equal((await handler(apiRequest({ action: 'session-end' }, { token: ownerToken }))).status, 200);
    assert.equal(ended.active, false);
    assert.deepEqual(ended.state, {});
    assert.equal(ended.command, null);
    assert.equal(ended.guest_hash, null);
    assert.equal(ended.guest_client_hash, null);
    assert.ok(Number.isFinite(Date.parse(ended.ended_at)));
  });
});

test('simulated or invalid scores cannot update the saved record', async () => {
  await withDatabase(call => {
    if (call.path === 'ctmp_v2_owner_tokens') return [{ token_hash: ownerHash }];
    if (call.path === 'rpc/ctmp_v2_rate') return true;
    if (call.path === 'ctmp_v2_sessions') return [fixtureSession({ simulation: true })];
    assert.fail('simulation must never call the best-record RPC');
  }, async () => {
    for (const body of [{ count: 5, simulation: true }, { count: 5 }, { count: -1, simulation: false }, { count: 5.5, simulation: false }, { count: 1000001, simulation: false }]) {
      assert.equal((await handler(apiRequest({ action: 'best-save', ...body }, { token: ownerToken }))).status, 400);
    }
    assert.equal((await handler(apiRequest({ action: 'best-save', count: 9, simulation: false }, { token: ownerToken }))).status, 409);
  });
});

test('a simulation host-sync does not call the record-update RPC', async () => {
  await withDatabase(call => {
    if (call.path === 'ctmp_v2_owner_tokens') return [{ token_hash: ownerHash }];
    if (call.path === 'rpc/ctmp_v2_rate') return true;
    if (call.path === 'ctmp_v2_sessions') return [fixtureSession({ simulation: true })];
    assert.fail('simulation host-sync must not update the real record');
  }, async () => {
    const response = await handler(apiRequest({ action: 'host-sync', sessionId, state: { phase: 'running', edgeCount: 99999, simulation: false } }, { token: ownerToken }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).best, 0);
  });
});

test('database errors return a generic failure and never leak a credential or response body', async () => {
  await withDatabase(() => new Response('private database error with password fixture', { status: 500 }), async () => {
    const response = await handler(apiRequest({ action: 'owner-status' }, { token: ownerToken }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Service temporarily unavailable' });
  });
});

test('V2 schema leaves legacy tables untouched and grants all new access only to service role', async () => {
  const sql = await readFile(new URL('../supabase/ctmp-v2-schema.sql', import.meta.url), 'utf8');
  const tables = [...sql.matchAll(/create table if not exists public\.(ctmp_v2_\w+)\s*\(/gi)].map(match => match[1]);
  assert.deepEqual(tables.sort(), ['ctmp_v2_settings', 'ctmp_v2_owner_tokens', 'ctmp_v2_sessions', 'ctmp_v2_rates'].sort());
  for (const table of tables) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security;`, 'i'));
    assert.match(sql, new RegExp(`revoke all on [^;]*public\\.${table}[^;]* from public,\\s*anon,\\s*authenticated;`, 'i'));
    assert.match(sql, new RegExp(`grant all on [^;]*public\\.${table}[^;]* to service_role;`, 'i'));
  }
  assert.doesNotMatch(sql, /(?:grant|create policy)[^;]*(?:to\s+(?:public|anon|authenticated))/i);
  assert.doesNotMatch(sql, /security\s+definer/i);
  assert.doesNotMatch(sql, /(?:alter|drop|delete from|update|truncate)\s+(?:table\s+)?public\.control_/i);
  const functions = [...sql.matchAll(/create or replace function public\.(ctmp_v2_\w+)\(/gi)].map(match => match[1]);
  assert.equal(functions.length, 5);
  for (const fn of functions) {
    assert.match(sql, new RegExp(`revoke all on function [^;]*public\\.${fn}\\([^;]* from public,\\s*anon,\\s*authenticated;`, 'i'));
    assert.match(sql, new RegExp(`grant execute on function [^;]*public\\.${fn}\\([^;]* to service_role;`, 'i'));
  }
});

test('schema serializes session replacement and guest admission, with atomic best and command sequencing', async () => {
  const sql = await readFile(new URL('../supabase/ctmp-v2-schema.sql', import.meta.url), 'utf8');
  assert.match(sql, /create unique index[^;]*ctmp_v2_one_active[^;]*where active/i);
  assert.match(sql, /pg_advisory_xact_lock\(/i);
  assert.match(sql, /best=greatest\(best,/i);
  assert.match(sql, /code_hash=p_code and active for update/i);
  assert.match(sql, /guest_client_hash is not null and result\.guest_client_hash <> p_client/i);
  assert.match(sql, /id=p_session and guest_hash=p_guest and active for update/i);
  assert.match(sql, /clientSeq'\)::bigint <= result\.client_seq/i);
  assert.match(sql, /command_seq=command_seq\+1/i);
  assert.match(sql, /jsonb_build_object\('at',floor\(extract\(epoch from clock_timestamp\(\)\)\*1000\)\)/i);
  assert.doesNotMatch(sql, /create table[^;]*ctmp_v2_sessions[^;]*expires_at/is);
});

test('custom capability authentication is explicitly enabled for the new function', async () => {
  const config = await readFile(new URL('../supabase/config.toml', import.meta.url), 'utf8');
  assert.match(config, /\[functions\.ctmp-control\][^\[]*verify_jwt\s*=\s*false/i);
});

async function makeHostHarness() {
  // Exercise the actual browser orchestration with an actual state machine,
  // inert UI/device transports and no scheduled or network side effects.
  const source = (await readFile(new URL('../app/main.js', import.meta.url), 'utf8'))
    .replace(/^import .* from ['"][^'"]+['"];\s*$/gm, '');
  class FakeUI {
    constructor({ onAction }) { this.onAction = onAction; }
    render(view) { this.view = view; }
    message() {}
    releaseValves() {}
  }
  class FakeDevice {
    constructor() { this.connected = false; this.stops = 0; this.outputs = []; this.levelOutputs = []; this.stopFailure = null; }
    setOutput(value) { this.outputs.push(value); return Promise.resolve(); }
    setLevels({ a, b }) { this.levelOutputs.push({ a, b }); return Promise.resolve(); }
    stop() { this.stops++; return this.stopFailure ? Promise.reject(this.stopFailure) : Promise.resolve(); }
    disconnect() { this.connected = false; return Promise.resolve(); }
  }
  class FakeBackend {
    constructor() { this.ownerToken = null; this.guestToken = null; this.clockOffset = 0; this.calls = []; }
    async call(action, payload) { this.calls.push({ action, payload }); return this.respond(action, payload); }
    respond() { throw new Error('Unexpected fixture backend action'); }
  }
  const storage = () => {
    const map = new Map();
    return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
  };
  const windowListeners = new Map();
  const documentListeners = new Map();
  const scope = {
    UI: FakeUI, SessionEngine, Backend: FakeBackend, CivetDevice: FakeDevice,
    LushDevice: FakeDevice, OpossumDevice: FakeDevice, VacuGlideDevice: FakeDevice,
    runDiagnostics: () => [], Date, crypto: globalThis.crypto,
    location: { pathname: '/', origin: 'https://ctmp.uk' }, navigator: {},
    document: { hidden: false, addEventListener(name, listener) { if (!documentListeners.has(name)) documentListeners.set(name, []); documentListeners.get(name).push(listener); } },
    window: { addEventListener(name, listener) { if (!windowListeners.has(name)) windowListeners.set(name, []); windowListeners.get(name).push(listener); } },
    localStorage: storage(), sessionStorage: storage(),
    setInterval: () => 1, setTimeout: () => 1, clearTimeout() {}, queueMicrotask() {},
  };
  runInNewContext(source + `
    globalThis.hostHarness = {
      syncHost, remoteFault, endRemote, handleAction, applyGuestState, unlock,
      queueGuestCommand, flushGuestCommand,
      get engine() { return engine; }, get drivers() { return drivers; },
      get backend() { return backend; }, get epoch() { return epoch; },
      get remote() { return remote; }, get guestNewRecord() { return guestNewRecord; },
      get guestDesired() { return guestDesired; }, get guestPending() { return guestPending; },
      setState(values) {
        if ('remote' in values) remote = values.remote;
        if ('guest' in values) guest = values.guest;
        if ('guestState' in values) guestState = values.guestState;
        if ('guestBest' in values) guestBest = values.guestBest;
      },
    };
  `, scope, { filename: 'ctmp-main-security-fixture.js' });
  scope.hostHarness.dispatchWindow = name => { for (const listener of windowListeners.get(name) || []) listener(); };
  scope.hostHarness.setHidden = hidden => {
    scope.document.hidden = hidden;
    for (const listener of documentListeners.get('visibilitychange') || []) listener();
  };
  return scope.hostHarness;
}

async function runningGuestHost(toy = 'lush') {
  const host = await makeHostHarness();
  host.drivers[toy].connected = true;
  host.backend.ownerToken = ownerToken;
  host.engine.configure({ mode: 'guest', toy, threshold: 23, resetThreshold: 21.5 });
  host.engine.updatePressure(21);
  host.engine.start();
  host.setState({ remote: { sessionId, owned: true, url: 'https://ctmp.uk/ABCDEF' } });
  return host;
}

test('host honors pattern and cooldown changes while a running guest slider is off', async () => {
  const host = await runningGuestHost();
  host.backend.respond = action => {
    assert.equal(action, 'host-sync');
    const now = Date.now();
    return {
      best: 0, guestConnected: true, commandSeq: 1, serverNow: now,
      command: validCommand({ percent: 0, pattern: 'wave', cooldownSeconds: 10, epoch: host.epoch, at: now }),
    };
  };
  await host.syncHost();
  assert.equal(host.engine.guestPercent, 0);
  assert.equal(host.engine.pattern, 'wave');
  assert.equal(host.engine.config.cooldownSeconds, 10);
  assert.equal(host.engine.outputPercent, 0);
});

test('a guest Stop during cooldown cannot shorten or reconfigure that cooldown', async () => {
  const host = await runningGuestHost();
  host.engine.setGuestOutput({ percent: 75, pattern: 'pulse', cooldownSeconds: 30 });
  host.engine.updatePressure(23);
  const deadline = host.engine.cooldownEndsAt;
  host.backend.respond = () => {
    const now = Date.now();
    return {
      best: 1, guestConnected: true, commandSeq: 1, serverNow: now,
      command: validCommand({ percent: 0, pattern: 'wave', cooldownSeconds: 10, epoch: host.epoch, at: now }),
    };
  };
  await host.syncHost();
  assert.equal(host.engine.phase, 'cooldown');
  assert.equal(host.engine.guestPercent, 0);
  assert.equal(host.engine.pattern, 'pulse');
  assert.equal(host.engine.config.cooldownSeconds, 30);
  assert.equal(host.engine.cooldownEndsAt, deadline);
});

test('host routes independent Opossum outputs through setLevels, including B-only commands', async () => {
  for (const [percentA, percentB] of [[0, 85], [45, 85], [85, 0]]) {
    const host = await runningGuestHost('opossum');
    host.backend.respond = () => {
      const now = Date.now();
      return { best: 0, guestConnected: true, commandSeq: 1, serverNow: now,
        command: validCommand({ percent: 0, percentA, percentB, epoch: host.epoch, at: now }) };
    };
    await host.syncHost();
    assert.equal(host.engine.phase, 'running');
    assert.equal(host.engine.guestPercentA, percentA);
    assert.equal(host.engine.guestPercentB, percentB);
    assert.equal(host.engine.outputPercent, Math.max(percentA, percentB));
    assert.deepEqual(host.drivers.opossum.levelOutputs.at(-1), { a: percentA, b: percentB });
    assert.equal(host.drivers.opossum.outputs.length, 0, 'dual output must not fall through the legacy scalar driver');
  }
});

test('host maps legacy scalar Opossum guest control to A only', async () => {
  const host = await runningGuestHost('opossum');
  host.engine.setGuestOutput({ percentA: 20, percentB: 80 });
  host.backend.respond = () => {
    const now = Date.now();
    return { best: 0, guestConnected: true, commandSeq: 1, serverNow: now,
      command: validCommand({ percent: 55, epoch: host.epoch, at: now }) };
  };
  await host.syncHost();
  assert.equal(host.engine.guestPercentA, 55);
  assert.equal(host.engine.guestPercentB, 0);
  assert.deepEqual(host.drivers.opossum.levelOutputs.at(-1), { a: 55, b: 0 });
});

test('a forged scalar zero cannot hide positive Opossum B from host cooldown protection', async () => {
  const host = await runningGuestHost('opossum');
  host.engine.setGuestOutput({ percentA: 45, percentB: 85, pattern: 'pulse', cooldownSeconds: 30 });
  host.engine.updatePressure(23);
  const deadline = host.engine.cooldownEndsAt;
  const writesBefore = host.drivers.opossum.levelOutputs.length;
  host.backend.respond = () => {
    const now = Date.now();
    return { best: 1, guestConnected: true, commandSeq: 1, serverNow: now,
      command: validCommand({ percent: 0, percentA: 0, percentB: 100, pattern: 'wave', cooldownSeconds: 10, epoch: host.epoch, at: now }) };
  };
  await host.syncHost();
  assert.equal(host.engine.phase, 'cooldown');
  assert.equal(host.engine.guestPercentA, 45);
  assert.equal(host.engine.guestPercentB, 85);
  assert.equal(host.engine.outputPercentA, 0);
  assert.equal(host.engine.outputPercentB, 0);
  assert.equal(host.engine.pattern, 'pulse');
  assert.equal(host.engine.config.cooldownSeconds, 30);
  assert.equal(host.engine.cooldownEndsAt, deadline);
  assert.equal(host.drivers.opossum.levelOutputs.length, writesBefore);
});

test('true Opossum Stop zeros both selections during cooldown without changing settings or deadline', async () => {
  for (const channelFields of [{ percentA: 0, percentB: 0 }, {}]) {
    const host = await runningGuestHost('opossum');
    host.engine.setGuestOutput({ percentA: 45, percentB: 85, pattern: 'pulse', cooldownSeconds: 30 });
    host.engine.updatePressure(23);
    const deadline = host.engine.cooldownEndsAt;
    host.backend.respond = () => {
      const now = Date.now();
      return { best: 1, guestConnected: true, commandSeq: 1, serverNow: now,
        command: validCommand({ percent: 0, ...channelFields, pattern: 'wave', cooldownSeconds: 10, epoch: host.epoch, at: now }) };
    };
    await host.syncHost();
    assert.equal(host.engine.phase, 'cooldown');
    assert.equal(host.engine.guestPercentA, 0);
    assert.equal(host.engine.guestPercentB, 0);
    assert.equal(host.engine.outputPercentA, 0);
    assert.equal(host.engine.outputPercentB, 0);
    assert.equal(host.engine.pattern, 'pulse');
    assert.equal(host.engine.config.cooldownSeconds, 30);
    assert.equal(host.engine.cooldownEndsAt, deadline);
  }
});

test('both-off Opossum controls may change pattern and cooldown while running', async () => {
  const host = await runningGuestHost('opossum');
  host.engine.setGuestOutput({ percentA: 40, percentB: 80 });
  const stopsBefore = host.drivers.opossum.stops;
  host.backend.respond = () => {
    const now = Date.now();
    return { best: 0, guestConnected: true, commandSeq: 1, serverNow: now,
      command: validCommand({ percent: 0, percentA: 0, percentB: 0, pattern: 'wave', cooldownSeconds: 10, epoch: host.epoch, at: now }) };
  };
  await host.syncHost();
  assert.equal(host.engine.guestPercentA, 0);
  assert.equal(host.engine.guestPercentB, 0);
  assert.equal(host.engine.pattern, 'wave');
  assert.equal(host.engine.config.cooldownSeconds, 10);
  assert.ok(host.drivers.opossum.stops > stopsBefore);
});

test('stale, previous-epoch and disconnected guest commands cannot start either Opossum channel', async () => {
  for (const scenario of ['stale', 'epoch', 'disconnected']) {
    const host = await runningGuestHost('opossum');
    host.backend.respond = () => {
      const now = Date.now();
      return { best: 0, guestConnected: scenario !== 'disconnected', commandSeq: 1, serverNow: now,
        command: validCommand({ percent: 100, percentA: 40, percentB: 100, epoch: host.epoch - (scenario === 'epoch' ? 1 : 0), at: now - (scenario === 'stale' ? 3001 : 0) }) };
    };
    await host.syncHost();
    assert.equal(host.engine.guestPercentA, 0, scenario);
    assert.equal(host.engine.guestPercentB, 0, scenario);
    assert.equal(host.engine.outputPercentA, 0, scenario);
    assert.equal(host.engine.outputPercentB, 0, scenario);
    assert.equal(host.drivers.opossum.levelOutputs.length, 0, scenario);
  }
});

test('host pause wins over an in-flight command to both Opossum channels', async () => {
  const host = await runningGuestHost('opossum');
  const commandEpoch = host.epoch;
  let release;
  host.backend.respond = () => new Promise(resolve => { release = resolve; });
  const syncing = host.syncHost();
  host.engine.pause('Fixture host pause');
  const now = Date.now();
  release({ best: 0, guestConnected: true, commandSeq: 1, serverNow: now,
    command: validCommand({ percent: 100, percentA: 40, percentB: 100, epoch: commandEpoch, at: now }) });
  await syncing;
  assert.equal(host.engine.phase, 'paused');
  assert.equal(host.engine.outputPercentA, 0);
  assert.equal(host.engine.outputPercentB, 0);
  assert.equal(host.drivers.opossum.levelOutputs.length, 0);
});

async function dualGuestHarness(phase = 'running') {
  const guest = await makeHostHarness();
  guest.backend.guestToken = guestToken;
  guest.setState({ guest: { clientId: 'a'.repeat(32), clientSeq: 0, sessionId } });
  const reported = {
    hostOnline: true, clientSeq: 0, best: 0,
    state: { toy: 'opossum', phase, epoch: 3, guestPercent: 80, guestPercentA: 40, guestPercentB: 80, pattern: 'steady', cooldownSeconds: 20, edgeCount: 0 },
  };
  guest.applyGuestState(reported);
  guest.backend.respond = action => {
    assert.equal(action, 'guest-command');
    return { accepted: true, commandSeq: 1, serverNow: Date.now() };
  };
  return { guest, reported };
}

test('guest channel updates send a complete vector and preserve the other channel across poll lag', async () => {
  const { guest, reported } = await dualGuestHarness();
  guest.queueGuestCommand({ percentB: 60 });
  assert.equal(guest.guestPending.percentA, 40);
  assert.equal(guest.guestPending.percentB, 60);
  await guest.flushGuestCommand();
  guest.applyGuestState(reported); // Host has not applied the just-accepted change yet.
  guest.queueGuestCommand({ percentA: 70 });
  assert.equal(guest.guestPending.percentA, 70);
  assert.equal(guest.guestPending.percentB, 60, 'a stale poll must not restore the former B setting');
  assert.equal(guest.guestPending.percent, 70);
  await guest.flushGuestCommand();
  assert.equal(guest.backend.calls.length, 2);
  assert.equal(guest.backend.calls[1].payload.command.percentA, 70);
  assert.equal(guest.backend.calls[1].payload.command.percentB, 60);
});

test('guest queue rejects scalar-zero positive B in cooldown and sends both-zero Stop immediately', async () => {
  const { guest } = await dualGuestHarness('cooldown');
  assert.throws(() => guest.queueGuestCommand({ percent: 0, percentA: 0, percentB: 80 }), /paused during cooldown/);
  assert.equal(guest.backend.calls.length, 0);
  guest.queueGuestCommand({ percent: 0, percentA: 0, percentB: 0 });
  assert.equal(guest.backend.calls.length, 1);
  const command = guest.backend.calls[0].payload.command;
  assert.equal(command.percentA, 0);
  assert.equal(command.percentB, 0);
  assert.equal(command.percent, 0);
});

test('an epoch change cancels a queued dual-channel command before it can be sent', async () => {
  const { guest, reported } = await dualGuestHarness();
  guest.queueGuestCommand({ percentA: 85, percentB: 95 });
  guest.applyGuestState({ ...reported, state: { ...reported.state, epoch: 4, phase: 'cooldown' } });
  await guest.flushGuestCommand();
  assert.equal(guest.guestPending, null);
  assert.equal(guest.backend.calls.length, 0);
});

test('an epoch change discards stale dual-channel intent even while a command is in flight', async () => {
  const { guest, reported } = await dualGuestHarness();
  let release;
  guest.backend.respond = () => new Promise(resolve => { release = resolve; });
  guest.queueGuestCommand({ percentA: 90, percentB: 100 });
  const sending = guest.flushGuestCommand();
  guest.applyGuestState({ ...reported, state: { ...reported.state, epoch: 4, phase: 'cooldown', guestPercentA: 0, guestPercentB: 0, guestPercent: 0 } });
  assert.equal(guest.guestDesired.percentA, 0);
  assert.equal(guest.guestDesired.percentB, 0);
  release({ accepted: true, commandSeq: 1, serverNow: Date.now() });
  await sending;
  assert.equal(guest.guestDesired.percentA, 0);
  assert.equal(guest.guestDesired.percentB, 0);
  assert.equal(guest.backend.calls.length, 1);
});

test('hiding a live Opossum host pauses both channels and visibility alone cannot resume', async () => {
  const host = await runningGuestHost('opossum');
  host.engine.setGuestOutput({ percentA: 45, percentB: 85 });
  assert.equal(host.engine.outputPercentA, 45);
  assert.equal(host.engine.outputPercentB, 85);
  const stopsBefore = host.drivers.opossum.stops;
  const writesBefore = host.drivers.opossum.levelOutputs.length;
  host.setHidden(true);
  assert.equal(host.engine.phase, 'paused');
  assert.equal(host.engine.outputPercentA, 0);
  assert.equal(host.engine.outputPercentB, 0);
  assert.ok(host.drivers.opossum.stops > stopsBefore);
  host.setHidden(false);
  assert.equal(host.engine.phase, 'paused');
  assert.equal(host.drivers.opossum.levelOutputs.length, writesBefore);
});

test('isolated simulation may switch tabs without pausing and cannot write either physical channel', async () => {
  const host = await makeHostHarness();
  host.backend.ownerToken = ownerToken;
  for (const driver of Object.values(host.drivers)) driver.connected = true;
  await host.handleAction('simulation', { enabled: true });
  assert.equal(host.engine.simulation, true);
  for (const driver of Object.values(host.drivers)) assert.equal(driver.connected, false);
  const counts = Object.values(host.drivers).map(driver => [driver.stops, driver.outputs.length, driver.levelOutputs.length]);
  host.engine.configure({ toy: 'opossum', mode: 'guest' });
  host.engine.start();
  host.engine.setGuestOutput({ percentA: 45, percentB: 85 });
  host.setHidden(true);
  assert.equal(host.engine.phase, 'running');
  assert.equal(host.engine.outputPercentA, 45);
  assert.equal(host.engine.outputPercentB, 85);
  host.engine.setGuestOutput({ percentA: 70, percentB: 30 });
  host.setHidden(false);
  assert.equal(host.engine.phase, 'running');
  assert.deepEqual(Object.values(host.drivers).map(driver => [driver.stops, driver.outputs.length, driver.levelOutputs.length]), counts);
});

test('an unconfirmed physical disconnect prevents enabling the simulation visibility exception', async () => {
  const host = await makeHostHarness();
  host.backend.ownerToken = ownerToken;
  host.drivers.opossum.connected = true;
  host.drivers.opossum.disconnect = () => Promise.reject(new Error('Deliberate disconnect failure'));
  await assert.rejects(host.handleAction('simulation', { enabled: true }), /physical disconnect or stop was not confirmed/);
  assert.equal(host.engine.simulation, false);
  host.engine.configure({ toy: 'opossum', mode: 'guest' });
  host.engine.updatePressure(21);
  host.engine.start();
  host.engine.setGuestOutput({ percentA: 45, percentB: 85 });
  assert.equal(host.engine.phase, 'running');
  host.setHidden(true);
  assert.equal(host.engine.phase, 'paused');
  assert.equal(host.engine.outputPercentA, 0);
  assert.equal(host.engine.outputPercentB, 0);
});

test('End invalidates the guest link even when physical stop cannot be confirmed', async () => {
  const host = await runningGuestHost();
  host.drivers.lush.stopFailure = new Error('Deliberate fixture stop failure');
  host.backend.respond = action => {
    assert.equal(action, 'session-end');
    return { ok: true };
  };
  try { await host.endRemote(); } catch { /* physical uncertainty should remain visible */ }
  assert.ok(host.backend.calls.some(call => call.action === 'session-end'), 'physical failure must not skip revocation');
  assert.equal(host.remote, null);
  assert.notEqual(host.engine.phase, 'running');
});

test('repeated heartbeat faults do not repeatedly hammer the physical stop transports', async () => {
  const host = await runningGuestHost();
  host.remoteFault('Fixture connection lost');
  const stopsAfterFirstFault = host.drivers.lush.stops;
  assert.equal(host.engine.phase, 'fault');
  for (let i = 0; i < 50; i++) host.remoteFault('Fixture connection lost');
  assert.equal(host.drivers.lush.stops, stopsAfterFirstFault, 'one outage must not create a 10Hz stop retry loop');
});

test('stale or previous-epoch guest commands cannot change host output', async () => {
  for (const scenario of ['stale', 'epoch']) {
    const host = await runningGuestHost();
    host.backend.respond = () => {
      const now = Date.now();
      return {
        best: 0, guestConnected: true, commandSeq: 1, serverNow: now,
        command: validCommand({ percent: 100, epoch: host.epoch - (scenario === 'epoch' ? 1 : 0), at: now - (scenario === 'stale' ? 3001 : 0) }),
      };
    };
    await host.syncHost();
    assert.equal(host.engine.guestPercent, 0, scenario);
    assert.equal(host.engine.outputPercent, 0, scenario);
    assert.equal(host.drivers.lush.outputs.length, 0, scenario);
  }
});

test('a host pause while a sync response is in flight cannot be undone by that response', async () => {
  const host = await runningGuestHost();
  const commandEpoch = host.epoch;
  let release;
  host.backend.respond = () => new Promise(resolve => { release = resolve; });
  const syncing = host.syncHost();
  host.engine.pause('Fixture host pause');
  const now = Date.now();
  release({ best: 0, guestConnected: true, commandSeq: 1, serverNow: now, command: validCommand({ percent: 100, epoch: commandEpoch, at: now }) });
  await syncing;
  assert.equal(host.engine.phase, 'paused');
  assert.equal(host.engine.outputPercent, 0);
  assert.equal(host.drivers.lush.outputs.length, 0);
});

test('reconnection alone never resumes a faulted guest session', async () => {
  const host = await runningGuestHost();
  host.remoteFault('Fixture disconnect');
  host.backend.respond = () => {
    const now = Date.now();
    return { best: 0, guestConnected: true, commandSeq: 1, serverNow: now, command: validCommand({ percent: 100, epoch: host.epoch, at: now }) };
  };
  await host.syncHost();
  assert.equal(host.engine.phase, 'fault');
  assert.equal(host.engine.outputPercent, 0);
  assert.equal(host.drivers.lush.outputs.length, 0);
});

test('the first record announcement survives server sanitization and a guest refresh', async () => {
  const now = Date.now();
  const result = publicSession(fixtureSession({
    state: { phase: 'cooldown', edgeCount: 1, newRecord: true, epoch: 2 },
    state_at: new Date(now).toISOString(),
  }), 1, now);
  assert.equal(result.state.newRecord, true);
  for (let refresh = 0; refresh < 2; refresh++) {
    const host = await makeHostHarness();
    host.setState({ guest: { clientId: 'a'.repeat(32), clientSeq: 0, sessionId }, guestBest: 0 });
    host.applyGuestState(result);
    assert.equal(host.guestNewRecord, true, 'a first count of one must announce its record, including after refresh');
    host.applyGuestState(publicSession(fixtureSession({ state: { phase: 'running', edgeCount: 0, newRecord: false } }), 1));
    assert.equal(host.guestNewRecord, false, 'a new game must clear the prior record announcement');
  }
});

test('re-unlock demotes and pauses the old session before verifying the new password', async () => {
  const host = await runningGuestHost();
  host.engine.setGuestOutput({ percent: 75 });
  const newOwnerToken = 'c'.repeat(64);
  host.backend.unlock = async () => {
    assert.equal(host.remote.owned, false, 'old ownership must be removed before the authentication request');
    assert.equal(host.engine.phase, 'paused');
    assert.equal(host.engine.outputPercent, 0);
    host.backend.ownerToken = newOwnerToken;
    return { token: newOwnerToken, best: 0 };
  };
  host.backend.respond = action => {
    assert.equal(action, 'owner-status');
    return { activeSessionId: sessionId, best: 0 };
  };
  await host.unlock('public-reunlock-fixture-only');
  assert.equal(host.remote.sessionId, sessionId);
  assert.equal(host.remote.owned, false);
  assert.equal(host.remote.url, 'https://ctmp.uk/ABCDEF');
  assert.equal(host.engine.phase, 'paused');
  const callCount = host.backend.calls.length;
  await host.syncHost();
  assert.equal(host.backend.calls.length, callCount, 'a new token must not publish into the old token-owned session');
});

test('a failed re-unlock leaves the old session paused and end-only', async () => {
  const host = await runningGuestHost();
  host.engine.setGuestOutput({ percent: 75 });
  host.backend.unlock = async () => { throw new Error('Deliberate fixture authentication failure'); };
  await assert.rejects(host.unlock('public-wrong-fixture'), /fixture authentication failure/);
  assert.equal(host.remote.owned, false);
  assert.equal(host.remote.sessionId, sessionId);
  assert.equal(host.engine.phase, 'paused');
  assert.equal(host.engine.outputPercent, 0);
  await host.syncHost();
  assert.equal(host.backend.calls.length, 0);
});

test('End revokes the server link without waiting for a slow physical acknowledgement', async () => {
  const host = await runningGuestHost();
  let releaseStop;
  const pendingStop = new Promise(resolve => { releaseStop = resolve; });
  host.drivers.lush.stop = () => { host.drivers.lush.stops++; return pendingStop; };
  host.backend.respond = action => {
    assert.equal(action, 'session-end');
    return { ok: true };
  };
  const ending = host.endRemote();
  try {
    assert.ok(host.backend.calls.some(call => call.action === 'session-end'), 'revocation must start while the physical stop is pending');
    // Let the cross-realm async REST continuation run, while retaining the
    // deliberately unresolved hardware acknowledgement.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(host.remote, null, 'server revocation must clear the active link before hardware acknowledgement');
    assert.equal(host.engine.outputPercent, 0);
  } finally {
    releaseStop();
    await ending;
  }
});

test('solo VacuGlide faults immediately on offline and never resumes merely on online', async () => {
  const host = await makeHostHarness();
  host.drivers.vacuglide.connected = true;
  host.engine.configure({ mode: 'solo', toy: 'vacuglide', threshold: 23, resetThreshold: 21.5 });
  host.engine.updatePressure(21);
  host.engine.start();
  assert.equal(host.engine.phase, 'running');
  const stopsBefore = host.drivers.vacuglide.stops;
  host.dispatchWindow('offline');
  assert.equal(host.engine.phase, 'fault');
  assert.equal(host.engine.outputPercent, 0);
  assert.ok(host.drivers.vacuglide.stops > stopsBefore);
  host.dispatchWindow('online');
  assert.equal(host.engine.phase, 'fault');
  assert.equal(host.engine.outputPercent, 0);
});

test('all twelve built-in diagnostic checks pass without hardware', () => {
  const checks = runDiagnostics();
  assert.equal(checks.length, 12);
  for (const check of checks) assert.equal(check.passed, true, `${check.name}: ${check.message || ''}`);
});
