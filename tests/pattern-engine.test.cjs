const {test}=require('node:test');
const assert=require('node:assert/strict');
const PatternEngine=require('../pattern-engine.js');
function fixture(t,options={}){
  t.mock.timers.enable({apis:['setTimeout']});
  let now=0,allowed=true;const writes=[],states=[];
  const engine=new PatternEngine({write:async(level,valid)=>{if(valid())writes.push({level,at:now})},now:()=>now,allowed:()=>allowed,onState:s=>states.push(s),...options});
  async function advance(ms){for(let i=0;i<ms;i+=10){now+=Math.min(10,ms-i);t.mock.timers.tick(Math.min(10,ms-i));for(let j=0;j<8;j++)await Promise.resolve()}}
  return {engine,writes,states,advance,setAllowed:value=>allowed=value};
}
for(const [command,peak] of [['20',4],['40',8],['60',12],['70',14]])test('fixed '+command+' preserves peak and 500/4000/500ms envelope',async t=>{
  const f=fixture(t);await f.engine.fixed(command,'fixed');await f.advance(5100);
  assert.equal(Math.max(...f.writes.map(w=>w.level)),peak);
  assert.equal(f.writes.find(w=>w.at===500).level,peak);
  assert.ok(f.writes.filter(w=>w.at>=500&&w.at<=4500).every(w=>w.level===peak));
  assert.ok(f.writes.some(w=>w.at>4500&&w.at<5000&&w.level<peak));
  assert.deepEqual(f.writes.at(-1),{level:0,at:5000});
});
test('Stop cancels ramp and never ramps down',async t=>{
  const f=fixture(t);await f.engine.fixed('70','fixed');await f.advance(250);await f.engine.stop();const count=f.writes.length;
  assert.deepEqual(f.writes.at(-1),{level:0,at:250});await f.advance(6000);assert.equal(f.writes.length,count);
});
test('replacement cancels earlier ramp and its expiry',async t=>{
  const f=fixture(t);await f.engine.fixed('70','old');await f.advance(700);await f.engine.fixed('20','new');await f.advance(5100);
  assert.ok(f.writes.filter(w=>w.at>700).every(w=>w.level<=4));assert.equal(f.writes.at(-1).at,5700);
});
test('dead-man stops at 1200 ms without a release message',async t=>{
  const f=fixture(t,{random:()=>.999999});await f.engine.hold('hold',1200);await f.advance(1500);
  assert.equal(Math.max(...f.writes.map(w=>w.level)),14);assert.deepEqual(f.writes.at(-1),{level:0,at:1200});assert.equal(f.engine.active,null);
});
test('heartbeat sustains only the current hold and cannot restart stopped hold',async t=>{
  const f=fixture(t);await f.engine.hold('hold',1200);await f.advance(900);f.engine.heartbeat('other',6000);f.engine.heartbeat('hold',2100);await f.advance(800);assert.equal(f.engine.active.id,'hold');await f.engine.stop();f.engine.heartbeat('hold',10000);const count=f.writes.length;await f.advance(4000);assert.equal(f.writes.length,count);
});
test('MAX hold stays at level 14 and uses the same dead-man stop',async t=>{
  const f=fixture(t);await f.engine.hold('max-hold',1200,'max-hold');await f.advance(1500);
  assert.ok(f.writes.some(w=>w.level===14));assert.ok(f.writes.every(w=>[0,14].includes(w.level)));
  assert.deepEqual(f.writes.at(-1),{level:0,at:1200});assert.equal(f.engine.active,null);
});
test('EDGE permission gate blocks fixed and both hold modes',async t=>{
  const f=fixture(t);await f.engine.hold('hold',10000);f.setAllowed(false);await f.advance(100);assert.equal(f.writes.at(-1).level,0);const count=f.writes.length;await f.engine.fixed('70','blocked');await f.engine.hold('blocked',20000);await f.advance(500);assert.equal(f.writes.length,count);
  await f.engine.hold('blocked-max',20000,'max-hold');await f.advance(500);assert.equal(f.writes.length,count);
});
test('random includes zero and fresh host random values while bounded',async t=>{
  let calls=0;const values=[0,0,.99999,0,.5,0];const f=fixture(t,{random:()=>values[calls++%values.length]});await f.engine.hold('hold',1200);await f.advance(1000);
  assert.ok(f.writes.some(w=>w.level===0));assert.ok(f.writes.some(w=>w.level===14));assert.ok(f.writes.some(w=>w.level===7));assert.ok(f.writes.every(w=>w.level>=0&&w.level<=14));
});
test('Stop invalidates a positive write waiting behind Bluetooth operation',async t=>{
  const writes=[];let unblock;let blocked=true;
  const f=fixture(t,{write:async(level,valid)=>{if(level>0&&blocked){blocked=false;await new Promise(r=>unblock=r)}if(valid())writes.push(level)}});
  await f.engine.fixed('70','old');await f.advance(100);await f.engine.stop();unblock();await f.advance(6000);assert.ok(writes.every(level=>level===0));
});
