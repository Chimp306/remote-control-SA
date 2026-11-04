import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFinishReport } from '../app/finish-report.js';

test('finish report calculates measured session statistics without changing a record', () => {
  const data = {
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(120000).toISOString(),
    runtimeSeconds: 120,
    events: [
      { type:'cutoff', at:new Date(25000).toISOString(), cycleSeconds:12 },
      { type:'cutoff', at:new Date(100000).toISOString(), cycleSeconds:30 },
      { type:'orgasm-reported', at:new Date(120000).toISOString() },
    ],
  };
  const state = { edgeCount: 2 };
  const report = buildFinishReport({data,state,best:137,simulation:false});
  assert.equal(report.outcome,'orgasm');
  assert.equal(report.durationSeconds,120);
  assert.equal(report.timeSinceLastEdgeSeconds,20);
  assert.equal(report.count,2);
  assert.equal(report.personalBest,137);
  assert.equal(report.longestCycleSeconds,30);
  assert.equal(report.averageCycleSeconds,21);
  assert.equal(report.cutoffEvents,2);
  assert.equal(state.edgeCount,2);
  assert.equal(data.events.length,3);
});

test('finish report supports a zero-edge session without fake timing', () => {
  const data={startedAt:new Date(0).toISOString(),endedAt:new Date(1000).toISOString(),runtimeSeconds:1,events:[]};
  const report=buildFinishReport({data,state:{edgeCount:0},best:137,simulation:true});
  assert.equal(report.count,0);
  assert.equal(report.personalBest,137);
  assert.equal(report.timeSinceLastEdgeSeconds,null);
  assert.equal(report.longestCycleSeconds,null);
  assert.equal(report.averageCycleSeconds,null);
  assert.equal(report.simulation,true);
});

test('finish report requires a session event log and ignores malformed cycle lengths', () => {
  assert.throws(()=>buildFinishReport({}), /recorded session/);
  const report=buildFinishReport({
    data:{startedAt:new Date(0).toISOString(),endedAt:new Date(3000).toISOString(),runtimeSeconds:3,events:[
      {type:'cutoff',at:new Date(2000).toISOString(),cycleSeconds:-1},
      {type:'cutoff',at:new Date(2500).toISOString(),cycleSeconds:'oops'},
    ]},
    state:{edgeCount:2},
    best:1
  });
  assert.equal(report.cutoffEvents,2);
  assert.equal(report.longestCycleSeconds,null);
  assert.equal(report.timeSinceLastEdgeSeconds,0.5);
});
