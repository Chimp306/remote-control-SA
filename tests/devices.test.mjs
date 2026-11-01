import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CivetDevice, LushDevice, OpossumDevice, VacuGlideDevice, SerializedCommands,
  CIVET_SERVICE, CIVET_WRITE, CIVET_NOTIFY, LUSH_PROFILES,
  lushNativeLevel, vacuglideNativeLevel, civetReportingCommand,
  civetZeroCommand, parseCivetPressure, opossumNativeLevel,
  opossumStrengthCommand, opossumPulseCommand, opossumDisplayCommand,
} from '../app/devices.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

class Characteristic extends EventTarget {
  constructor() {
    super();
    this.properties = { write: true, notify: true };
    this.writes = [];
    this.writeHook = null;
  }
  async writeValueWithResponse(bytes) {
    this.writes.push(new Uint8Array(bytes));
    if (this.writeHook) await this.writeHook(bytes);
  }
  async startNotifications() { return this; }
  notify(bytes) {
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

function bluetoothFixture(kind) {
  const tx = new Characteristic(), rx = new Characteristic();
  const services = new Map();
  if (kind === 'civet' || kind === 'opossum') services.set(CIVET_SERVICE, { getCharacteristic: async id => {
    if (id === CIVET_WRITE) return tx;
    if (id === CIVET_NOTIFY) return rx;
    throw new Error('unknown characteristic');
  } });
  else services.set(LUSH_PROFILES[0].service, { getCharacteristic: async id => {
    if (id === LUSH_PROFILES[0].write) return tx;
    throw new Error('unknown characteristic');
  } });
  const device = new EventTarget();
  device.name = kind === 'civet' ? '47L124000' : kind === 'opossum' ? '47L127000' : 'LVS-C21';
  const server = { getPrimaryService: async id => {
    if (!services.has(id)) throw new Error('unavailable service');
    return services.get(id);
  } };
  device.gatt = {
    connected: false,
    connect: async () => { device.gatt.connected = true; return server; },
    disconnect: () => { device.gatt.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); },
  };
  const requests = [];
  const bluetooth = { requestDevice: async options => { requests.push(options); return device; } };
  return { tx, rx, device, bluetooth, requests };
}

function vgFixture({ handler, heartbeatMs = 0, requestTimeoutMs = 1000, onStatus } = {}) {
  const calls = [], statuses = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options, parsedBody: options.body ? JSON.parse(options.body) : undefined });
    if (handler) {
      const response = await handler(url, options);
      if (response) return response;
    }
    return response(url.endsWith('/connected')
      ? { connected: true, cluster: 'eu-west-2.autoblowapi.com', deviceType: 'vacuglide' }
      : { operationalMode: 'TARGET_SPEED_PAUSED' });
  };
  const adapter = new VacuGlideDevice({ fetchImpl, heartbeatMs, requestTimeoutMs, onStatus: status => { statuses.push(status); onStatus?.(status); } });
  return { adapter, calls, statuses };
}

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

test('display percentages cannot exceed either physical cap', () => {
  assert.equal(lushNativeLevel(100), 13);
  assert.equal(lushNativeLevel(10000), 13);
  assert.equal(lushNativeLevel(-5), 0);
  assert.equal(lushNativeLevel(50), 6);
  assert.equal(vacuglideNativeLevel(100), 35);
  assert.equal(vacuglideNativeLevel(10000), 35);
  assert.equal(vacuglideNativeLevel(-5), 0);
  assert.equal(vacuglideNativeLevel(50), 17.5);
  for (let p = 0; p <= 100; p += 0.125) {
    assert.ok(lushNativeLevel(p) <= 13 * p / 100 + 1e-9);
    assert.ok(vacuglideNativeLevel(p) <= 35 * p / 100 + 1e-9);
  }
  for (const invalid of [NaN, Infinity, undefined, '100']) {
    assert.throws(() => lushNativeLevel(invalid));
    assert.throws(() => vacuglideNativeLevel(invalid));
  }
});

