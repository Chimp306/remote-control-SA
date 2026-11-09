import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceManager, CommandQueue } from '../devices.js';
import { civetReportingCommand, parseCivetPressure, opossumFrames, lushFrame, vacuglideSpeed, vacuglideUrl, DG_NOTIFY } from '../protocol.js';

const response = body => ({ ok: true, status: 200, json: async () => body });
const turn = () => new Promise(resolve => setImmediate(resolve));

function fakeBLE(name = '47L127000') {
  const writes = [];
  const characteristic = new EventTarget();
  characteristic.properties = { write: true };
  characteristic.writeValueWithResponse = async bytes => { writes.push([...bytes]); };
  const notify = new EventTarget();
  notify.startNotifications = async () => notify;
  notify.stopNotifications = async () => notify;
  const device = new EventTarget();
  device.name = name;
  device.id = name;
  const service = { getCharacteristic: async uuid => uuid === DG_NOTIFY ? notify : characteristic };
  device.gatt = {
    connected: false,
    async connect() { this.connected = true; return { getPrimaryService: async () => service }; },
    disconnect() { this.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); },
  };
  return { writes, characteristic, notify, device, bluetooth: { requestDevice: async () => device, getDevices: async () => [device] } };
}

test('Civet command is 17 bytes and signed little-endian data honours byteOffset', () => {
  assert.deepEqual([...civetReportingCommand()], [0x50, 1, 0xd0, ...Array(14).fill(0)]);
  const backing = new Uint8Array(30);
  const bytes = backing.subarray(3, 20);
  bytes[0] = 0xd0;
  new DataView(backing.buffer).setInt16(11, 2042, true);
  assert.equal(parseCivetPressure(bytes), 20.42);
  new DataView(backing.buffer).setInt16(11, -123, true);
  assert.equal(parseCivetPressure(bytes), -1.23);
  assert.equal(parseCivetPressure(bytes.subarray(0, 10)), null);
  bytes[0] = 0xb3;
  assert.equal(parseCivetPressure(bytes), null);
});

test('wire output is capped and zeroed on both channels', () => {
  const frame = opossumFrames(100, 50);
  assert.deepEqual([...frame.strength], [0xb3, 80, 40]);
  assert.deepEqual([...frame.pulse], [0xb0, ...Array(7).fill(0), ...Array(4).fill(100), ...Array(4).fill(0), ...Array(4).fill(100)]);
  assert.deepEqual([...opossumFrames(120, -10, 200).strength], [0xb3, 200, 0]);
  assert.deepEqual([...opossumFrames(NaN, 1, NaN).strength], [0xb3, 0, 0]);
  assert.equal(opossumFrames(0, 0).pulse.slice(1).every(x => x === 0), true);
  assert.equal(lushFrame(100).text, 'Vibrate:20;');
  assert.equal(lushFrame(-10).text, 'Vibrate:0;');
  assert.equal(vacuglideSpeed(100), 35);
  assert.equal(vacuglideSpeed(100, 10), 10);
  assert.throws(() => vacuglideUrl('evil.test', '/vacuglide/state'), /Unrecognised/);
});

test('stop removes queued output and invalidates remaining writes in an active transaction', async () => {
  const queue = new CommandQueue();
  const calls = [];
  let release;
  const active = queue.enqueue(async valid => {
    calls.push('in-flight');
    await new Promise(resolve => { release = resolve; });
    if (valid()) calls.push('stale-second-write');
  });
  const stale = queue.enqueue(async () => calls.push('stale-pending'));
  const stopping = queue.enqueue(async () => calls.push('zero'), { priority: true, key: 'stop' });
  release();
  await Promise.all([active, stale, stopping]);
  assert.deepEqual(calls, ['in-flight', 'zero']);
});

test('a repeated stop clears output queued while the first stop was in flight', async () => {
  const queue = new CommandQueue();
  const calls = [];
  let release;
  const first = queue.enqueue(async () => { calls.push('zero'); await new Promise(resolve => { release = resolve; }); }, { priority: true, key: 'stop' });
  const stale = queue.enqueue(async () => calls.push('nonzero'));
  const second = queue.enqueue(async () => calls.push('second-zero'), { priority: true, key: 'stop' });
  release();
  await Promise.all([first, second, stale]);
  assert.deepEqual(calls, ['zero']);
});

test('Civet arms twice, reconnect replaces notification listener, disconnect cancels retry', async () => {
  const fake = fakeBLE('47L124000');
  const pressure = [];
  const manager = new DeviceManager({ bluetooth: fake.bluetooth, onPressure: value => pressure.push(value), sleep: async () => {} });
  await manager.connect('civet');
  assert.equal(manager.status('civet'), 'connected');
  assert.equal(fake.writes.length, 2);
  for (const bytes of fake.writes) assert.deepEqual(bytes, [...civetReportingCommand()]);
  const sample = new Uint8Array(17);
  sample[0] = 0xd0; new DataView(sample.buffer).setInt16(8, 2050, true);
  fake.notify.value = new DataView(sample.buffer);
  fake.notify.dispatchEvent(new Event('characteristicvaluechanged'));
  await manager.reconnect('civet');
  fake.notify.dispatchEvent(new Event('characteristicvaluechanged'));
  assert.deepEqual(pressure, [20.5, 20.5]);
  await manager.disconnect('civet');
  assert.equal(manager.status('civet'), 'disconnected');
  assert.equal(manager.slots.civet.desired, false);
  assert.equal(fake.device.gatt.connected, false);
});

