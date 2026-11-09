import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {SessionEngine} from '../engine.js';
import {OPOSSUM_PATTERNS, LUSH_PATTERNS, choosePattern, samplePattern} from '../patterns.js';

const setup = (patch = {}, random = () => 0) => {
  const engine = new SessionEngine({random, now: () => 0});
  engine.configure({toy: 'opossum', civetEnabled: true, cutoff: 20.5, restMin: 1, restMax: 1, maxPower: 60, pattern: 'static', ...patch}, 0);
  engine.pressure(20, 0);
  return engine;
};

test('22 Opossum recipes and 12 Lush recipes produce bounded, finite levels', () => {
  assert.equal(OPOSSUM_PATTERNS.length, 22);
  assert.equal(LUSH_PATTERNS.length, 12);
  for (const [toy, patterns] of [['opossum', OPOSSUM_PATTERNS], ['lush', LUSH_PATTERNS]]) {
    assert.equal(new Set(patterns.map(p => p.id)).size, patterns.length);
    for (const p of patterns) {
      let differ = false;
      for (let t = 0; t < 20; t += .1) {
        const {a, b} = samplePattern(toy, p.id, t);
        assert.ok(Number.isFinite(a) && a >= 0 && a <= 100, p.id);
        assert.ok(Number.isFinite(b) && b >= 0 && b <= 100, p.id);
        if (a !== b) differ = true;
        if (toy === 'lush') assert.equal(b, 0);
      }
      if (toy === 'opossum') assert.ok(differ, p.id + ' must differentiate A and B');
    }
  }
});

test('Random respects includes, avoids a repeat and handles an empty pool', () => {
  assert.equal(choosePattern('opossum', ['chase', 'echo'], 'chase', () => 0), 'echo');
  assert.equal(choosePattern('lush', ['wave'], 'wave', () => .9), 'wave');
  assert.equal(choosePattern('opossum', [], 'chase'), null);
  assert.equal(choosePattern('opossum', ['not-real'], null), null);
});

test('cutoff stops immediately, increments once, rests, and resumes with no held output', () => {
  const e = setup();
  assert.ok(e.start(0).output.a > 0);
  const cut = e.pressure(20.5, 100);
  assert.equal(cut.state, 'resting');
  assert.equal(cut.edges, 1);
  assert.deepEqual(cut.output, {a: 0, b: 0});
  assert.equal(e.pressure(21, 200).edges, 1);
  assert.equal(e.tick(500).restRemainingMs, 600);
  e.pressure(20, 1000);
  const resume = e.tick(1100);
  assert.equal(resume.state, 'running');
  assert.ok(resume.output.a > 0);
  assert.equal(resume.elapsedMs, 1100);
});

test('rest completion above cutoff waits at zero until release; no repeated edges', () => {
  const e = setup();
  e.start(0); e.pressure(20.8, 100);
  const held = e.tick(1100);
  assert.equal(held.state, 'waiting');
  assert.deepEqual(held.output, {a: 0, b: 0});
  assert.equal(e.pressure(21, 1200).edges, 1);
  const released = e.pressure(20.49, 1300);
  assert.equal(released.state, 'running');
  assert.ok(released.output.a > 0);
  assert.equal(e.pressure(20.5, 1400).edges, 2);
});

test('starting at cutoff never emits positive output or invents an edge', () => {
  const e = setup();
  e.pressure(21, 0);
  const s = e.start(0);
  assert.equal(s.state, 'waiting');
  assert.equal(s.edges, 0);
  assert.deepEqual(s.output, {a: 0, b: 0});
  assert.equal(e.pressure(20, 100).state, 'running');
});

test('Random selects a different included pattern after an edge', () => {
  const e = setup({pattern: 'random', includes: ['chase', 'echo']});
  assert.equal(e.start(0).patternId, 'chase');
  assert.equal(e.pressure(21, 100).patternId, 'echo');
});

test('random rest includes both integer endpoints and normalizes inverted bounds', () => {
  const lo = setup({restMin: 10, restMax: 30}, () => 0);
  lo.start(0); assert.equal(lo.pressure(21, 100).restTotalMs, 10000);
  const hi = setup({restMin: 30, restMax: 10}, () => .999999);
  hi.start(0); assert.equal(hi.pressure(21, 100).restTotalMs, 30000);
});

test('Opossum faults after a >500ms running heartbeat gap; exactly 500ms is allowed', () => {
  const e = setup({civetEnabled: false});
  e.start(0);
  assert.equal(e.tick(500).state, 'running');
  const stopped = e.tick(1001);
  assert.equal(stopped.state, 'fault');
  assert.deepEqual(stopped.output, {a: 0, b: 0});
  assert.match(stopped.reason, /500 ms/);
  assert.equal(e.tick(1200).state, 'fault');
});

test('a pressure or config message cannot bypass a missed heartbeat', () => {
  const pressure = setup(); pressure.start(0);
  assert.equal(pressure.pressure(20, 501).state, 'fault');
  assert.deepEqual(pressure.snapshot(501).output, {a: 0, b: 0});
  const config = setup(); config.start(0);
  assert.equal(config.configure({maxPower: 90}, 501).state, 'fault');
  assert.deepEqual(config.snapshot(501).output, {a: 0, b: 0});
});

