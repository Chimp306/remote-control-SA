import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { commandFromLine, createGrokAdapter, createMockTransport, createSupabaseTransport } from '../scripts/grok-adapter.mjs';

test('the adapter sends the next command from the live state and records the ack', async () => {
  const transport = createMockTransport();
  const lines = [];
  const adapter = createGrokAdapter({ transport, now: () => 5_000, log: line => lines.push(line) });
  await adapter.attach();
  transport.emitState({ v: 1, type: 'state', sessionId: 'session-1', epoch: 4, armed: true, phase: 'idle' });
  transport.emitEvent({ v: 1, type: 'event', event: 'edge', id: 'e', at: 5_000, sessionId: 'session-1', epoch: 4, edgeCount: 2, phase: 'cooldown' });
  const sent = await adapter.command('pause');
  assert.equal(sent.envelope.seq, 1);
  assert.equal(sent.envelope.sessionId, 'session-1');
  assert.equal(sent.envelope.epoch, 4);
  assert.equal(sent.envelope.expiresAt - sent.envelope.issuedAt, 5000);
  assert.equal(adapter.acks()[0].hardware, 'not-confirmed');
  assert.equal(adapter.events()[0].event, 'edge');
  transport.emitState({ v: 1, type: 'state', sessionId: 'session-2', epoch: 1, armed: true, phase: 'idle' });
  const next = await adapter.command('stop');
  assert.equal(next.envelope.seq, 1);
  assert.equal(next.envelope.sessionId, 'session-2');
  assert.equal(JSON.stringify(lines).includes('service_role'), false);
});

test('stdin commands are bounded and the service role never opens a client', async () => {
  assert.deepEqual(commandFromLine('{"command":"pause"}'), { command: 'pause', params: {} });
  assert.deepEqual(commandFromLine('{"command":"changePattern","params":{"pattern":"sine-wave"}}').params.pattern, 'sine-wave');
  assert.throws(() => commandFromLine('{"command":"custom"}'), /Unknown command/);
  assert.throws(() => commandFromLine('not json'), /not understood/);
  const token = `h.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.s`;
  await assert.rejects(
    () => createSupabaseTransport({ url: 'https://example.supabase.co', key: 'publishable', accessToken: token }),
    /service role/i,
  );
});

test('the dry-run client sends a command and prints the ack without credentials', async () => {
  const child = spawn(process.execPath, ['scripts/grok-control-client.mjs'], {
    env: { ...process.env, GROK_DRY_RUN: '1' },
    cwd: fileURLToPath(new URL('..', import.meta.url)),
  });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { out += chunk; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 0);
  assert.match(out, /"type":"send"/);
  assert.match(out, /"type":"ack"/);
  assert.match(out, /"hardware":"not-confirmed"/);
  assert.equal(out.includes('GROK_OWNER_ACCESS_TOKEN'), false);
  assert.equal(out.includes('service_role'), false);
});