test('Opossum connects at zero and sends only zero after Stop invalidates a pending pair', async () => {
  const fake = fakeBLE();
  const manager = new DeviceManager({ bluetooth: fake.bluetooth });
  await manager.connect('opossum');
  assert.deepEqual(fake.writes[0], [0xb3, 0, 0]);
  let release;
  let wait = true;
  fake.characteristic.writeValueWithResponse = async bytes => {
    fake.writes.push([...bytes]);
    if (wait) { wait = false; await new Promise(resolve => { release = resolve; }); }
  };
  const output = manager.setOutput('opossum', { a: 100, b: 50 });
  const stale = manager.setOutput('opossum', { a: 50, b: 100 });
  const stopping = manager.stopAll();
  release();
  await Promise.all([output, stale, stopping]);
  assert.deepEqual(fake.writes.slice(2).map(bytes => bytes.slice(0, 3)), [[0xb3, 80, 40], [0xb3, 0, 0], [0xb0, 0, 0]]);
  assert.equal(manager.slots.opossum.outputActive, false);
  await manager.disconnect('opossum');
});

test('test mode never invokes Bluetooth or HTTP and emits exact latest fake pressure', async () => {
  const readings = [];
  const manager = new DeviceManager({ bluetooth: { requestDevice: () => assert.fail('hardware requested') }, fetchImpl: () => assert.fail('HTTP requested'), onPressure: value => readings.push(value) });
  await manager.setTest(true);
  await manager.connect('opossum'); await manager.connect('civet');
  manager.setFakePressure(20.31);
  await manager.setOutput('opossum', { a: 100, b: 30 });
  await manager.stopAll();
  assert.equal(readings.at(-1), 20.31);
  await manager.setTest(false);
  assert.equal(manager.status('opossum'), 'disconnected');
});

test('Vacuglide discovers allowlisted cluster, caps output, closes valve, and deduplicates zero', async () => {
  const calls = [];
  const manager = new DeviceManager({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return response(url.endsWith('/connected') ? { connected: true, cluster: 'eu-west-2.autoblowapi.com', deviceType: 'vacuglide' } : {});
  }, sleep: async () => {} });
  await manager.connect('vacuglide', { token: 'test-token' });
  assert.equal(calls[0].url, 'https://latency.autoblowapi.com/vacuglide/connected');
  assert.equal(calls[0].options.headers['x-device-token'], 'test-token');
  const initial = calls.length;
  await manager.stopAll(); await manager.stopAll();
  assert.equal(calls.length, initial);
  await manager.setOutput('vacuglide', { a: 100 });
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { targetSpeed: 35 });
  await manager.stroke(1);
  const valve = calls.filter(call => call.url.endsWith('/stroke-plus')).slice(-2);
  assert.deepEqual(valve.map(call => JSON.parse(call.options.body)), [{ valveState: true }, { valveState: false }]);
  await manager.stopAll();
  assert.ok(calls.slice(-3).some(call => call.url.endsWith('/target-speed/stop')));
  await manager.disconnect('vacuglide');
});

test('Vacuglide issues stop immediately and again after an in-flight speed command', async () => {
  const calls = [];
  let release;
  const manager = new DeviceManager({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/connected')) return response({ connected: true, cluster: 'eu-west-2.autoblowapi.com' });
    if (url.endsWith('/target-speed')) await new Promise(resolve => { release = resolve; });
    return response({});
  } });
  await manager.connect('vacuglide', { token: 'test-token' });
  const before = calls.length;
  const speed = manager.setOutput('vacuglide', { a: 80 });
  const stopping = manager.stopAll();
  assert.ok(calls.slice(before).some(call => call.url.endsWith('/target-speed/stop')));
  release();
  await Promise.all([speed, stopping]);
  assert.equal(calls.slice(before).filter(call => call.url.endsWith('/target-speed/stop')).length, 2);
  assert.equal(manager.slots.vacuglide.outputActive, false);
  await manager.disconnect('vacuglide');
});

test('Vacuglide never sends token to an arbitrary discovery hostname', async () => {
  const calls = [];
  const manager = new DeviceManager({ fetchImpl: async url => { calls.push(url); return response({ connected: true, cluster: 'untrusted.invalid' }); } });
  await assert.rejects(manager.connect('vacuglide', { token: 'test-token' }), /Unrecognised/);
  assert.equal(calls.length, 1);
  await manager.disconnect('vacuglide');
});