test('Civet commands match manufacturer byte layouts exactly', () => {
  assert.equal(Buffer.from(civetReportingCommand(true)).toString('hex'), '5001d0' + '00'.repeat(14));
  assert.equal(civetReportingCommand(false).byteLength, 17);
  assert.deepEqual([...civetReportingCommand(false)].slice(0, 3), [0x50, 1, 0]);
  assert.equal(Buffer.from(civetZeroCommand()).toString('hex'), '66000000000000000000000002');
  assert.equal(civetZeroCommand().byteLength, 13);
});

test('Civet pressure is signed little-endian at bytes 8–9; invalid packets ignored', () => {
  const bytes = new Uint8Array(17);
  bytes[0] = 0xd0; bytes[8] = 0x16; bytes[9] = 0x03;
  assert.equal(parseCivetPressure(bytes), 7.9);
  new DataView(bytes.buffer).setInt16(8, -123, true);
  assert.equal(parseCivetPressure(bytes.buffer), -1.23);
  const padded = new Uint8Array(30); padded.set(bytes, 5);
  assert.equal(parseCivetPressure(new DataView(padded.buffer, 5, 17)), -1.23);
  assert.equal(parseCivetPressure(new Uint8Array(10)), null);
  assert.equal(parseCivetPressure(new Uint8Array(17)), null);
  assert.equal(parseCivetPressure(undefined), null);
});

test('serialized commands coalesce pending output and prioritize stop', async () => {
  const blocker = deferred();
  const sent = [];
  const queue = new SerializedCommands();
  const first = queue.enqueue(async () => { sent.push(10); await blocker.promise; });
  const stale1 = queue.enqueue(() => { sent.push(20); });
  const stale2 = queue.enqueue(() => { sent.push(30); });
  const stop = queue.enqueue(() => { sent.push(0); }, { priority: true });
  assert.deepEqual(await stale1, { sent: false, reason: 'superseded' });
  assert.deepEqual(await stale2, { sent: false, reason: 'superseded' });
  assert.deepEqual(sent, [10]);
  blocker.resolve();
  await Promise.all([first, stop]);
  assert.deepEqual(sent, [10, 0]);
});

test('repeated stops share acknowledgement and do not acknowledge before delivery', async () => {
  const hold = deferred();
  const queue = new SerializedCommands();
  let count = 0, resolved = false;
  const stop1 = queue.enqueue(async () => { count++; await hold.promise; }, { priority: true });
  const stop2 = queue.enqueue(() => { count++; }, { priority: true });
  stop2.then(() => { resolved = true; });
  await flush();
  assert.equal(resolved, false);
  hold.resolve(); await Promise.all([stop1, stop2]);
  assert.equal(count, 1);
});

test('write errors reject visibly and remove stale pending work', async () => {
  const hold = deferred(), errors = [], sent = [];
  const queue = new SerializedCommands(error => errors.push(error));
  const first = queue.enqueue(async () => { await hold.promise; throw new Error('broken'); });
  const stale = queue.enqueue(() => { sent.push(100); });
  const rejection = assert.rejects(first, /broken/);
  hold.resolve(); await rejection;
  assert.equal((await stale).sent, false);
  assert.deepEqual(sent, []);
  assert.equal(errors.length, 1);
  queue.close();
  await assert.rejects(queue.enqueue(() => {}), /closed/);
});

test('Civet connect subscribes, starts reports, zeroes, and reports disconnect', async () => {
  const fake = bluetoothFixture('civet');
  const statuses = [], readings = [];
  const adapter = new CivetDevice({ bluetooth: fake.bluetooth, now: () => 12345, onStatus: event => statuses.push(event), onPressure: (...args) => readings.push(args) });
  assert.equal(adapter.connected, false);
  await adapter.connect();
  assert.equal(adapter.connected, true);
  assert.deepEqual(fake.tx.writes[0], civetReportingCommand(true));
  const bytes = new Uint8Array(17); bytes[0] = 0xd0;
  new DataView(bytes.buffer).setInt16(8, 2255, true);
  fake.rx.notify(bytes);
  assert.deepEqual(readings, [[22.55, 12345]]);
  await adapter.zero();
  assert.deepEqual(fake.tx.writes[1], civetZeroCommand());
  fake.device.gatt.disconnect();
  assert.equal(adapter.connected, false);
  assert.equal(statuses.at(-1).state, 'disconnected');
  await assert.rejects(adapter.zero(), /Connect/);
});

