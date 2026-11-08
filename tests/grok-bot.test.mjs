import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handleGrokRequest } from '../supabase/functions/grok-control/bridge.mjs';
import { startGrokTestServer } from '../scripts/grok-test-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

function runBot(args, env) {
  const child = spawn(process.execPath, ['scripts/grok-bot.mjs', ...args], {
    cwd: root,
    env: { ...process.env, ...env },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  return { out: () => out, err: () => err, exited };
}

async function login(started) {
  const response = await fetch(started.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'login', enrollment: started.enrollment }),
  });
  return response.json();
}

test('the bot reads fresh state and waits for an acknowledgement without printing the token', async () => {
  const started = await startGrokTestServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-bot-'));
  const tokenFile = path.join(dir, 'pairing.token');
  const enrollmentFile = path.join(dir, 'enrollment.txt');
  fs.writeFileSync(enrollmentFile, `${started.enrollment}\n`, { mode: 0o600 });
  const pair = spawn(process.execPath, ['scripts/grok-pair.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      GROK_FUNCTION_URL: started.url,
      GROK_PUBLISHABLE_KEY: 'sb_publishable_public',
      GROK_ENROLLMENT_FILE: enrollmentFile,
      GROK_TOKEN_FILE: tokenFile,
    },
  });
  let pairOut = '';
  pair.stdout.on('data', chunk => { pairOut += chunk; });
  const pairCode = await new Promise(resolve => pair.on('exit', resolve));
  assert.equal(pairCode, 0);
  assert.equal(pairOut.includes(started.enrollment), false);
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.equal(token.length, 64);
  assert.equal(pairOut.includes(token), false);
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  const env = {
    GROK_FUNCTION_URL: started.url,
    GROK_PUBLISHABLE_KEY: 'sb_publishable_public',
    GROK_TOKEN_FILE: tokenFile,
    GROK_ACK_WAIT_MS: '4000',
  };
  const publisher = await fetch(started.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'login', refresh: token }),
  }).then(response => response.json());
  const published = await handleGrokRequest({
    body: {
      action: 'sync',
      state: {
        v: 1, type: 'state', sessionId: 'session-bot', epoch: 3, armed: true, phase: 'idle',
        sensorFresh: true, publishedAt: Date.now(), leaseMs: 5000, lastSeq: 4,
      },
    },
    accessToken: publisher.access,
    db: started.db,
  });
  assert.equal(published.status, 200);
  const status = runBot(['status'], env);
  assert.equal(await status.exited, 0);
  assert.match(status.out(), /"stale":false/);
  assert.match(status.out(), /session-bot/);
  assert.equal(status.out().includes(token), false);
  assert.equal(status.err().includes(token), false);
  const sender = runBot(['send', 'stop'], env);
  const seen = Date.now();
  let command = null;
  while (!command && Date.now() - seen < 4000) {
    const queued = await started.db.listCommands(Date.now());
    command = queued.find(item => item.command === 'stop');
    if (!command) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(command?.seq, 5);
  const access = await fetch(started.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'login', refresh: token }),
  }).then(response => response.json());
  await handleGrokRequest({
    body: { action: 'sync', acks: [{ v: 1, type: 'ack', commandId: command.id, accepted: true, applied: true, hardware: 'not-confirmed', reason: '' }] },
    accessToken: access.access,
    db: started.db,
  });
  assert.equal(await sender.exited, 0);
  assert.match(sender.out(), /"applied":true/);
  assert.equal(sender.out().includes(token), false);
  started.server.closeAllConnections?.();
  await new Promise(resolve => started.server.close(resolve));
});

test('a stale page is reported and the token file is required', async () => {
  const started = await startGrokTestServer();
  const signedIn = await login(started);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-bot-stale-'));
  const tokenFile = path.join(dir, 'pairing.token');
  fs.writeFileSync(tokenFile, `${signedIn.refresh}\n`, { mode: 0o600 });
  await handleGrokRequest({
    body: { action: 'sync', state: { v: 1, type: 'state', sessionId: 'old', epoch: 1, armed: true, phase: 'idle', publishedAt: Date.now() - 30_000, leaseMs: 5000 } },
    accessToken: signedIn.access,
    db: started.db,
  });
  const stale = runBot(['status'], { GROK_FUNCTION_URL: started.url, GROK_TOKEN_FILE: tokenFile, GROK_ACK_WAIT_MS: '3000' });
  assert.equal(await stale.exited, 2);
  assert.match(stale.out(), /"stale":true/);
  assert.equal(stale.out().includes(signedIn.refresh), false);
  const missing = runBot(['status'], { GROK_TOKEN_FILE: path.join(dir, 'missing.token') });
  assert.equal(await missing.exited, 1);
  assert.equal(missing.err().includes('missing.token') || missing.err().includes('could not be read'), true);
  started.server.closeAllConnections?.();
  await new Promise(resolve => started.server.close(resolve));
});