test('disconnect blocks new nonzero output immediately while zero is in flight', async () => {
  const fake = fakeBLE();
  const manager = new DeviceManager({ bluetooth: fake.bluetooth });
  await manager.connect('opossum');
  let release;
  let waiting = true;
  fake.characteristic.writeValueWithResponse = async bytes => {
    fake.writes.push([...bytes]);
    if (waiting) { waiting = false; await new Promise(resolve => { release = resolve; }); }
  };
  const closing = manager.disconnect('opossum');
  await assert.rejects(manager.setOutput('opossum', { a: 80 }), /not connected and ready/);
  release(); await closing;
  assert.equal(fake.writes.slice(2).every(bytes => bytes.slice(1).every(value => value === 0)), true);
});

test('Vacuglide token replacement stops old device before probing the replacement', async () => {
  const calls = [];
  const manager = new DeviceManager({ fetchImpl: async (url, options) => {
    calls.push({ url, token: options.headers['x-device-token'] });
    return response(url.endsWith('/connected') ? { connected: true, cluster: 'eu-west-2.autoblowapi.com' } : {});
  } });
  await manager.connect('vacuglide', { token: 'old-token' });
  await manager.setOutput('vacuglide', { a: 90 });
  const start = calls.length;
  await manager.reconnect('vacuglide', { token: 'new-token' });
  const replacement = calls.slice(start);
  assert.ok(replacement[0].url.endsWith('/target-speed/stop'));
  assert.equal(replacement[0].token, 'old-token');
  assert.equal(replacement.findIndex(call => call.token === 'new-token'), 3);
  await manager.disconnect('vacuglide');
});

test('a canceled queued cloud stop is reissued and only a sent stop is confirmed', async () => {
  let release;
  const calls = [];
  const manager = new DeviceManager({ fetchImpl: async (url, options) => {
    calls.push(url);
    if (url.endsWith('/connected')) return response({ connected: true, cluster: 'eu-west-2.autoblowapi.com' });
    if (url.endsWith('/target-speed')) await new Promise(resolve => { release = resolve; });
    return response({});
  } });
  await manager.connect('vacuglide', { token: 'test-token' });
  const start = calls.length;
  const speed = manager.setOutput('vacuglide', { a: 70 });
  const stopping = manager.stopAll();
  manager.slots.vacuglide.queue.cancel();
  release();
  await Promise.all([speed, stopping]);
  assert.equal(calls.slice(start).filter(url => url.endsWith('/target-speed/stop')).length, 2);
  assert.equal(manager.slots.vacuglide.zeroConfirmed, true);
  await manager.disconnect('vacuglide');
});

test('quick cloud resume waits for all pending Stop requests and only latest speed runs', async () => {
  const calls = [];
  let holdStops = false;
  const releaseStops = [];
  const manager = new DeviceManager({ fetchImpl: async (url, options) => {
    calls.push({ url, body: options.body });
    if (url.endsWith('/connected')) return response({ connected: true, cluster: 'eu-west-2.autoblowapi.com' });
    if (holdStops && url.endsWith('/target-speed/stop')) await new Promise(resolve => releaseStops.push(resolve));
    return response({});
  } });
  await manager.connect('vacuglide', { token: 'test-token' });
  await manager.setOutput('vacuglide', { a: 100 });
  holdStops = true;
  const stopping = manager.stopAll();
  const start = calls.length;
  const firstResume = manager.setOutput('vacuglide', { a: 40 });
  const latestResume = manager.setOutput('vacuglide', { a: 80 });
  await turn();
  assert.equal(calls.slice(start).some(call => call.url.endsWith('/target-speed')), false);
  holdStops = false;
  releaseStops.forEach(resolve => resolve());
  const [first] = await Promise.all([firstResume, latestResume, stopping]);
  assert.equal(first.reason, 'superseded');
  assert.deepEqual(calls.slice(start).filter(call => call.url.endsWith('/target-speed')).map(call => JSON.parse(call.body)), [{ targetSpeed: 28 }]);
  assert.equal(manager.slots.vacuglide.zeroConfirmed, false);
  assert.equal(manager.slots.vacuglide.outputActive, true);
  await manager.disconnect('vacuglide');
});

test('a later Stop cancels a cloud resume waiting for a previous Stop', async () => {
  const calls = [];
  let holdStops = false;
  let release;
  const manager = new DeviceManager({ fetchImpl: async (url, options) => {
    calls.push(url);
    if (url.endsWith('/connected')) return response({ connected: true, cluster: 'eu-west-2.autoblowapi.com' });
    if (holdStops && url.endsWith('/target-speed/stop')) await new Promise(resolve => { release = resolve; });
    return response({});
  } });
  await manager.connect('vacuglide', { token: 'test-token' });
  await manager.setOutput('vacuglide', { a: 100 });
  holdStops = true;
  const stopping = manager.stopAll();
  const start = calls.length;
  const resume = manager.setOutput('vacuglide', { a: 80 });
  const finalStop = manager.stopAll();
  holdStops = false; release();
  await Promise.all([stopping, resume, finalStop]);
  assert.equal(calls.slice(start).some(url => url.endsWith('/target-speed')), false);
  assert.equal(manager.slots.vacuglide.zeroConfirmed, true);
  await manager.disconnect('vacuglide');
});
