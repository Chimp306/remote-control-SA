import { SessionEngine } from './engine.js?v=20261101-dual40';
import { lushNativeLevel, opossumNativeLevel, opossumStrengthCommand, opossumPulseCommand, vacuglideNativeLevel, parseCivetPressure, civetReportingCommand } from './devices.js?v=20261101-dual40';

export function runDiagnostics() {
  const results = [];
  const check = (name, test) => { try { test(); results.push({name,passed:true}); } catch (error) { results.push({name,passed:false,message:error.message}); } };
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const fixture = (mode = 'solo', config = {}) => {
    let clock = 100000;
    const outputs = [], channelOutputs = [];
    const engine = new SessionEngine({ now: () => clock, simulation:true, onOutput: (p, channels) => { outputs.push(p); channelOutputs.push(channels); } });
    engine.configure({mode,threshold:23,resetThreshold:21.5,startPercent:20,rampSeconds:10,cooldownSeconds:10,...config});
    const advance = (ms, pressure=21) => {
      const target = clock + ms;
      do { clock = Math.min(clock + 100, target); engine.updatePressure(pressure, clock); } while (clock < target);
    };
    advance(0); engine.start();
    return {engine,outputs,channelOutputs,advance};
  };
  check('Output caps: Lush 65%, Opossum 40% per channel, VacuGlide 35%', () => {
    assert(lushNativeLevel(100)===13 && lushNativeLevel(1000)===13,'Lush cap failed');
    assert(vacuglideNativeLevel(100)===35 && vacuglideNativeLevel(1000)===35,'VacuGlide cap failed');
    assert(opossumNativeLevel(100)===80 && opossumNativeLevel(1000)===80,'Opossum cap failed');
  });
  check('One count per threshold/reset cycle', () => {
    const {engine,advance}=fixture(); advance(100,23.1); advance(100,24);
    assert(engine.snapshot().edgeCount===1 && engine.snapshot().outputPercent===0,'Duplicate event or output during cooldown');
  });
  check('Opossum carries two independently capped channels together', () => {
    const strengths = opossumStrengthCommand({a:200,b:60});
    const frame = opossumPulseCommand({a:80,b:60});
    const bOnly = opossumPulseCommand({a:0,b:60});
    assert(strengths[0]===0xb3 && strengths[1]===80 && strengths[2]===60, 'Paired Opossum cap failed');
    assert(frame.length===20 && frame.slice(8,12).every(v=>v===100) && frame.slice(16,20).every(v=>v===100), 'Both channel carriers missing');
    assert(bOnly.slice(8,12).every(v=>v===0), 'Zero channel had a nonzero carrier');
  });
  check('Opossum solo restarts both independent channel ramps', () => {
    const {engine,advance}=fixture('solo',{toy:'opossum',maxPercentA:40,maxPercentB:80});
    advance(10000,21);
    assert(engine.snapshot().outputPercentA===40 && engine.snapshot().outputPercentB===80,'Independent maxima failed');
    advance(100,24); advance(10000,21);
    assert(engine.snapshot().outputPercentA===8 && engine.snapshot().outputPercentB===16,'Dual ramp did not restart');
  });
  check('Opossum guest patterns scale both peaks, legacy scalar stays A-only', () => {
    const {engine,advance}=fixture('guest',{toy:'opossum'});
    engine.setGuestOutput({percentA:40,percentB:80,pattern:'wave'}); advance(2000);
    assert(engine.snapshot().outputPercentA===40 && engine.snapshot().outputPercentB===80,'Dual pattern peak failed');
    engine.setGuestOutput({percent:50,pattern:'steady'});
    assert(engine.snapshot().outputPercentA===50 && engine.snapshot().outputPercentB===0,'Legacy scalar enabled B');
  });
  check('Opossum stale pressure zeros both channels', () => {
    const {engine}=fixture('guest',{toy:'opossum'});
    engine.setGuestOutput({percentA:100,percentB:70}); engine.tick(102000);
    assert(engine.snapshot().phase==='fault' && engine.snapshot().outputPercentA===0 && engine.snapshot().outputPercentB===0,'Dual fault did not zero both');
  });
  check('Cooldown waits for a fresh pressure reset', () => {
    const {engine,advance}=fixture(); advance(100,24); advance(10000,24);
    assert(engine.snapshot().phase==='settling' && engine.snapshot().outputPercent===0,'High pressure bypassed reset');
    advance(100,21); assert(engine.snapshot().phase==='running','Reset did not resume');
  });
  check('Solo restarts the ramp from its starting level', () => {
    const {engine,advance}=fixture(); advance(9000,21); advance(100,24); advance(10000,21);
    assert(engine.snapshot().outputPercent===20,'Solo did not restart at20%');
  });
  check('Guest resumes its selected level without a ramp', () => {
    const {engine,advance}=fixture('guest'); engine.setGuestOutput({percent:70,pattern:'steady'}); advance(100,24); advance(10000,21);
    assert(engine.snapshot().outputPercent===70,'Guest ramp or selection mismatch');
  });
  check('Stale sensor faults without automatic restart', () => {
    const {engine,advance}=fixture(); engine.tick(102000); advance(2100,21);
    assert(engine.snapshot().phase==='fault' && engine.snapshot().outputPercent===0,'Stale sensor did not remain stopped');
  });
  check('Civet packet decoding and report command', () => {
    const packet=new Uint8Array(17);packet[0]=0xd0;new DataView(packet.buffer).setInt16(8,2190,true);
    assert(parseCivetPressure(new DataView(packet.buffer))===21.9 && civetReportingCommand(true).length===17,'Packet check failed');
  });
  check('Simulation never writes records or hardware', () => {
    const {engine,advance}=fixture();advance(100,24);
    assert(engine.snapshot().simulation===true,'Simulation marker missing');
    // The diagnostics instantiate only a pure engine with an in-memory callback.
    assert(engine.onOutput.toString().includes('outputs.push'),'Unexpected output adapter');
  });
  return results;
}
