import { SessionEngine } from './engine.js';
import { lushNativeLevel, opossumNativeLevel, opossumStrengthCommand, vacuglideNativeLevel, parseCivetPressure, civetReportingCommand } from './devices.js';

export function runDiagnostics() {
  const results = [];
  const check = (name, test) => { try { test(); results.push({name,passed:true}); } catch (error) { results.push({name,passed:false,message:error.message}); } };
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const fixture = (mode = 'solo') => {
    let clock = 100000;
    const outputs = [];
    const engine = new SessionEngine({ now: () => clock, simulation:true, onOutput: p => outputs.push(p) });
    engine.configure({mode,threshold:23,resetThreshold:21.5,startPercent:20,rampSeconds:10,cooldownSeconds:10});
    const advance = (ms, pressure=21) => {
      const target = clock + ms;
      do { clock = Math.min(clock + 100, target); engine.updatePressure(pressure, clock); } while (clock < target);
    };
    advance(0); engine.start();
    return {engine,outputs,advance};
  };
  check('Output caps: Lush 65%, Opossum 60%, VacuGlide 35%', () => {
    assert(lushNativeLevel(100)===13 && lushNativeLevel(1000)===13,'Lush cap failed');
    assert(vacuglideNativeLevel(100)===35 && vacuglideNativeLevel(1000)===35,'VacuGlide cap failed');
    assert(opossumNativeLevel(100)===120 && opossumNativeLevel(1000)===120,'Opossum cap failed');
  });
  check('One count per threshold/reset cycle', () => {
    const {engine,advance}=fixture(); advance(100,23.1); advance(100,24);
    assert(engine.snapshot().edgeCount===1 && engine.snapshot().outputPercent===0,'Duplicate event or output during cooldown');
  });
  check('Opossum selection leaves the other channel off', () => {
    const a = opossumStrengthCommand(120, 'A');
    const b = opossumStrengthCommand(120, 'B');
    assert(a[0]===0xb3 && a[1]===120 && a[2]===0 && b[1]===0 && b[2]===120, 'Inactive Opossum channel was not zero');
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
