import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionEngine, SENSOR_FRESH_MS } from '../app/engine.js';

function fixture(options = {}) {
  let time = 0;
  const outputs = [], events = [];
  const engine = new SessionEngine({
    now: () => time,
    onOutput: value => { outputs.push(value); return options.output?.(value); },
    onEvent: event => events.push(event),
    simulation: options.simulation,
  });
  engine.configure({ threshold: 12, resetThreshold: 10, startPercent: 20, rampSeconds: 10, cooldownSeconds: 10, ...options.config });
  const sample = (value = 9, advance = 0) => { time += advance; return engine.updatePressure(value); };
  const advance = (duration, pressure = 9) => {
    const target = time + duration;
    while (time < target) { time = Math.min(target, time + 100); engine.updatePressure(pressure); }
    return engine.snapshot();
  };
  return { engine, outputs, events, sample, advance, setTime: value => { time = value; }, time: () => time };
}

test('idle snapshot has no fabricated pressure or output', () => {
  const { engine, outputs } = fixture();
  assert.equal(engine.snapshot().pressure, null);
  assert.equal(engine.snapshot().pressureAt, null);
  assert.equal(engine.snapshot().outputPercent, 0);
  assert.equal(engine.snapshot().sensorFresh, false);
  assert.deepEqual(outputs, []);
});

test('fresh pressure is required to start, including in simulation', () => {
  for (const simulation of [false, true]) {
    const { engine, outputs } = fixture({ simulation });
    engine.start();
    assert.equal(engine.snapshot().phase, 'fault');
    assert.ok(outputs.every(value => value === 0));
  }
});

test('solo ramp starts at configured level and reaches displayed 100%', () => {
  const { engine, sample, advance } = fixture();
  sample(); engine.start();
  assert.equal(engine.snapshot().phase, 'running');
  assert.equal(engine.snapshot().outputPercent, 20);
  advance(5000);
  assert.equal(engine.snapshot().outputPercent, 60);
  advance(5000);
  assert.equal(engine.snapshot().outputPercent, 100);
  advance(1000);
  assert.equal(engine.snapshot().outputPercent, 100);
});

test('starting above reset waits without counting an event', () => {
  const { engine, sample } = fixture();
  sample(13); engine.start();
  assert.equal(engine.snapshot().phase, 'settling');
  assert.equal(engine.snapshot().edgeCount, 0);
  assert.equal(engine.snapshot().outputPercent, 0);
  sample(10, 100);
  assert.equal(engine.snapshot().phase, 'settling', 'reset comparison is strictly below');
  sample(9.9, 100);
  assert.equal(engine.snapshot().phase, 'running');
});

test('cutoff is inclusive, stops immediately, and counts only once until rearmed', () => {
  const { engine, sample, advance, outputs, events } = fixture();
  sample(); engine.start(); sample(12);
  assert.equal(engine.snapshot().phase, 'cooldown');
  assert.equal(outputs.at(-1), 0);
  assert.equal(engine.snapshot().edgeCount, 1);
  assert.equal(engine.snapshot().remainingCooldown, 10);
  advance(12000, 13);
  assert.equal(engine.snapshot().phase, 'settling');
  assert.equal(engine.snapshot().edgeCount, 1);
  assert.equal(events.filter(event => event.type === 'edge').length, 1);
  sample(9, 100);
  assert.equal(engine.snapshot().phase, 'running');
  sample(12, 100);
  assert.equal(engine.snapshot().edgeCount, 2);
});

test('cooldown expires only after timer and fresh post-deadline low reading', () => {
  const { engine, sample, advance, setTime } = fixture();
  sample(); engine.start(); sample(12);
  advance(9900, 9);
  setTime(10000); engine.tick();
  assert.equal(engine.snapshot().phase, 'settling');
  assert.equal(engine.snapshot().remainingCooldown, 0);
  assert.equal(engine.snapshot().outputPercent, 0);
  sample(9);
  assert.equal(engine.snapshot().phase, 'running');
  assert.equal(engine.snapshot().outputPercent, 20, 'solo ramp restarts after cooldown');
  advance(5000);
  assert.equal(engine.snapshot().outputPercent, 60);
});

test('a high sample at cooldown expiry remains stopped', () => {
  const { engine, sample, advance } = fixture();
  sample(); engine.start(); sample(12);
  advance(10000, 12);
  assert.equal(engine.snapshot().phase, 'settling');
  assert.equal(engine.snapshot().outputPercent, 0);
  sample(10, 100);
  assert.equal(engine.snapshot().phase, 'settling');
  sample(9.9, 100);
  assert.equal(engine.snapshot().phase, 'running');
});