test('Civet disconnect stops reporting before dropping transport', async () => {
  const fake = bluetoothFixture('civet');
  const adapter = new CivetDevice({ bluetooth: fake.bluetooth });
  await adapter.connect(); await adapter.disconnect();
  assert.deepEqual(fake.tx.writes.at(-1), civetReportingCommand(false));
  assert.equal(fake.device.gatt.connected, false);
});

test('Lush Mini connects using verified GATT and always caps native commands at 13', async () => {
  const fake = bluetoothFixture('lush');
  const adapter = new LushDevice({ bluetooth: fake.bluetooth });
  await adapter.connect();
  assert.ok(fake.requests[0].optionalServices.includes(LUSH_PROFILES[0].service));
  assert.equal(new TextDecoder().decode(fake.tx.writes[0]), 'Vibrate:0;');
  await adapter.setOutput(1000);
  await adapter.setOutput(100);
  await adapter.setOutput(50);
  await adapter.setOutput(-1);
  assert.deepEqual(fake.tx.writes.map(bytes => new TextDecoder().decode(bytes)), ['Vibrate:0;', 'Vibrate:13;', 'Vibrate:6;', 'Vibrate:0;']);
  await adapter.disconnect();
});

test('Lush stop invalidates queued output while an earlier write is in flight', async () => {
  const fake = bluetoothFixture('lush');
  const adapter = new LushDevice({ bluetooth: fake.bluetooth });
  await adapter.connect(); fake.tx.writes.length = 0;
  adapter._lastWriteAt = -Infinity;
  const hold = deferred(); fake.tx.writeHook = () => hold.promise;
  const first = adapter.setOutput(20);
  const stale = adapter.setOutput(100);
  const stop = adapter.stop();
  assert.equal((await stale).sent, false);
  fake.tx.writeHook = null; hold.resolve();
  await Promise.all([first, stop]);
  assert.deepEqual(fake.tx.writes.map(bytes => new TextDecoder().decode(bytes)), ['Vibrate:2;', 'Vibrate:0;']);
  await adapter.disconnect();
});

test('Lush writes fail visibly, require reconnection, and stop can still be attempted', async () => {
  const fake = bluetoothFixture('lush');
  const statuses = [];
  const adapter = new LushDevice({ bluetooth: fake.bluetooth, onStatus: event => statuses.push(event) });
  await adapter.connect();
  fake.tx.writeHook = () => { throw new Error('GATT write failed'); };
  await assert.rejects(adapter.setOutput(100), /GATT write failed/);
  assert.equal(adapter.connected, false);
  assert.equal(statuses.at(-1).state, 'error');
  await assert.rejects(adapter.setOutput(30), /not connected/);
  fake.tx.writeHook = null;
  await adapter.stop();
  assert.equal(new TextDecoder().decode(fake.tx.writes.at(-1)), 'Vibrate:0;');
  await adapter.disconnect();
});

test('Bluetooth disconnect callback cancels queued output and marks disconnected', async () => {
  const fake = bluetoothFixture('lush');
  const statuses = [];
  const adapter = new LushDevice({ bluetooth: fake.bluetooth, onStatus: event => statuses.push(event) });
  await adapter.connect();
  fake.device.gatt.disconnect();
  assert.equal(adapter.connected, false);
  assert.equal(statuses.at(-1).connected, false);
  await assert.rejects(adapter.stop(), /disconnected/);
});

test('unsupported browser errors occur without attempting any hardware call', async () => {
  await assert.rejects(new CivetDevice({ bluetooth: null }).connect(), /Web Bluetooth/);
  await assert.rejects(new LushDevice({ bluetooth: null }).connect(), /Web Bluetooth/);
});

test('Lush stop preempts a positive command waiting for the 100ms write interval', async () => {
  const fake = bluetoothFixture('lush');
  const adapter = new LushDevice({ bluetooth: fake.bluetooth });
  await adapter.connect(); fake.tx.writes.length = 0;
  const pending = adapter.setOutput(100);
  await flush();
  const stop = adapter.stop();
  await Promise.all([pending, stop]);
  assert.deepEqual(fake.tx.writes.map(bytes => new TextDecoder().decode(bytes)), ['Vibrate:0;']);
  await adapter.disconnect();
});

