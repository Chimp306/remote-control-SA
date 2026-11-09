import test from 'node:test';
import assert from 'node:assert/strict';
import { OPOSSUM_PATTERNS, patternById } from '../solo/patterns.js';
import { cutoffFrom, describeOutput, formatKpa, lushFrame, opossumFrames, parseCivetPressure, vacuglideUrl } from '../solo/protocol.js';
import { createSession, formatClock } from '../solo/session.js';
import { createVacuGlide } from '../solo/vacuglide.js';

test('Civet int16 at bytes 8–9 is kPa with two decimals, so 2042 is 20.42', () => {
  const bytes = new Uint8Array(17);
  bytes[0] = 0xd0;
  bytes[8] = 0xfa;
  bytes[9] = 0x07;
  assert.equal(parseCivetPressure(bytes), 20.42);
  assert.equal(formatKpa(parseCivetPressure(bytes)), '20.42');
  assert.equal(formatKpa(0.19), '0.19');
});

test('cutoff sits halfway between the half and full readings', () => {
  assert.equal(cutoffFrom(20.28, 20.55), 20.42);
  assert.equal(cutoffFrom(12, 20), 16);
  assert.equal(cutoffFrom(Number.NaN, 20), null);
});

test('chase is the old A-then-B bump and the other patterns keep the channels apart', () => {
  const chase = patternById('opossum', 'chase');
  const early = chase.sample(1000);
  const late = chase.sample(3000);
  assert.ok(early.a > 0.99 && early.b === 0);
  assert.ok(late.b > 0.99 && late.a === 0);
  assert.equal(OPOSSUM_PATTERNS.length, 22);
  for (const pattern of OPOSSUM_PATTERNS) {
    let apart = false;
    for (let elapsed = 0; elapsed <= 8000; elapsed += 100) {
      const sample = pattern.sample(elapsed);
      assert.ok(sample.a >= 0 && sample.a <= 1 && sample.b >= 0 && sample.b <= 1);
      if (Math.abs(sample.a - sample.b) > 0.05) apart = true;
    }
    assert.equal(apart, true, pattern.id);
  }
});

test('a cutoff crossing stops output, counts an edge, rests inside the range, then resumes', () => {
  let roll = 0;
  const session = createSession(() => {
    roll += 1;
    return roll === 1 ? 0 : 0.99;
  });
  session.configure({
    toy: 'opossum',
    civet: true,
    cutoff: 20.42,
    restMin: 10,
    restMax: 30,
    mode: 'random',
    include: ['chase', 'static'],
    power: 72,
  });
  session.notePressure(20.1, 0);
  const started = session.start(0);
  assert.equal(started.phase, 'playing');
  assert.equal(started.edges, 0);
  assert.ok(started.channels.a > 0);
  const tripped = session.notePressure(20.5, 1000);
  assert.equal(tripped.tripped, true);
  assert.equal(tripped.edges, 1);
  assert.equal(tripped.phase, 'resting');
  assert.equal(tripped.channels.a, 0);
  assert.equal(tripped.channels.b, 0);
  assert.ok(tripped.restRemainingMs >= 10_000 && tripped.restRemainingMs <= 30_000);
  assert.notEqual(tripped.activePatternId, started.activePatternId);
  const during = session.tick(1000 + tripped.restRemainingMs - 500, 100);
  assert.equal(during.phase, 'resting');
  assert.equal(during.channels.a, 0);
  const resumed = session.tick(1000 + tripped.restRemainingMs, 100);
  assert.equal(resumed.phase, 'playing');
  assert.ok(resumed.channels.a > 0 || resumed.channels.b > 0);
  assert.equal(resumed.edges, 1);
  const held = session.notePressure(20.8, 1000 + tripped.restRemainingMs + 50);
  assert.equal(held.edges, 1);
  session.notePressure(19.9, 5000);
  const again = session.notePressure(21, 6000);
  assert.equal(again.edges, 2);
});