test('guest mode applies manual output without the solo ramp', () => {
  const { engine, sample, advance } = fixture({ config: { mode: 'guest', rampSeconds: 3600 } });
  engine.setGuestOutput({ percent: 80, pattern: 'steady' });
  sample(); engine.start();
  assert.equal(engine.snapshot().outputPercent, 80);
  advance(5000);
  assert.equal(engine.snapshot().outputPercent, 80);
  sample(12);
  engine.setGuestOutput({ percent: 35 });
  assert.equal(engine.snapshot().outputPercent, 0);
  advance(10000);
  assert.equal(engine.snapshot().phase, 'running');
  assert.equal(engine.snapshot().outputPercent, 35);
});

test('guest controls cannot shorten a cooldown already underway', () => {
  const { engine, sample } = fixture({ config: { mode: 'guest', cooldownSeconds: 30 } });
  sample(); engine.start(); sample(12);
  const deadline = engine.snapshot().cooldownEndsAt;
  engine.setGuestOutput({ percent: 100, cooldownSeconds: 10 });
  assert.equal(engine.snapshot().cooldownSeconds, 10);
  assert.equal(engine.snapshot().cooldownEndsAt, deadline);
  assert.equal(engine.snapshot().outputPercent, 0);
});

test('guest patterns use requested percentage as peak and never exceed it', () => {
  for (const pattern of ['steady', 'pulse', 'wave']) {
    const { engine, sample, advance, outputs } = fixture({ config: { mode: 'guest' } });
    engine.setGuestOutput({ percent: 35, pattern });
    sample(); engine.start(); advance(8000);
    assert.ok(outputs.every(value => value >= 0 && value <= 35));
    assert.ok(outputs.includes(35));
    if (pattern !== 'steady') assert.ok(outputs.includes(0));
  }
});

test('VacuGlide does not accept vibration patterns', () => {
  const { engine, sample, advance } = fixture({ config: { toy: 'vacuglide', mode: 'guest' } });
  engine.setGuestOutput({ percent: 80, pattern: 'wave' });
  sample(); engine.start(); advance(1000);
  assert.equal(engine.snapshot().pattern, 'steady');
  assert.equal(engine.snapshot().outputPercent, 80);
});

test('Opossum uses the same host-owned guest patterns and solo ramp as Lush', () => {
  const { engine, sample, advance, outputs } = fixture({ config: { toy: 'opossum', mode: 'guest' } });
  engine.setGuestOutput({ percent: 70, pattern: 'wave' });
  sample(); engine.start(); advance(2000);
  assert.equal(engine.snapshot().pattern, 'wave');
  assert.equal(engine.snapshot().outputPercent, 70);
  assert.ok(outputs.every(value => value <= 70));
  sample(12); advance(10000);
  assert.equal(engine.snapshot().phase, 'running');
  assert.equal(engine.snapshot().outputPercent, 0);
  engine.pause(); engine.configure({ mode: 'solo' }); engine.resume();
  assert.equal(engine.snapshot().outputPercent, 20);
});

test('all requested output is clamped and invalid guest messages are atomic', () => {
  const { engine, sample } = fixture({ config: { mode: 'guest' } });
  engine.setGuestOutput({ percent: 1000, cooldownSeconds: 100 });
  sample(); engine.start();
  assert.equal(engine.snapshot().guestPercent, 100);
  assert.equal(engine.snapshot().cooldownSeconds, 30);
  assert.equal(engine.snapshot().outputPercent, 100);
  assert.throws(() => engine.setGuestOutput({ percent: 10, pattern: 'unbounded' }));
  assert.equal(engine.snapshot().guestPercent, 100);
  assert.throws(() => engine.setGuestOutput({ percent: NaN }));
  engine.setGuestOutput({ percent: -10, cooldownSeconds: 1 });
  assert.equal(engine.snapshot().outputPercent, 0);
  assert.equal(engine.snapshot().cooldownSeconds, 10);
});

test('lowering cutoff by 0.1 is applied immediately and avoids decimal drift', () => {
  const { engine, sample } = fixture();
  sample(); engine.start(); sample(11.9, 100);
  engine.adjustCutoff(-0.1);
  assert.equal(engine.snapshot().threshold, 11.9);
  assert.equal(engine.snapshot().phase, 'cooldown');
  for (let i = 0; i < 10; i++) engine.adjustCutoff(0.1);
  assert.equal(engine.snapshot().threshold, 12.9);
  assert.equal(engine.snapshot().edgeCount, 1);
  engine.setCutoff(9.5);
  assert.equal(engine.snapshot().resetThreshold, 9.4);
});

test('stale pressure faults and fresh input alone never restarts', () => {
  const { engine, sample, setTime, outputs } = fixture();
  sample(); engine.start(); sample(12);
  setTime(SENSOR_FRESH_MS + 1); engine.tick();
  assert.equal(engine.snapshot().phase, 'fault');
  assert.equal(outputs.at(-1), 0);
  sample(9);
  engine.setGuestOutput({ percent: 100 }); engine.tick();
  assert.equal(engine.snapshot().phase, 'fault');
  assert.equal(engine.snapshot().edgeCount, 1);
  engine.resume();
  assert.equal(engine.snapshot().phase, 'running');
  assert.equal(engine.snapshot().edgeCount, 1);
});

