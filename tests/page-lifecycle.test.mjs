import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { lifecycleDecision } from '../app/page-lifecycle.js';

test('a hidden tab continues and freeze, pagehide, or a blind resume stops', () => {
  assert.equal(lifecycleDecision({ type: 'visibilitychange' }), 'continue');
  assert.equal(lifecycleDecision({ type: 'visibilitychange', stillRunning: true }), 'continue');
  assert.equal(lifecycleDecision({ type: 'resume', stillRunning: false }), 'continue');
  assert.equal(lifecycleDecision({ type: 'freeze' }), 'stop');
  assert.equal(lifecycleDecision({ type: 'pagehide' }), 'stop');
  assert.equal(lifecycleDecision({ type: 'resume', stillRunning: true }), 'stop');
});

test('SUC still stops only when the page is frozen or leaving, and SOLO does not pause for a tab switch', () => {
  const suc = fs.readFileSync(new URL('../suc/index.html', import.meta.url), 'utf8');
  const solo = fs.readFileSync(new URL('../solo/app.js', import.meta.url), 'utf8');
  assert.match(suc, /lifecycleDecision/);
  assert.match(suc, /addEventListener\('freeze'/);
  assert.match(suc, /addEventListener\('pagehide'/);
  assert.doesNotMatch(suc, /Page hidden\. Resume explicitly/);
  assert.match(solo, /new Worker/);
  assert.match(solo, /clock\.worker\.js/);
  assert.equal(solo.includes('visibilitychange'), false);
  assert.equal(solo.includes('document.hidden'), false);
  assert.match(solo, /addEventListener\('pagehide'/);
});
