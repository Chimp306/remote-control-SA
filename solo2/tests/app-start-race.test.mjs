import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the actual page coordination functions with a deferred hardware stop.
// Hardware/DOM are replaced; session-start ordering is the production code.
const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const coordination = source.slice(source.indexOf('function halt('), source.indexOf('async function requestWakeLock('));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve=r; }); return {promise,resolve}; };
function harness(initialStop, nextStop = Promise.resolve()) {
  const messages=[];
  let connected=true, stops=0;
  const context={
    initialStop, nextStop, Date, console,
    send:message=>messages.push(message),
    devices:{connected:()=>connected,stopAll:()=>{stops++;return nextStop;}},
    showNotice:()=>{},report:()=>{},releaseWakeLock:()=>{},renderSession:()=>{},drawCharts:()=>{},toast:()=>{},requestWakeLock:()=>{},
  };
  const api=vm.runInNewContext(`
    let stopPromise=initialStop, starting=false, startRequest=0;
    let wanted=false,held=false,epoch=0,demo=null,switching=false,workerReady=true;
    let pressure=19.8,pressureAt=Date.now(),lastClock=0;
    const settings={toy:'opossum',civetEnabled:false,pattern:{opossum:'random'},includes:{opossum:['chase']}};
    let snapshot={state:'idle',output:{a:0,b:0},elapsedMs:0};
    ${coordination}
    ({start,halt,fault,state:()=>({wanted,starting,epoch,state:snapshot.state})});
  `,context);
  return {...api,messages,stopCount:()=>stops,disconnect:()=>{connected=false;}};
}

test('Stop cancels an earlier Start waiting for physical zero',async()=>{
  const zero=deferred(), app=harness(zero.promise);
  const start=app.start();
  assert.equal(app.state().starting,true);
  await app.halt('',{quiet:true});
  zero.resolve();
  assert.equal(await start,false);
  assert.equal(app.state().wanted,false);
  assert.equal(app.messages.filter(m=>m.type==='start').length,0);
});

test('repeated Start clicks only dispatch one session',async()=>{
  const zero=deferred(), app=harness(zero.promise);
  const first=app.start();
  assert.equal(await app.start(),false);
  zero.resolve();
  assert.equal(await first,true);
  assert.equal(app.messages.filter(m=>m.type==='start').length,1);
});

test('required connections are checked again after a delayed stop',async()=>{
  const zero=deferred(), app=harness(zero.promise);
  const start=app.start();app.disconnect();zero.resolve();
  assert.equal(await start,false);
  assert.equal(app.messages.filter(m=>m.type==='start').length,0);
});

test('a canceled Start cannot clear the pending state of a newer Start',async()=>{
  const oldZero=deferred(),newZero=deferred(),app=harness(oldZero.promise,newZero.promise);
  const oldStart=app.start();const stopping=app.halt('',{quiet:true});const newStart=app.start();
  oldZero.resolve();assert.equal(await oldStart,false);
  assert.equal(app.state().starting,true);
  newZero.resolve();await stopping;
  assert.equal(await newStart,true);
  assert.equal(app.messages.filter(m=>m.type==='start').length,1);
});

test('a confirmed fresh zero recovers a previously rejected Stop',async()=>{
  const freshZero=deferred(),app=harness(Promise.reject(new Error('Old link failed')),freshZero.promise);
  const start=app.start();
  await new Promise(setImmediate);
  assert.equal(app.stopCount(),1);
  assert.equal(app.messages.filter(m=>m.type==='start').length,0);
  freshZero.resolve();
  assert.equal(await start,true);
  assert.equal(app.messages.filter(m=>m.type==='start').length,1);
});

test('Stop still cancels Start while a recovery zero is pending',async()=>{
  const freshZero=deferred(),app=harness(Promise.reject(new Error('Old link failed')),freshZero.promise);
  const start=app.start();
  await new Promise(setImmediate);
  assert.equal(app.stopCount(),1);
  const stopping=app.halt('',{quiet:true});
  freshZero.resolve();await stopping;
  assert.equal(await start,false);
  assert.equal(app.messages.filter(m=>m.type==='start').length,0);
});