test('first packet after a long gap faults even if it arrives before tick', () => {
  const { engine, sample } = fixture();
  sample(); engine.start();
  sample(9, SENSOR_FRESH_MS + 1);
  assert.equal(engine.snapshot().phase, 'fault');
  assert.equal(engine.snapshot().sensorFresh, true);
  engine.resume();
  assert.equal(engine.snapshot().phase, 'running');
});

test('fault resume requires low pressure and is always explicit', () => {
  const { engine, sample } = fixture();
  sample(); engine.start(); engine.fault('Disconnected');
  sample(12); engine.resume();
  assert.equal(engine.snapshot().phase, 'fault');
  sample(9);
  assert.equal(engine.snapshot().phase, 'fault');
  engine.resume();
  assert.equal(engine.snapshot().phase, 'running');
});

test('pause stops and resume restarts ramp while preserving count', () => {
  const { engine, sample, advance, outputs } = fixture();
  sample(); engine.start(); advance(5000);
  engine.pause('Host hidden');
  assert.equal(engine.snapshot().phase, 'paused');
  assert.equal(outputs.at(-1), 0);
  advance(5000);
  engine.resume();
  assert.equal(engine.snapshot().phase, 'running');
  assert.equal(engine.snapshot().outputPercent, 20);
});

test('pause during cooldown preserves remaining duration', () => {
  const { engine, sample, advance } = fixture();
  sample(); engine.start(); sample(12); advance(3000);
  engine.pause();
  assert.equal(engine.snapshot().remainingCooldown, 7);
  advance(10000);
  engine.resume();
  assert.equal(engine.snapshot().phase, 'cooldown');
  assert.equal(engine.snapshot().remainingCooldown, 7);
  advance(7000);
  assert.equal(engine.snapshot().phase, 'running');
  assert.equal(engine.snapshot().edgeCount, 1);
});

test('stop never auto-restarts, explicit new start resets count', () => {
  const { engine, sample, advance } = fixture();
  sample(); engine.start(); sample(12); engine.stop();
  advance(20000);
  assert.equal(engine.snapshot().phase, 'stopped');
  assert.equal(engine.snapshot().edgeCount, 1);
  engine.resume();
  assert.equal(engine.snapshot().phase, 'stopped');
  engine.start();
  assert.equal(engine.snapshot().edgeCount, 0);
  assert.equal(engine.snapshot().phase, 'running');
});

test('invalid and out-of-order readings cannot masquerade as live data', () => {
  const { engine, sample, setTime } = fixture();
  sample(); engine.start(); sample(9, 500);
  engine.updatePressure(50, 100);
  assert.equal(engine.snapshot().pressure, 9);
  engine.updatePressure(50, 10000);
  assert.equal(engine.snapshot().pressure, 9);
  engine.updatePressure(Infinity);
  assert.equal(engine.snapshot().phase, 'fault');
  sample(9); engine.resume();
  setTime(499); engine.tick();
  assert.equal(engine.snapshot().phase, 'fault');
});

test('device promise rejection faults and requests zero; stop rejection is not silent', async () => {
  let rejectPositive;
  const { engine, sample, outputs } = fixture({ output: value => value > 0 ? new Promise((_, reject) => { rejectPositive = reject; }) : undefined });
  sample(); engine.start(); rejectPositive(new Error('write failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine.snapshot().phase, 'fault');
  assert.equal(outputs.at(-1), 0);
  const broken = fixture({ output: () => { throw new Error('offline'); } });
  broken.sample(); broken.engine.start();
  assert.equal(broken.engine.snapshot().phase, 'fault');
  assert.match(broken.engine.snapshot().reason, /Stop could not be confirmed/);
});

test('late failure from a prior session cannot fault a later explicit session', async () => {
  let rejectOld;
  let first = true;
  const { engine, sample } = fixture({ output: value => {
    if (value && first) { first = false; return new Promise((_, reject) => { rejectOld = reject; }); }
  } });
  sample(); engine.start(); engine.stop(); engine.start();
  rejectOld(new Error('old transport'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine.snapshot().phase, 'running');
});

test('changing active mode/device is rejected and configuration validates reset gap', () => {
  const { engine, sample } = fixture();
  sample(); engine.start();
  assert.throws(() => engine.configure({ toy: 'vacuglide' }));
  assert.throws(() => engine.configure({ mode: 'guest' }));
  assert.throws(() => engine.configure({ resetThreshold: 12 }));
  assert.throws(() => engine.configure({ rampSeconds: NaN }));
  assert.throws(() => engine.configure({ threshold: Number.MAX_VALUE }));
  assert.throws(() => engine.setCutoff(Number.MAX_VALUE));
  engine.pause(); engine.configure({ mode: 'guest' });
  assert.equal(engine.snapshot().mode, 'guest');
});