test('Opossum native cap and both protocol channels are bounded independently', () => {
  assert.equal(opossumNativeLevel(100), 120);
  assert.equal(opossumNativeLevel(1000), 120);
  assert.equal(opossumNativeLevel(50), 60);
  assert.throws(() => opossumNativeLevel(NaN));
  assert.deepEqual([...opossumStrengthCommand(200, 'A')], [0xb3, 120, 0]);
  assert.deepEqual([...opossumStrengthCommand(200, 'B')], [0xb3, 0, 120]);
  const pulse = opossumPulseCommand(true, 'A');
  assert.equal(pulse.length, 20);
  assert.equal(pulse[0], 0xb0);
  assert.deepEqual([...pulse.slice(1, 8)], Array(7).fill(0));
  assert.deepEqual([...pulse.slice(8, 12)], Array(4).fill(100));
  assert.deepEqual([...pulse.slice(12)], Array(8).fill(0));
  const display = opossumDisplayCommand(200, 200);
  assert.equal(display.length, 24);
  assert.equal(Buffer.from(display).toString('hex'), 'b2ffff00ffffffffffffffffffffffffffffffff08097878');
});

test('Opossum sends 100ms B0 frames, caps B3 at120, and stop cancels its timer', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0;
  const fake = bluetoothFixture('opossum');
  const adapter = new OpossumDevice({ bluetooth: fake.bluetooth, now: () => now });
  await adapter.connect();
  assert.equal(fake.requests[0].filters[0].name, '47L127000');
  assert.deepEqual([...fake.tx.writes[0]], [0xb3, 0, 0]);
  await adapter.setOutput(1000);
  assert.ok(fake.tx.writes.some(bytes => bytes[0] === 0xb3 && bytes[1] === 120 && bytes[2] === 0));
  const before = fake.tx.writes.length;
  now = 100; t.mock.timers.tick(100); await flush();
  assert.equal(fake.tx.writes.length, before + 1);
  assert.deepEqual(fake.tx.writes.at(-1), opossumPulseCommand(true, 'A'));
  await adapter.stop();
  assert.deepEqual([...fake.tx.writes.at(-2)], [0xb3, 0, 0]);
  assert.deepEqual(fake.tx.writes.at(-1), opossumPulseCommand(false));
  const stopped = fake.tx.writes.length;
  now = 1100; t.mock.timers.tick(1000); await flush();
  assert.equal(fake.tx.writes.length, stopped);
  await adapter.disconnect();
});

test('Opossum channel switch zeros both and never automatically starts the new channel', async () => {
  const fake = bluetoothFixture('opossum');
  const adapter = new OpossumDevice({ bluetooth: fake.bluetooth });
  await adapter.connect(); await adapter.setOutput(50);
  await adapter.setChannel('B');
  assert.equal(adapter.channel, 'B');
  assert.deepEqual([...fake.tx.writes.at(-2)], [0xb3, 0, 0]);
  assert.deepEqual(fake.tx.writes.at(-1), opossumPulseCommand(false));
  await adapter.setOutput(100);
  assert.deepEqual([...fake.tx.writes.at(-2)], [0xb3, 0, 120]);
  assert.deepEqual(fake.tx.writes.at(-1), opossumPulseCommand(true, 'B'));
  await assert.rejects(adapter.setChannel('both'), /A or B/);
  await adapter.disconnect();
});