test('stop cuts output immediately and pauses the timer until reset', () => {
  const session = createSession(() => 0);
  session.configure({ toy: 'lush', civet: false, mode: 'steady', power: 80, cutoff: 20 });
  session.start(0);
  const running = session.tick(1500, 100);
  assert.ok(running.durationMs >= 1500);
  assert.ok(running.channels.a > 0);
  const stopped = session.stop(1800);
  assert.equal(stopped.phase, 'idle');
  assert.equal(stopped.running, false);
  assert.equal(stopped.channels.a, 0);
  assert.equal(formatClock(stopped.durationMs), '00:01');
  const later = session.tick(9000, 100);
  assert.equal(later.durationMs, stopped.durationMs);
  session.resetTimer();
  assert.equal(session.tick(9000, 0).durationMs, 0);
});

test('an Opossum pulse gap over 500 ms is a fault and Lush ignores that gap', () => {
  const opossum = createSession(() => 0);
  opossum.configure({ toy: 'opossum', civet: false, mode: 'static', power: 80 });
  opossum.start(0);
  opossum.tick(100, 0);
  const fault = opossum.tick(800, 700);
  assert.match(fault.fault, /500 ms/);
  assert.equal(fault.running, false);
  assert.equal(fault.channels.a, 0);
  const lush = createSession(() => 0);
  lush.configure({ toy: 'lush', civet: false, mode: 'steady', power: 50 });
  lush.start(0);
  lush.tick(100, 0);
  const fine = lush.tick(800, 700);
  assert.equal(fine.fault, '');
  assert.equal(fine.running, true);
});

test('command bytes match the working Civet, Opossum and Lush layouts', () => {
  const frame = opossumFrames(100, 50, 40);
  assert.equal(frame.strength[0], 0xb3);
  assert.equal(frame.strength.length, 3);
  assert.equal(frame.pulse[0], 0xb0);
  assert.equal(frame.pulse.length, 20);
  assert.ok(frame.native.a > 0 && frame.native.b > 0);
  assert.ok(frame.native.a <= 80 && frame.native.b <= 80);
  const quiet = opossumFrames(0, 0, 40);
  assert.deepEqual([...quiet.strength], [0xb3, 0, 0]);
  assert.equal([...quiet.pulse].every((byte) => byte === 0 || byte === 0xb0), true);
  const lush = lushFrame(100, 65);
  assert.equal(lush.native, 13);
  assert.equal(lush.text, 'Vibrate:13;');
  assert.equal(lushFrame(0, 65).text, 'Vibrate:0;');
  assert.equal(describeOutput('vacuglide', { a: 0, b: 0 }, 35), 'PUT /vacuglide/target-speed/stop');
});

test('VacuGlide uses the latency cluster lookup and refuses an unknown cluster', async () => {
  const calls = [];
  const json = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const device = createVacuGlide({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (String(url).endsWith('/vacuglide/connected')) {
        return json({ connected: true, cluster: 'eu-central-1.autoblowapi.com', deviceType: 'vacuglide' });
      }
      return json({ operationalMode: 'TARGET_SPEED_PAUSED' });
    },
  });
  await device.connect('token-value');
  assert.equal(calls[0].url, 'https://latency.autoblowapi.com/vacuglide/connected');
  assert.equal(calls[0].options.headers['x-device-token'], 'token-value');
  await device.setSpeed(100, 35);
  assert.equal(calls.at(-1).url, 'https://eu-central-1.autoblowapi.com/vacuglide/target-speed');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { targetSpeed: 35 });
  await device.nudgeStroke('plus');
  assert.ok(calls.some((call) => call.url.endsWith('/vacuglide/valve/stroke-plus')));
  await device.stop();
  assert.ok(calls.some((call) => call.url.endsWith('/vacuglide/target-speed/stop')));

  const blocked = createVacuGlide({
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
  });
  await assert.rejects(blocked.connect('token-value'), /CORS|blocked/i);

  assert.throws(() => vacuglideUrl('evil.example', '/vacuglide/state'), /Unrecognized/);
});
