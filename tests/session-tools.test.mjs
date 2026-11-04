import test from 'node:test';
import assert from 'node:assert/strict';
import { PressureFilter, SessionRecorder } from '../app/session-tools.js';

test('pressure filter rejects one-sample spikes and follows sustained movement', () => {
  const filter = new PressureFilter({ alpha: 0.5, window: 5 });
  for (const value of [20,20,20,20,20]) filter.push(value);
  const spike = filter.push(40);
  assert.ok(spike < 25, 'single spike is strongly suppressed by median stage');
  let value = spike;
  for (let i=0;i<8;i++) value=filter.push(24);
  assert.ok(value > 23 && value <= 24);
});

test('session recorder captures useful cutoff telemetry and exports CSV', () => {
  let now=1000;
  const recorder=new SessionRecorder({now:()=>now});
  recorder.start({toy:'opossum',mode:'solo'});
  now=2000;
  recorder.sample({phase:'running',pressure:22.1,threshold:22.9,resetThreshold:21.6,edgeCount:0,outputPercent:75,outputPercentA:70,outputPercentB:75,recoveryMinSeconds:15,recoveryMaxSeconds:25,adaptiveMultiplier:1,pattern:'alternating',toy:'opossum',mode:'solo'}, {}, true);
  now=2500;
  recorder.event('cutoff',{count:1,power:75,cycleSeconds:1.5,recoverySeconds:20});
  const data=recorder.stop();
  assert.equal(data.runtimeSeconds,1.5);
  assert.equal(data.rows[0].outputA,70);
  assert.match(recorder.toCsv(data),/outputA/);
  assert.match(recorder.toJson(),/"opossum"/);
});

test('session recorder can restore interrupted telemetry as an active recording', () => {
  let now=5000;
  const recorder=new SessionRecorder({now:()=>now});
  const restored=recorder.restore({version:1,startedAt:new Date(1000).toISOString(),meta:{toy:'lush'},rows:[],events:[]});
  assert.equal(restored,true);
  assert.equal(recorder.active,true);
  assert.equal(recorder.runtimeMs,4000);
  assert.equal(recorder.events.at(-1).type,'session-restored');
});