test('frequent Opossum output updates coalesce onto one B0 per100ms, not a second stream', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0;
  const fake = bluetoothFixture('opossum');
  const adapter = new OpossumDevice({ bluetooth: fake.bluetooth, now: () => now });
  await adapter.connect(); fake.tx.writes.length = 0;
  await adapter.setOutput(10);
  const stale = adapter.setOutput(20);
  adapter.setOutput(30);
  const latest = adapter.setOutput(80);
  assert.equal((await stale).sent, false);
  await flush();
  assert.equal(fake.tx.writes.filter(bytes => bytes[0] === 0xb0).length, 1, 'only the first frame is immediate');
  now = 100; t.mock.timers.tick(100); await flush(); await latest;
  assert.equal(fake.tx.writes.filter(bytes => bytes[0] === 0xb0).length, 2);
  assert.deepEqual([...fake.tx.writes.at(-2)], [0xb3, 96, 0]);
  const next = adapter.setOutput(90);
  const final = adapter.setOutput(100);
  assert.equal((await next).sent, false);
  now = 200; t.mock.timers.tick(100); await flush(); await final;
  assert.equal(fake.tx.writes.filter(bytes => bytes[0] === 0xb0).length, 3);
  assert.deepEqual([...fake.tx.writes.at(-2)], [0xb3, 120, 0]);
  const canceledByStop = adapter.setOutput(50);
  await adapter.stop();
  assert.equal((await canceledByStop).sent, false);
  const count = fake.tx.writes.length;
  now = 1200; t.mock.timers.tick(1000); await flush();
  assert.equal(fake.tx.writes.length, count);
  await adapter.disconnect();
});

test('Opossum out-of-cap physical strength and inactive-channel changes cause fault and stop', async () => {
  for (const report of [[0xb3, 121, 0], [0xb3, 100, 1]]) {
    const fake = bluetoothFixture('opossum'), statuses = [];
    const adapter = new OpossumDevice({ bluetooth: fake.bluetooth, onStatus: status => statuses.push(status) });
    await adapter.connect(); await adapter.setOutput(50);
    fake.rx.notify(new Uint8Array(report)); await flush();
    assert.equal(adapter.connected, false);
    assert.equal(statuses.at(-1).state, 'error');
    assert.deepEqual(fake.tx.writes.at(-1), opossumPulseCommand(false));
    await assert.rejects(adapter.setOutput(100), /not connected/);
    await adapter.disconnect();
  }
});

test('Opossum B3 notification triggers documented 24-byte B2 display sync', async () => {
  const fake = bluetoothFixture('opossum');
  const adapter = new OpossumDevice({ bluetooth: fake.bluetooth });
  await adapter.connect();
  fake.rx.notify(new Uint8Array([0xb3, 50, 0])); await flush();
  assert.deepEqual(fake.tx.writes.at(-1), opossumDisplayCommand(50, 0));
  await adapter.disconnect();
});

test('Opossum stop prevents a queued B0 from following an in-flight strength write', async () => {
  const fake = bluetoothFixture('opossum');
  const adapter = new OpossumDevice({ bluetooth: fake.bluetooth });
  await adapter.connect(); fake.tx.writes.length = 0;
  const hold = deferred();
  fake.tx.writeHook = bytes => bytes[0] === 0xb3 && bytes[1] > 0 ? hold.promise : undefined;
  const output = adapter.setOutput(100), stop = adapter.stop();
  hold.resolve(); await Promise.all([output, stop]);
  assert.deepEqual(fake.tx.writes.map(bytes => [...bytes]), [[0xb3, 120, 0], [0xb3, 0, 0], [...opossumPulseCommand(false)]]);
  await adapter.disconnect();
});

test('a newer Opossum target does not starve B0 while the current B3 write completes', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0;
  const fake = bluetoothFixture('opossum');
  const adapter = new OpossumDevice({ bluetooth: fake.bluetooth, now: () => now });
  await adapter.connect(); fake.tx.writes.length = 0;
  const hold = deferred();
  fake.tx.writeHook = bytes => bytes[0] === 0xb3 && bytes[1] === 12 ? hold.promise : undefined;
  const current = adapter.setOutput(10);
  const next = adapter.setOutput(80);
  hold.resolve(); await current;
  assert.deepEqual(fake.tx.writes.map(bytes => [...bytes]), [[0xb3, 12, 0], [...opossumPulseCommand(true)]]);
  now = 100; t.mock.timers.tick(100); await flush(); await next;
  assert.deepEqual(fake.tx.writes.slice(-2).map(bytes => [...bytes]), [[0xb3, 96, 0], [...opossumPulseCommand(true)]]);
  await adapter.disconnect();
});