test('required sensor must be fresh at Start and throughout every active state', () => {
  const e = setup({toy: 'lush', pattern: 'steady'});
  assert.equal(e.start(1600).state, 'fault');
  e.pressure(20, 1700); assert.equal(e.start(1700).state, 'running');
  assert.equal(e.tick(3201).state, 'fault');
  assert.deepEqual(e.snapshot(3201).output, {a: 0, b: 0});
});

test('Stop is immediate, freezes duration, cancels rest and cannot auto-resume', () => {
  const e = setup();
  e.start(0); e.pressure(21, 100);
  const stopped = e.stop('Stopped', 300);
  assert.equal(stopped.elapsedMs, 300);
  assert.deepEqual(stopped.output, {a: 0, b: 0});
  e.pressure(20, 1000);
  const later = e.tick(2000);
  assert.equal(later.state, 'idle');
  assert.equal(later.elapsedMs, 300);
  assert.equal(later.restRemainingMs, 0);
});

test('configuration changes apply output caps immediately and lower cutoff trips', () => {
  const e = setup();
  e.start(0);
  assert.deepEqual(e.configure({maxPower: 0}, 100).output, {a: 0, b: 0});
  assert.equal(e.configure({cutoff: 19.9}, 200).state, 'resting');
  assert.equal(e.snapshot(200).edges, 1);
});

test('changing device stops a session and an empty Random pool blocks Start', () => {
  const e = setup(); e.start(0);
  assert.equal(e.configure({toy: 'lush', pattern: 'steady'}, 100).state, 'idle');
  e.configure({pattern: 'random', includes: []}, 100);
  assert.equal(e.start(100).state, 'fault');
});

test('Vacuglide works without a pattern or sensor and honors normalized max power', () => {
  const e = setup({toy: 'vacuglide', civetEnabled: false, maxPower: 35});
  assert.deepEqual(e.start(0).output, {a: 35, b: 0});
  assert.equal(e.tick(3000).state, 'running');
});

test('queued sensor readings retain capture age and cannot replace newer samples', () => {
  const e = setup({toy: 'lush', pattern: 'steady', civetEnabled: false});
  e.pressure(20.2, 1000, 900);
  assert.equal(e.pressure(21, 1000, 800).pressure, 20.2);
  assert.equal(e.pressure(21, 3000, 1400).pressure, 20.2);
  assert.equal(e.pressure(21, 3000, 3001).pressure, 20.2);
  e.configure({civetEnabled: true}, 3000);
  assert.equal(e.start(3000).state, 'fault');
});

test('worker epochs reject commands from old sessions and identify clock ticks', async (t) => {
  const url = new URL('../clock.worker.js', import.meta.url).href;
  const worker = new Worker(`
    const {parentPort} = require('node:worker_threads');
    global.self = {postMessage: value => parentPort.postMessage(value)};
    parentPort.on('message', data => self.onmessage({data}));
    import(${JSON.stringify(url)});
  `, {eval: true});
  t.after(() => worker.terminate());
  const next = (predicate) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.off('message', listener); reject(new Error('Worker response timed out')); }, 2000);
    const listener = (message) => {
      if (predicate(message)) { clearTimeout(timer); worker.off('message', listener); resolve(message); }
    };
    worker.on('message', listener);
  });
  const send = async (data, predicate = m => !m.clock) => {
    const pending = next(predicate);
    worker.postMessage(data);
    return pending;
  };
  const initial = await next(m => !m.clock);
  assert.equal(initial.epoch, 0);
  await send({type: 'config', epoch: 0, config: {toy: 'lush', pattern: 'steady', civetEnabled: false, maxPower: 50}});
  assert.equal((await send({type: 'start', epoch: 1})).snapshot.state, 'running');
  assert.equal((await send({type: 'stop', epoch: 2})).snapshot.state, 'idle');
  worker.postMessage({type: 'start', epoch: 1});
  worker.postMessage({type: 'config', epoch: 1, config: {maxPower: 99}});
  worker.postMessage({type: 'pressure', epoch: 1, kpa: 99, at: Date.now()});
  const stopped = await send({type: 'snapshot', epoch: 2});
  assert.equal(stopped.snapshot.state, 'idle');
  assert.equal(stopped.snapshot.pressure, null);
  const restarted = await send({type: 'start', epoch: 3});
  assert.equal(restarted.snapshot.output.a, 50);
  assert.equal(restarted.epoch, 3);
  const stale = await send({type: 'pressure', epoch: 3, kpa: 99, at: Date.now() - 2000});
  assert.equal(stale.snapshot.pressure, null);
  const capturedAt = Date.now();
  await send({type: 'pressure', epoch: 3, kpa: 20, at: capturedAt});
  const older = await send({type: 'pressure', epoch: 3, kpa: 21, at: capturedAt - 1});
  assert.equal(older.snapshot.pressure, 20);
  const periodic = await next(m => m.clock);
  assert.equal(periodic.epoch, 3);
  assert.ok(periodic.sequence > restarted.sequence);
});
