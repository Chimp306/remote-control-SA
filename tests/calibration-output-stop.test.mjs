import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CivetDevice,
  OpossumDevice,
  civetZeroCommand,
  confirmDeviceStopped,
  deviceCanReceiveStop,
  parseCivetPressure,
} from '../app/devices.js';
import { assessSamples, assessZero } from '../app/civet-calibration.js';

function packet(cents) {
  const bytes = new Uint8Array(17);
  bytes[0] = 0xd0;
  new DataView(bytes.buffer).setInt16(8, cents, true);
  return bytes;
}

function gattDevice(name, id) {
  const listeners = new Map();
  const writes = [];
  const notifyListeners = new Set();
  const write = {
    properties: { write: true, notify: false },
    writeValueWithResponse(bytes) { writes.push(new Uint8Array(bytes)); return Promise.resolve(); },
  };
  const notify = {
    properties: { notify: true, write: false },
    value: null,
    startNotifications() { return Promise.resolve(this); },
    stopNotifications() { return Promise.resolve(); },
    addEventListener(type, fn) { if (type === 'characteristicvaluechanged') notifyListeners.add(fn); },
    removeEventListener(type, fn) { notifyListeners.delete(fn); },
    emit(value) {
      this.value = value;
      for (const fn of notifyListeners) fn({ target: this });
    },
  };
  const disconnectListeners = new Set();
  const gatt = {
    connected: false,
    connect() { this.connected = true; return Promise.resolve(this); },
    disconnect() { this.connected = false; for (const fn of disconnectListeners) fn(); },
    getPrimaryService() {
      return Promise.resolve({
        getCharacteristic(uuid) { return Promise.resolve(Number(uuid) === 0x150b ? notify : write); },
      });
    },
  };
  return {
    name,
    id,
    gatt,
    writes,
    notify,
    addEventListener(type, fn) { if (type === 'gattserverdisconnected') disconnectListeners.add(fn); },
    removeEventListener(type, fn) { disconnectListeners.delete(fn); },
  };
}

function bluetoothFor(device) {
  return {
    requestDevice() { return Promise.resolve(device); },
    getDevices() { return Promise.resolve([device]); },
  };
}

test('a disconnected Opossum stop rejects, and calibration does not wait for it', async () => {
  const device = new OpossumDevice({ bluetooth: bluetoothFor(gattDevice('47L127000', 'opossum-1')) });
  assert.equal(device.connected, false);
  assert.equal(deviceCanReceiveStop(device), false);
  await assert.rejects(device.stop(), /Opossum stop cannot be sent/);
  let stopped = false;
  const absent = { connected: false, stop() { stopped = true; return Promise.reject(new Error('should not be called')); } };
  const result = await confirmDeviceStopped(absent);
  assert.equal(result.confirmed, false);
  assert.equal(stopped, false);
});

test('a connected output stop must succeed before a sensor command, and a failure is reported', async () => {
  const ok = { connected: true, stop() { return Promise.resolve({ sent: true }); } };
  assert.equal((await confirmDeviceStopped(ok)).confirmed, true);
  const failing = { connected: true, stop() { return Promise.reject(new Error('write failed')); } };
  await assert.rejects(confirmDeviceStopped(failing), /stop was not confirmed \(write failed\)/);
  const hanging = { connected: true, stop() { return new Promise(() => {}); } };
  await assert.rejects(confirmDeviceStopped(hanging, 20), /did not answer in time/);
});

test('real Civet notifications at 100ms become a captured hold after the zero command', async () => {
  const hardware = gattDevice('47L124000', 'civet-1');
  const readings = [];
  let clock = 10_000;
  const civet = new CivetDevice({
    bluetooth: bluetoothFor(hardware),
    now: () => clock,
    onPressure: (kpa, at) => readings.push({ kpa, at }),
  });
  await civet.connect();
  const reporting = hardware.writes.map(bytes => Array.from(bytes));
  assert.equal(reporting.length, 2);
  assert.equal(reporting[0][0], 0x50);
  const zero = await civet.zero();
  assert.equal(zero.sent, true);
  const command = hardware.writes.at(-1);
  assert.deepEqual(Array.from(command), Array.from(civetZeroCommand()));
  assert.equal(command.length, 13);
  assert.equal(command[0], 0x66);
  assert.equal(command[12], 0x02);
  const samples = [];
  for (let index = 0; index < 20; index += 1) {
    clock += 100;
    hardware.notify.emit(packet(18));
    assert.equal(parseCivetPressure(hardware.notify.value), 0.18);
    samples.push(readings.at(-1));
  }
  const afterDiscard = samples.filter(sample => sample.at >= 10_000 + 500);
  const verdict = assessZero(afterDiscard.slice(0, 12), afterDiscard[11].at);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.commandSent, true);
  assert.equal(verdict.mean, 0.18);
  assert.equal(verdict.count, 12);
  const level = assessSamples(samples.slice(-12), samples.at(-1).at);
  assert.equal(level.ok, true);
  assert.equal(level.mean, 0.18);
});