test('Opossum timer interruption stops rather than sending a stale nonzero frame', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fake = bluetoothFixture('opossum');
  let now = 0;
  const adapter = new OpossumDevice({ bluetooth: fake.bluetooth, now: () => now });
  await adapter.connect(); await adapter.setOutput(100); fake.tx.writes.length = 0;
  now = 1000; t.mock.timers.tick(100); await flush();
  assert.equal(adapter.connected, false);
  assert.deepEqual(fake.tx.writes.map(bytes => [...bytes]), [[0xb3, 0, 0], [...opossumPulseCommand(false)]]);
  await adapter.disconnect();
});

test('VacuGlide discovery uses token header and an allowlisted cluster, never token URL', async () => {
  const { adapter, calls } = vgFixture();
  await adapter.connect('test-device-token');
  assert.equal(adapter.connected, true);
  assert.equal(calls[0].url, 'https://latency.autoblowapi.com/vacuglide/connected');
  assert.equal(calls[0].headers['x-device-token'], 'test-device-token');
  assert.equal(calls[1].url, 'https://eu-west-2.autoblowapi.com/vacuglide/target-speed/stop');
  assert.equal(calls[1].method, 'PUT');
  assert.equal(calls[1].body, undefined);
  assert.equal(calls[1].headers['Content-Type'], undefined);
  assert.ok(calls.every(call => !call.url.includes('test-device-token') && call.redirect === 'error' && call.credentials === 'omit'));
  await adapter.disconnect();
  assert.equal(adapter.connected, false);
});

test('VacuGlide rejects offline devices, wrong model, and malicious cluster URLs', async () => {
  for (const invalid of [
    { connected: false },
    { connected: true, cluster: 'evil.example', deviceType: 'vacuglide' },
    { connected: true, cluster: 'eu-west-2.autoblowapi.com.evil.example', deviceType: 'vacuglide' },
    { connected: true, cluster: 'eu-west-2.autoblowapi.com', deviceType: 'ultra' },
  ]) {
    const { adapter, calls } = vgFixture({ handler: async () => response(invalid) });
    await assert.rejects(adapter.connect('test-device-token'));
    assert.equal(adapter.connected, false);
    assert.equal(calls.length, 1, 'token is never forwarded to the supplied cluster');
  }
});

test('VacuGlide caps every direct speed request and keeps valve commands separate', async () => {
  const { adapter, calls } = vgFixture();
  await adapter.connect('test-device-token');
  calls.length = 0;
  await adapter.setOutput(1000);
  await adapter.setOutput(50);
  await adapter.setValve('plus', true);
  await adapter.setValve('plus', false);
  await adapter.setValve('minus', true);
  await adapter.stop();
  assert.deepEqual(calls.filter(call => call.url.endsWith('/target-speed')).map(call => call.parsedBody), [{ targetSpeed: 35 }, { targetSpeed: 17.5 }]);
  assert.deepEqual(calls.filter(call => call.url.includes('/valve/')).map(call => call.parsedBody), [{ valveState: true }, { valveState: false }, { valveState: true }, { valveState: false }, { valveState: false }]);
  assert.equal(calls.findLast(call => call.url.endsWith('/stop')).body, undefined);
  await assert.rejects(adapter.setValve('release', true), /Valve/);
  await assert.rejects(adapter.setValve('plus', 'true'), /Valve/);
  await adapter.disconnect();
});

test('VacuGlide serializes commands and removes stale queued speed before stop', async () => {
  const hold = deferred(); let block = false;
  const { adapter, calls } = vgFixture({ handler: async url => {
    if (block && url.endsWith('/target-speed')) { await hold.promise; }
  } });
  await adapter.connect('test-device-token'); calls.length = 0; block = true;
  const first = adapter.setOutput(50);
  const stale = adapter.setOutput(100);
  const stop = adapter.stop();
  assert.equal((await stale).sent, false);
  hold.resolve(); await Promise.all([first, stop]);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0].parsedBody, { targetSpeed: 17.5 });
  assert.ok(calls[1].url.endsWith('/target-speed/stop'));
  await adapter.disconnect();
});

