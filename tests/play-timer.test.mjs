import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SessionEngine } from '../app/engine.js';
import { PlayTimer, formatPlayDuration } from '../app/play-timer.js';

function fixture(config = {}) {
  let time = 10_000;
  const engine = new SessionEngine({ now: () => time, random: () => 0 });
  engine.configure({
    threshold: 12,
    resetThreshold: 10,
    startPercent: 20,
    rampSeconds: 10,
    recoveryMinSeconds: 5,
    recoveryMaxSeconds: 5,
    adaptiveEnabled: false,
    ...config,
  });
  const timer = new PlayTimer();
  const sync = () => timer.sync(engine.phase, time);
  const sample = (value = 9, advance = 0) => {
    time += advance;
    engine.updatePressure(value);
    return sync();
  };
  const advance = (duration, pressure = 9) => {
    const target = time + duration;
    let shown = sync();
    while (time < target) {
      time = Math.min(target, time + 100);
      engine.updatePressure(pressure);
      shown = sync();
    }
    return shown;
  };
  return { engine, timer, sample, advance, sync, setTime: value => { time = value; }, time: () => time };
}

test('duration formatting is mm:ss until one hour, then h:mm:ss', () => {
  assert.equal(formatPlayDuration(0), '00:00');
  assert.equal(formatPlayDuration(999), '00:00');
  assert.equal(formatPlayDuration(1000), '00:01');
  assert.equal(formatPlayDuration(59_000), '00:59');
  assert.equal(formatPlayDuration(60_000), '01:00');
  assert.equal(formatPlayDuration(3_599_000), '59:59');
  assert.equal(formatPlayDuration(3_600_000), '1:00:00');
  assert.equal(formatPlayDuration(3_661_000), '1:01:01');
  assert.equal(formatPlayDuration(36_000_000), '10:00:00');
  assert.equal(formatPlayDuration(Number.NaN), '00:00');
});

test('repeated syncs at one timestamp do not double-count', () => {
  const timer = new PlayTimer();
  assert.equal(timer.sync('running', 0), 0);
  assert.equal(timer.sync('running', 2500), 2500);
  assert.equal(timer.sync('running', 2500), 2500);
  assert.equal(timer.sync('paused', 2500), 2500);
  assert.equal(timer.sync('paused', 2500), 2500);
  assert.equal(timer.displayMs(9000), 2500);
});

test('a backwards timestamp does not increase elapsed time', () => {
  const timer = new PlayTimer();
  timer.sync('running', 5000);
  assert.equal(timer.sync('running', 4000), 0);
  assert.equal(timer.sync('running', 8000), 3000);
});

test('play and recovery count, settling does not, and pause excludes the gap', () => {
  const timer = new PlayTimer();
  timer.sync('settling', 0);
  assert.equal(timer.sync('settling', 4000), 0);
  timer.sync('running', 4000);
  assert.equal(timer.sync('running', 7000), 3000);
  timer.sync('cooldown', 7000);
  assert.equal(timer.sync('cooldown', 12000), 8000);
  timer.sync('paused', 12000);
  assert.equal(timer.sync('paused', 20000), 8000);
  timer.sync('cooldown', 20000);
  assert.equal(timer.sync('cooldown', 21000), 9000);
  timer.sync('settling', 21000);
  assert.equal(timer.sync('settling', 26000), 9000);
  timer.sync('running', 26000);
  assert.equal(timer.sync('running', 27500), 10500);
});

test('stop keeps the final total and the next session starts at zero', () => {
  const timer = new PlayTimer();
  timer.sync('running', 0);
  timer.sync('stopped', 4500);
  assert.equal(timer.sync('stopped', 15000), 4500);
  timer.reset();
  assert.equal(timer.sync('running', 15000), 0);
  assert.equal(timer.sync('running', 16250), 1250);
});

test('engine lifecycle: play, recovery, pause, resume, stop, restart', () => {
  const { engine, timer, sample, advance, sync } = fixture();
  sample();
  engine.start();
  assert.equal(engine.phase, 'running');
  assert.equal(sync(), 0);
  assert.equal(advance(3000), 3000);

  sample(12);
  assert.equal(engine.phase, 'cooldown');
  assert.equal(engine.edgeCount, 1);
  const duringRecovery = advance(2000, 13);
  assert.equal(engine.phase, 'cooldown');
  assert.equal(duringRecovery, 5000);

  engine.pause('Paused.');
  const frozen = sync();
  assert.equal(frozen, 5000);
  advance(4000, 13);
  assert.equal(engine.phase, 'paused');
  assert.equal(sync(), frozen);

  engine.resume();
  assert.equal(engine.phase, 'cooldown');
  assert.equal(sync(), frozen);
  const afterResume = advance(1000, 13);
  assert.equal(afterResume, frozen + 1000);

  engine.stop();
  const finalMs = sync();
  assert.equal(engine.phase, 'stopped');
  assert.equal(finalMs, frozen + 1000);
  advance(5000, 9);
  assert.equal(sync(), finalMs);
  assert.equal(formatPlayDuration(finalMs), '00:06');

  sample(9);
  engine.start();
  assert.equal(engine.phase, 'running');
  assert.equal(engine.edgeCount, 0);
  timer.reset();
  assert.equal(sync(), 0);
  assert.equal(advance(1500), 1500);
  assert.equal(engine.edgeCount, 0);
});

test('simple player labels the existing count and shows the shared timer', () => {
  const player = fs.readFileSync(new URL('../app/simple-player.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const config = fs.readFileSync(new URL('../app/config.js', import.meta.url), 'utf8');
  assert.match(player, /Orgasms avoided/);
  assert.match(player, /Time being tormented/);
  assert.equal(player.includes('>Edges<'), false);
  assert.match(player, /playTimer\.reset\(\)/);
  assert.match(player, /playTimer\.sync\(engine\.phase/);
  assert.match(player, /id="edge-count"/);
  assert.match(player, /id="play-time"/);
  assert.match(config, /BUILD = '2026\.11\.08-v2\.15'/);
  assert.match(player, /from '\.\/config\.js\?v=20261108-v215'/);
  assert.equal(player.includes('config.js?v=20261107-v214'), false);
  const solo = fs.readFileSync(new URL('../SOLO/index.html', import.meta.url), 'utf8');
  assert.match(solo, /const version = '20261108-v216'/);
  assert.match(solo, /simple-player\.js\?v=\$\{version\}/);
  assert.equal(html.includes('simple-player.js'), false);
  const suc = fs.readFileSync(new URL('../suc/index.html', import.meta.url), 'utf8');
  assert.match(suc, /const VERSION = '1\.4\.10'/);
});
