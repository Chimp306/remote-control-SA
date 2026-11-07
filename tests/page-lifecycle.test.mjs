import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { lifecycleDecision } from '../app/page-lifecycle.js';
import { PlayTimer } from '../app/play-timer.js';

test('a hidden tab continues and freeze, pagehide, or a blind resume stops', () => {
  assert.equal(lifecycleDecision({ type: 'visibilitychange' }), 'continue');
  assert.equal(lifecycleDecision({ type: 'visibilitychange', stillRunning: true }), 'continue');
  assert.equal(lifecycleDecision({ type: 'resume', stillRunning: false }), 'continue');
  assert.equal(lifecycleDecision({ type: 'freeze' }), 'stop');
  assert.equal(lifecycleDecision({ type: 'pagehide' }), 'stop');
  assert.equal(lifecycleDecision({ type: 'resume', stillRunning: true }), 'stop');
});

test('explicit pause freezes the play timer and a running gap still counts', () => {
  const timer = new PlayTimer();
  timer.sync('running', 0);
  assert.equal(timer.displayMs(5_000), 5_000);
  timer.sync('paused', 5_000);
  assert.equal(timer.displayMs(20_000), 5_000);
  timer.sync('running', 20_000);
  assert.equal(timer.displayMs(22_000), 7_000);
  timer.sync('cooldown', 22_000);
  assert.equal(timer.displayMs(24_000), 9_000);
  timer.sync('stopped', 24_000);
  assert.equal(timer.displayMs(30_000), 9_000);
});

test('both live hosts stop only for freeze and pagehide', () => {
  const root = fs.readFileSync(new URL('../app/simple-player.js', import.meta.url), 'utf8');
  const suc = fs.readFileSync(new URL('../suc/index.html', import.meta.url), 'utf8');
  assert.match(root, /lifecycleDecision/);
  assert.match(suc, /lifecycleDecision/);
  assert.doesNotMatch(root, /Page hidden\. Output stopped/);
  assert.doesNotMatch(root, /document\.hidden && !testMode/);
  assert.doesNotMatch(suc, /Page hidden\. Resume explicitly/);
  assert.match(root, /addEventListener\('freeze'/);
  assert.match(root, /addEventListener\('pagehide'/);
  assert.match(suc, /addEventListener\('freeze'/);
  assert.match(suc, /addEventListener\('pagehide'/);
});