test('VacuGlide 429 and motor faults are reported, never silently retried', async () => {
  for (const failure of [response({}, 429), response({ operationalMode: 'ERROR_MOTOR_STUCK' })]) {
    const { adapter, calls, statuses } = vgFixture({ handler: async url => url.endsWith('/target-speed') ? failure : undefined });
    await adapter.connect('test-device-token');
    await assert.rejects(adapter.setOutput(100));
    assert.equal(adapter.connected, false);
    assert.equal(statuses.at(-1).state, 'error');
    await assert.rejects(adapter.setOutput(50), /not connected/);
    assert.equal(calls.filter(call => call.url.endsWith('/target-speed')).length, 1);
    await adapter.stop();
    await adapter.disconnect();
  }
});

test('VacuGlide Stop closes both valves after an in-flight open, even if release was canceled', async () => {
  const hold = deferred(); let block = false;
  const { adapter, calls } = vgFixture({ handler: async (url, options) => {
    if (block && url.endsWith('stroke-plus') && JSON.parse(options.body).valveState) await hold.promise;
  } });
  await adapter.connect('test-device-token'); calls.length = 0; block = true;
  const open = adapter.setValve('plus', true);
  const release = adapter.setValve('plus', false);
  const stop = adapter.stop();
  assert.equal((await release).sent, false);
  hold.resolve(); await Promise.all([open, stop]);
  assert.deepEqual(calls.map(call => [call.url.split('/').at(-1), call.parsedBody]), [
    ['stroke-plus', { valveState: true }], ['stop', undefined],
    ['stroke-plus', { valveState: false }], ['stroke-minus', { valveState: false }],
  ]);
  await adapter.disconnect();
});

test('VacuGlide failed motor stop still attempts both valve closes', async () => {
  let fail = false;
  const { adapter, calls } = vgFixture({ handler: async url => fail && url.endsWith('/stop') ? response({}, 502) : undefined });
  await adapter.connect('test-device-token'); calls.length = 0; fail = true;
  await assert.rejects(adapter.stop(), /not fully confirmed/);
  assert.deepEqual(calls.slice(-2).map(call => call.parsedBody), [{ valveState: false }, { valveState: false }]);
  fail = false; await adapter.disconnect();
});

test('VacuGlide request timeout is explicitly unconfirmed and does not retry', async () => {
  const { adapter, calls } = vgFixture({ requestTimeoutMs: 10, handler: (url, options) => {
    if (!url.endsWith('/target-speed')) return undefined;
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  await adapter.connect('test-device-token');
  await assert.rejects(adapter.setOutput(100), /timed out.*unconfirmed/);
  assert.equal(adapter.connected, false);
  assert.equal(calls.filter(call => call.url.endsWith('/target-speed')).length, 1);
  await adapter.disconnect();
});

test('VacuGlide 2s read-only heartbeat detects failure and stops after disconnect', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let fail = false;
  const { adapter, calls, statuses } = vgFixture({ heartbeatMs: 2000, handler: async url => {
    if (url.endsWith('/state') && fail) return response({}, 502);
  } });
  await adapter.connect('test-device-token');
  t.mock.timers.tick(1999); await flush();
  assert.equal(calls.filter(call => call.url.endsWith('/state')).length, 0);
  t.mock.timers.tick(1); await flush();
  assert.equal(calls.filter(call => call.url.endsWith('/state')).length, 1);
  assert.equal(calls.at(-1).method, 'GET');
  fail = true; t.mock.timers.tick(2000); await flush();
  assert.equal(adapter.connected, false);
  assert.equal(statuses.at(-1).state, 'error');
  const reads = calls.filter(call => call.url.endsWith('/state')).length;
  t.mock.timers.tick(10000); await flush();
  assert.equal(calls.filter(call => call.url.endsWith('/state')).length, reads);
  await adapter.disconnect();
  t.mock.timers.tick(10000); await flush();
  assert.equal(calls.filter(call => call.url.endsWith('/state')).length, reads);
});

test('disconnect does not claim physical stop success if the HTTP stop fails', async () => {
  let fail = false;
  const { adapter, statuses } = vgFixture({ handler: async url => fail && url.endsWith('/stop') ? response({}, 502) : undefined });
  await adapter.connect('test-device-token'); fail = true;
  await assert.rejects(adapter.disconnect(), /HTTP 502/);
  assert.equal(adapter.connected, false);
  assert.match(statuses.at(-1).message, /not confirmed/);
  await assert.rejects(adapter.stop(), /not connected/);
});
