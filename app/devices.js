/**
 * Device adapters. No connection, request, timer or hardware command is started
 * by importing this module. Constructors accept injected transports for tests.
 *
 * Protocol sources:
 * https://github.com/dungeonlab-open/dglab-bluetooth-protocol/tree/main/civet-edging-sensor
 * https://developers.autoblow.com/reference/http-api-v1-vacuglide/
 * Lovense's official API documents vibration levels 0–20. The Lush Mini GATT
 * profile below is the profile verified in the existing ctmp.uk application.
 * https://developer.lovense.com/docs/standard-solutions/standard-api
 */

export const CIVET_SERVICE = 0x180c;
export const CIVET_WRITE = 0x150a;
export const CIVET_NOTIFY = 0x150b;
export const LUSH_MAX_NATIVE = 13;
export const OPOSSUM_MAX_NATIVE = 120; // 60% of the documented 0–200 channel scale.
export const VACUGLIDE_MAX_NATIVE = 35;
export const LUSH_PROFILES = Object.freeze([
  { service: '53300001-0023-4bd4-bbd5-a6920e4c5653', write: '53300002-0023-4bd4-bbd5-a6920e4c5653' },
  { service: '0000fff0-0000-1000-8000-00805f9b34fb', write: '0000fff2-0000-1000-8000-00805f9b34fb' },
  { service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', write: '6e400002-b5a3-f393-e0a9-e50e24dcca9e' },
]);
const VG_CLUSTERS = new Set([
  'us-east-1.autoblowapi.com', 'us-east-2.autoblowapi.com',
  'us-west-1.autoblowapi.com', 'us-west-2.autoblowapi.com',
  'ca-central-1.autoblowapi.com', 'ap-southeast-2.autoblowapi.com',
  'eu-west-2.autoblowapi.com', 'eu-central-1.autoblowapi.com',
]);
const canceled = () => ({ sent: false, reason: 'superseded' });
const asError = error => error instanceof Error ? error : new Error(String(error));
const percent = value => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Output must be a finite number.');
  return Math.max(0, Math.min(100, value));
};

export const lushNativeLevel = displayPercent => Math.min(LUSH_MAX_NATIVE, Math.floor(percent(displayPercent) * LUSH_MAX_NATIVE / 100 + 1e-9));
export const opossumNativeLevel = displayPercent => Math.min(OPOSSUM_MAX_NATIVE, Math.floor(percent(displayPercent) * OPOSSUM_MAX_NATIVE / 100 + 1e-9));
export const vacuglideNativeLevel = displayPercent => Math.min(VACUGLIDE_MAX_NATIVE, Math.floor(percent(displayPercent) * VACUGLIDE_MAX_NATIVE / 10 + 1e-9) / 10);

export function civetReportingCommand(enabled) {
  const data = new Uint8Array(17);
  data.set([0x50, 0x01, enabled ? 0xd0 : 0]);
  return data;
}

export function civetZeroCommand() {
  const data = new Uint8Array(13);
  data[0] = 0x66;
  data[12] = 0x02;
  return data;
}

export function parseCivetPressure(value) {
  const view = value instanceof DataView ? value
    : ArrayBuffer.isView(value) ? new DataView(value.buffer, value.byteOffset, value.byteLength)
      : value instanceof ArrayBuffer ? new DataView(value) : null;
  if (!view || view.byteLength < 17 || view.getUint8(0) !== 0xd0) return null;
  return view.getInt16(8, true) / 100;
}

export function opossumStrengthCommand(native, channel = 'A') {
  const level = Math.max(0, Math.min(OPOSSUM_MAX_NATIVE, Math.floor(Number.isFinite(native) ? native : 0)));
  if (!['A', 'B'].includes(channel)) throw new TypeError('Opossum channel must be A or B.');
  return new Uint8Array([0xb3, channel === 'A' ? level : 0, channel === 'B' ? level : 0]);
}

export function opossumPulseCommand(active, channel = 'A') {
  if (!['A', 'B'].includes(channel)) throw new TypeError('Opossum channel must be A or B.');
  const bytes = new Uint8Array(20);
  bytes[0] = 0xb0;
  if (active) bytes.fill(100, channel === 'A' ? 8 : 16, channel === 'A' ? 12 : 20);
  return bytes;
}

export function opossumDisplayCommand(a, b) {
  const fixed = 'b2ffff00ffffffffffffffffffffffffffffffff0809';
  const bytes = new Uint8Array(24);
  bytes.set(fixed.match(/../g).map(hex => parseInt(hex, 16)));
  bytes[22] = Math.max(0, Math.min(OPOSSUM_MAX_NATIVE, Math.floor(Number.isFinite(a) ? a : 0)));
  bytes[23] = Math.max(0, Math.min(OPOSSUM_MAX_NATIVE, Math.floor(Number.isFinite(b) ? b : 0)));
  return bytes;
}

/**
 * At most one physical write in flight. New output replaces queued output;
 * stop clears all queued non-stop work and is next after an in-flight write.
 * An already-sent Bluetooth/HTTP command cannot be recalled. We never claim
 * that a network abort reverses a command already accepted by hardware.
 */
export class SerializedCommands {
  constructor(onError = () => {}) {
    this.onError = onError;
    this.pending = [];
    this.active = null;
    this.closed = false;
  }

  enqueue(run, { key = 'output', priority = false } = {}) {
    if (this.closed) return Promise.reject(new Error('Device connection is closed.'));
    if (priority) {
      this.cancelPending(job => !job.priority);
      const existing = this.active?.priority ? this.active : this.pending.find(job => job.priority);
      if (existing) return existing.promise;
    } else {
      this.cancelPending(job => !job.priority && job.key === key);
    }
    const job = { run, key, priority };
    job.promise = new Promise((resolve, reject) => Object.assign(job, { resolve, reject }));
    if (priority) this.pending.unshift(job);
    else this.pending.push(job);
    this._drain();
    return job.promise;
  }

  cancelPending(predicate = () => true) {
    const retained = [];
    for (const job of this.pending) {
      if (predicate(job)) job.resolve(canceled());
      else retained.push(job);
    }
    this.pending = retained;
  }

  close() {
    this.closed = true;
    this.cancelPending();
  }

  async _drain() {
    if (this.active || this.closed) return;
    while (this.pending.length && !this.closed) {
      const job = this.pending.shift();
      this.active = job;
      try {
        const result = await job.run();
        job.resolve(result ?? { sent: true });
      } catch (error) {
        this.cancelPending(pending => !pending.priority);
        try { this.onError(asError(error)); } catch { /* observer only */ }
        job.reject(asError(error));
      } finally {
        this.active = null;
      }
    }
  }
}

async function writeCharacteristic(characteristic, bytes) {
  if (!characteristic) throw new Error('No write characteristic is connected.');
  if (characteristic.properties?.write && typeof characteristic.writeValueWithResponse === 'function') {
    await characteristic.writeValueWithResponse(bytes);
  } else if (characteristic.properties?.writeWithoutResponse && typeof characteristic.writeValueWithoutResponse === 'function') {
    await characteristic.writeValueWithoutResponse(bytes);
  } else if (typeof characteristic.writeValue === 'function') {
    await characteristic.writeValue(bytes);
  } else {
    throw new Error('The selected characteristic does not support writing.');
  }
}

class BluetoothAdapter {
  constructor({ onStatus = () => {}, bluetooth = globalThis.navigator?.bluetooth } = {}) {
    this.onStatus = onStatus;
    this.bluetooth = bluetooth;
    this._device = null;
    this._writeCharacteristic = null;
    this._notifyCharacteristic = null;
    this._ready = false;
    this._epoch = 0;
    this._queue = null;
    this._connectPromise = null;
    this._faultReported = false;
  }

  get connected() { return this._ready && Boolean(this._device?.gatt?.connected); }

  _status(state, message, error) {
    try { this.onStatus({ state, connected: this.connected, message, ...(error ? { error } : {}) }); } catch { /* observer only */ }
  }

  _error(error, epoch = this._epoch) {
    if (epoch !== this._epoch) return;
    this._ready = false;
    this._queue?.cancelPending(job => !job.priority);
    if (!this._faultReported) {
      this._faultReported = true;
      this._status('error', error.message, error);
    }
  }

  _check(epoch) {
    if (epoch !== this._epoch || !this._device?.gatt?.connected) throw new Error('Bluetooth connection was lost.');
  }

  _attach(device, epoch) {
    this._device = device;
    this._disconnected = () => {
      if (epoch !== this._epoch) return;
      this._detach();
      this._status('disconnected', 'Bluetooth disconnected. Resume only after reconnecting.');
    };
    device.addEventListener('gattserverdisconnected', this._disconnected);
    this._queue = new SerializedCommands(error => this._error(error, epoch));
  }

  _detach() {
    this._epoch += 1;
    this._ready = false;
    this._queue?.close();
    if (this._device && this._disconnected) this._device.removeEventListener('gattserverdisconnected', this._disconnected);
    if (this._notifyCharacteristic && this._notification) this._notifyCharacteristic.removeEventListener('characteristicvaluechanged', this._notification);
    const device = this._device;
    this._device = null;
    this._writeCharacteristic = null;
    this._notifyCharacteristic = null;
    this._queue = null;
    if (device?.gatt?.connected) device.gatt.disconnect();
  }

  _requireBluetooth() {
    if (!this.bluetooth?.requestDevice) throw new Error('Web Bluetooth is unavailable. Use a supported browser such as Chrome on Android over HTTPS.');
  }

  _queuedWrite(bytes, options = {}) {
    const epoch = this._epoch;
    const characteristic = this._writeCharacteristic;
    if (!this._queue || !characteristic) return Promise.reject(new Error('Device is not connected.'));
    return this._queue.enqueue(async () => {
      this._check(epoch);
      await writeCharacteristic(characteristic, bytes);
      this._check(epoch);
      return { sent: true };
    }, options);
  }
}

export class CivetDevice extends BluetoothAdapter {
  constructor({ onPressure = () => {}, now = () => Date.now(), ...options } = {}) {
    super(options);
    this.onPressure = onPressure;
    this.now = now;
  }

  connect() {
    if (this.connected) return Promise.resolve(this);
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._connect().finally(() => { this._connectPromise = null; });
    return this._connectPromise;
  }

  async _connect() {
    this._requireBluetooth();
    this._detach();
    const epoch = this._epoch;
    this._faultReported = false;
    this._status('connecting', 'Select the Civet sensor.');
    try {
      const device = await this.bluetooth.requestDevice({
        // DG-LAB reuses service 180C across devices, including stimulators. Do
        // not offer every device with that service as if it were a Civet.
        filters: [{ name: '47L124000' }, { namePrefix: 'Civet' }],
        optionalServices: [CIVET_SERVICE, 0x180a],
      });
      if (epoch !== this._epoch) throw new Error('Connection canceled.');
      this._attach(device, epoch);
      const server = await device.gatt.connect();
      this._check(epoch);
      const service = await server.getPrimaryService(CIVET_SERVICE);
      this._writeCharacteristic = await service.getCharacteristic(CIVET_WRITE);
      this._notifyCharacteristic = await service.getCharacteristic(CIVET_NOTIFY);
      this._check(epoch);
      this._notification = event => {
        if (epoch !== this._epoch) return;
        const kpa = parseCivetPressure(event.target?.value);
        if (kpa === null) return;
        try { this.onPressure(kpa, this.now()); } catch { /* observer only */ }
      };
      this._notifyCharacteristic.addEventListener('characteristicvaluechanged', this._notification);
      await this._notifyCharacteristic.startNotifications();
      await this._queuedWrite(civetReportingCommand(true));
      this._check(epoch);
      this._ready = true;
      this._status('connected', 'Civet connected; waiting for live pressure.');
      return this;
    } catch (error) {
      this._error(asError(error), epoch);
      if (epoch === this._epoch) this._detach();
      throw error;
    }
  }

  async zero() {
    if (!this.connected) throw new Error('Connect the Civet before zeroing.');
    const result = await this._queuedWrite(civetZeroCommand(), { key: 'zero' });
    if (!result.sent) throw new Error('Civet zero command was canceled.');
    return result;
  }

  async disconnect() {
    const device = this._device;
    this._ready = false;
    let failure;
    try {
      if (device?.gatt?.connected && this._writeCharacteristic) {
        await this._queuedWrite(civetReportingCommand(false), { key: 'stop', priority: true });
      }
    } catch (error) { failure = error; }
    finally {
      this._detach();
      this._status('disconnected', 'Civet disconnected.');
    }
    if (failure) throw failure;
  }
}

export class LushDevice extends BluetoothAdapter {
  constructor(options = {}) {
    super(options);
    this._lastNative = null;
    this._lastWriteAt = -Infinity;
    this._outputGeneration = 0;
    this._cancelDelay = null;
  }

  connect() {
    if (this.connected) return Promise.resolve(this);
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._connect().finally(() => { this._connectPromise = null; });
    return this._connectPromise;
  }

  async _connect() {
    this._requireBluetooth();
    this._detach();
    const epoch = this._epoch;
    this._faultReported = false;
    this._lastNative = null;
    this._status('connecting', 'Select the Lush.');
    try {
      const device = await this.bluetooth.requestDevice({
        filters: [{ namePrefix: 'LVS-' }, { namePrefix: 'LOVE-' }, { services: [LUSH_PROFILES[0].service] }],
        optionalServices: LUSH_PROFILES.map(profile => profile.service),
      });
      if (epoch !== this._epoch) throw new Error('Connection canceled.');
      this._attach(device, epoch);
      const server = await device.gatt.connect();
      this._check(epoch);
      for (const profile of LUSH_PROFILES) {
        try {
          const service = await server.getPrimaryService(profile.service);
          const characteristic = await service.getCharacteristic(profile.write);
          if (characteristic.properties?.write || characteristic.properties?.writeWithoutResponse) {
            this._writeCharacteristic = characteristic;
            break;
          }
        } catch { this._check(epoch); }
      }
      if (!this._writeCharacteristic) throw new Error('No supported Lush write characteristic was found.');
      await this.stop();
      this._check(epoch);
      this._ready = true;
      this._status('connected', 'Lush connected. Command output is capped at 65%.');
      return this;
    } catch (error) {
      this._error(asError(error), epoch);
      if (epoch === this._epoch) this._detach();
      throw error;
    }
  }

  setOutput(displayPercent) {
    const native = lushNativeLevel(displayPercent);
    if (native === 0) return this.stop();
    if (!this.connected) return Promise.reject(new Error('Lush is not connected and ready.'));
    const epoch = this._epoch;
    const generation = this._outputGeneration;
    const characteristic = this._writeCharacteristic;
    return this._queue.enqueue(async () => {
      this._check(epoch);
      if (!this._ready) throw new Error('Reconnect the Lush after the failed command.');
      if (native === this._lastNative) return { sent: false, reason: 'unchanged' };
      const delay = Math.max(0, 100 - (Date.now() - this._lastWriteAt));
      if (delay) await new Promise(resolve => {
        const timer = setTimeout(() => { this._cancelDelay = null; resolve(); }, delay);
        this._cancelDelay = () => { clearTimeout(timer); this._cancelDelay = null; resolve(); };
      });
      if (generation !== this._outputGeneration) return canceled();
      this._check(epoch);
      await writeCharacteristic(characteristic, new TextEncoder().encode(`Vibrate:${Math.min(13, native)};`));
      this._check(epoch);
      this._lastNative = native;
      this._lastWriteAt = Date.now();
      return { sent: true, nativeLevel: native };
    });
  }

  stop() {
    this._outputGeneration += 1;
    this._cancelDelay?.();
    this._lastNative = null;
    const epoch = this._epoch;
    const characteristic = this._writeCharacteristic;
    if (!this._queue || !characteristic || !this._device?.gatt?.connected) return Promise.reject(new Error('Lush stop cannot be sent: Bluetooth is disconnected.'));
    return this._queue.enqueue(async () => {
      this._check(epoch);
      await writeCharacteristic(characteristic, new TextEncoder().encode('Vibrate:0;'));
      this._check(epoch);
      this._lastNative = 0;
      this._lastWriteAt = Date.now();
      return { sent: true, nativeLevel: 0 };
    }, { key: 'stop', priority: true });
  }

  async disconnect() {
    this._ready = false;
    let failure;
    try { if (this._writeCharacteristic && this._device?.gatt?.connected) await this.stop(); }
    catch (error) { failure = error; }
    finally {
      this._detach();
      this._status('disconnected', 'Lush disconnected.');
    }
    if (failure) throw failure;
  }
}

/**
 * Opossum uses a 0–200 channel strength plus a streamed 0–100 Pulse carrier.
 * The 60% cap is enforced on channel strength (at most 120); only the selected
 * channel is enabled. This describes command scale, not calibrated motor power.
 * Official protocol does not guarantee what hardware does after a missing frame.
 */
export class OpossumDevice extends BluetoothAdapter {
  constructor({ channel = 'A', now = () => Date.now(), ...options } = {}) {
    super(options);
    if (!['A', 'B'].includes(channel)) throw new TypeError('Opossum channel must be A or B.');
    this.channel = channel;
    this.now = now;
    this._native = 0;
    this._lastNative = null;
    this._outputGeneration = 0;
    this._pulseTimer = null;
    this._lastPulseTick = null;
    this._pendingOutput = null;
  }

  async setChannel(channel) {
    if (!['A', 'B'].includes(channel)) throw new TypeError('Opossum channel must be A or B.');
    if (channel === this.channel) return { channel };
    if (this._writeCharacteristic && this._device?.gatt?.connected) await this.stop();
    this.channel = channel;
    this._lastNative = null;
    return { channel };
  }

  connect() {
    if (this.connected) return Promise.resolve(this);
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._connect().finally(() => { this._connectPromise = null; });
    return this._connectPromise;
  }

  async _connect() {
    this._requireBluetooth();
    this._detach();
    const epoch = this._epoch;
    this._faultReported = false;
    this._status('connecting', 'Select the Opossum controller (47L127000).');
    try {
      const device = await this.bluetooth.requestDevice({
        filters: [{ name: '47L127000' }, { namePrefix: 'Opossum' }],
        optionalServices: [CIVET_SERVICE, 0x180a],
      });
      if (epoch !== this._epoch) throw new Error('Connection canceled.');
      this._attach(device, epoch);
      const server = await device.gatt.connect();
      this._check(epoch);
      const service = await server.getPrimaryService(CIVET_SERVICE);
      this._writeCharacteristic = await service.getCharacteristic(CIVET_WRITE);
      this._notifyCharacteristic = await service.getCharacteristic(CIVET_NOTIFY);
      this._check(epoch);
      this._notification = event => this._handleNotification(event.target?.value, epoch);
      this._notifyCharacteristic.addEventListener('characteristicvaluechanged', this._notification);
      await this._notifyCharacteristic.startNotifications();
      await this.stop();
      await this._queuedWrite(new Uint8Array([0x50, 1, 1]), { key: 'button-reports' });
      this._check(epoch);
      if (this._faultReported) throw new Error('Opossum reported an invalid channel setting.');
      this._ready = true;
      this._status('connected', `Opossum connected on channel ${this.channel}; command intensity capped at 60%.`);
      return this;
    } catch (error) {
      this._error(asError(error), epoch);
      if (epoch === this._epoch) this._detach();
      throw error;
    }
  }

  _handleNotification(view, epoch) {
    if (epoch !== this._epoch || !(view instanceof DataView) || view.byteLength < 3 || view.getUint8(0) !== 0xb3) return;
    const a = view.getUint8(1), b = view.getUint8(2);
    const invalid = a > OPOSSUM_MAX_NATIVE || b > OPOSSUM_MAX_NATIVE || (this.channel === 'A' ? b !== 0 : a !== 0);
    if (invalid) {
      this._error(new Error('Opossum channel setting exceeded the cap or enabled the inactive channel. Stop requested; check physical controls.'), epoch);
      this.stop().catch(() => {});
      return;
    }
    // Manufacturer B2 is 24 bytes although its overview table says 20. Never
    // split it into invented packets: surface any browser/MTU write failure.
    this._queuedWrite(opossumDisplayCommand(a, b), { key: 'display' }).catch(() => {});
  }

  _error(error, epoch = this._epoch) {
    if (epoch !== this._epoch) return;
    this._stopPulseTimer();
    this._native = 0;
    this._outputGeneration += 1;
    super._error(error, epoch);
  }

  _detach() {
    this._stopPulseTimer();
    this._native = 0;
    this._outputGeneration += 1;
    super._detach();
  }

  setOutput(displayPercent) {
    const native = opossumNativeLevel(displayPercent);
    if (native === 0) return this.stop();
    if (!this.connected) return Promise.reject(new Error('Opossum is not connected and ready.'));
    if (native === this._native && this._pulseTimer !== null) {
      return this._pendingOutput?.promise ?? Promise.resolve({ sent: false, reason: 'unchanged' });
    }
    this._native = native;
    if (this._pulseTimer === null) {
      const generation = ++this._outputGeneration;
      const result = this._sendFrame(native, generation);
      this._startPulseTimer();
      return result;
    }
    // Once streaming, slider/ramp changes only replace the next frame's target.
    // They do not write another B0 between the timer's 100 ms frame boundaries.
    // Nor do they invalidate a current B3/B0 pair: only a stop/fault or a new
    // stream generation may suppress its B0 after the strength write.
    this._pendingOutput?.resolve(canceled());
    const pending = {};
    pending.promise = new Promise((resolve, reject) => Object.assign(pending, { resolve, reject }));
    this._pendingOutput = pending;
    return pending.promise;
  }

  _sendFrame(native, generation) {
    const epoch = this._epoch;
    const characteristic = this._writeCharacteristic;
    const channel = this.channel;
    if (!this._queue) return Promise.reject(new Error('Opossum is disconnected.'));
    return this._queue.enqueue(async () => {
      if (generation !== this._outputGeneration || !this.connected) return canceled();
      this._check(epoch);
      if (native !== this._lastNative) {
        await writeCharacteristic(characteristic, opossumStrengthCommand(native, channel));
        this._check(epoch);
        this._lastNative = native;
      }
      if (generation !== this._outputGeneration || !this.connected) return canceled();
      await writeCharacteristic(characteristic, opossumPulseCommand(true, channel));
      this._check(epoch);
      return { sent: true, nativeLevel: Math.min(OPOSSUM_MAX_NATIVE, native) };
    });
  }

  _startPulseTimer() {
    if (this._pulseTimer !== null) return;
    this._lastPulseTick = this.now();
    this._pulseTimer = setInterval(() => {
      if (!this.connected || !this._native) return;
      const at = this.now();
      if (at < this._lastPulseTick || at - this._lastPulseTick > 500) {
        this._error(new Error('Opossum pulse timing was interrupted. Reconnect before continuing.'));
        this.stop().catch(() => {});
        return;
      }
      this._lastPulseTick = at;
      const pending = this._pendingOutput;
      this._pendingOutput = null;
      this._sendFrame(this._native, this._outputGeneration).then(
        result => pending?.resolve(result),
        error => pending?.reject(error),
      );
    }, 100);
  }

  _stopPulseTimer() {
    if (this._pulseTimer !== null) clearInterval(this._pulseTimer);
    this._pulseTimer = null;
    this._pendingOutput?.resolve(canceled());
    this._pendingOutput = null;
  }

  stop() {
    this._stopPulseTimer();
    this._native = 0;
    this._outputGeneration += 1;
    this._lastNative = null;
    const epoch = this._epoch;
    const characteristic = this._writeCharacteristic;
    if (!this._queue || !characteristic || !this._device?.gatt?.connected) return Promise.reject(new Error('Opossum stop cannot be sent: Bluetooth is disconnected.'));
    return this._queue.enqueue(async () => {
      this._check(epoch);
      let failure;
      // Attempt both documented zeros even if one command fails.
      for (const bytes of [opossumStrengthCommand(0), opossumPulseCommand(false)]) {
        try { await writeCharacteristic(characteristic, bytes); this._check(epoch); }
        catch (error) { failure ??= error; }
      }
      if (failure) throw failure;
      this._lastNative = 0;
      return { sent: true, nativeLevel: 0 };
    }, { key: 'stop', priority: true });
  }

  async disconnect() {
    this._ready = false;
    let failure;
    try { if (this._writeCharacteristic && this._device?.gatt?.connected) await this.stop(); }
    catch (error) { failure = error; }
    finally { this._detach(); this._status('disconnected', 'Opossum disconnected.'); }
    if (failure) throw failure;
  }
}

export class VacuGlideDevice {
  constructor({ onStatus = () => {}, fetchImpl = globalThis.fetch, requestTimeoutMs = 5000, heartbeatMs = 2000 } = {}) {
    this.onStatus = onStatus;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.heartbeatMs = heartbeatMs;
    this._token = null;
    this._cluster = null;
    this._ready = false;
    this._epoch = 0;
    this._lastNative = null;
    this._queue = null;
    this._connectPromise = null;
    this._faultReported = false;
    this._heartbeatTimer = null;
    this._heartbeatBusy = false;
  }

  get connected() { return this._ready; }

  _status(state, message, error) {
    try { this.onStatus({ state, connected: this.connected, message, ...(error ? { error } : {}) }); } catch { /* observer only */ }
  }

  _error(error, epoch = this._epoch) {
    if (epoch !== this._epoch) return;
    this._ready = false;
    this._stopHeartbeat();
    this._queue?.cancelPending(job => !job.priority);
    if (!this._faultReported) {
      this._faultReported = true;
      this._status('error', error.message, error);
    }
  }

  async _request(base, path, method = 'GET', body, token = this._token) {
    if (typeof this.fetchImpl !== 'function') throw new Error('HTTP requests are unavailable.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const headers = { 'x-device-token': token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const response = await this.fetchImpl(`${base}${path}`, {
        method, headers, credentials: 'omit', cache: 'no-store', redirect: 'error',
        signal: controller.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        const advice = response.status === 502 ? ' The device may be offline.' : response.status === 429 ? ' Request limit reached; reconnect before continuing.' : '';
        throw new Error(`VacuGlide request failed (HTTP ${response.status}).${advice}`);
      }
      const state = response.status === 204 ? {} : await response.json();
      if (typeof state?.operationalMode === 'string' && state.operationalMode.startsWith('ERROR')) {
        throw new Error(`VacuGlide reported ${state.operationalMode}. Check its physical controls.`);
      }
      return state;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('VacuGlide request timed out. Command delivery is unconfirmed; check the physical device.');
      throw error;
    } finally { clearTimeout(timer); }
  }

  connect(token) {
    if (this.connected && token === this._token) return Promise.resolve(this);
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._connect(token).finally(() => { this._connectPromise = null; });
    return this._connectPromise;
  }

  async _connect(token) {
    if (typeof token !== 'string' || !token.trim() || token.length > 512 || /[\s\u0000-\u001f\u007f]/.test(token)) throw new TypeError('Enter a valid VacuGlide device token.');
    if (this._token) await this.disconnect();
    const epoch = ++this._epoch;
    this._token = token;
    this._ready = false;
    this._lastNative = null;
    this._faultReported = false;
    this._status('connecting', 'Checking VacuGlide online connection.');
    try {
      const result = await this._request('https://latency.autoblowapi.com', '/vacuglide/connected');
      if (epoch !== this._epoch) throw new Error('Connection canceled.');
      if (result?.connected !== true) throw new Error('VacuGlide is offline. Enable its online mode first.');
      if (result.deviceType && result.deviceType !== 'vacuglide') throw new Error('This token is not for a VacuGlide.');
      // Never send the device token to a host supplied by an untrusted response.
      if (!VG_CLUSTERS.has(result.cluster)) throw new Error('VacuGlide returned an unrecognized server cluster.');
      this._cluster = `https://${result.cluster}`;
      this._queue = new SerializedCommands(error => this._error(error, epoch));
      await this.stop();
      if (epoch !== this._epoch) throw new Error('Connection canceled.');
      this._ready = true;
      this._status('connected', 'VacuGlide connected. Command speed is capped at 35%.');
      this._startHeartbeat(epoch);
      return this;
    } catch (error) {
      this._error(asError(error), epoch);
      if (epoch === this._epoch) {
        this._queue?.close();
        this._queue = null;
        this._token = null;
        this._cluster = null;
      }
      throw error;
    }
  }

  _enqueue(path, body, { key = 'output', priority = false, native } = {}) {
    if (!this._queue || !this._token || !this._cluster) return Promise.reject(new Error('VacuGlide is not connected.'));
    const epoch = this._epoch;
    const token = this._token;
    const cluster = this._cluster;
    return this._queue.enqueue(async () => {
      if (epoch !== this._epoch) return canceled();
      if (!priority && !this._ready) throw new Error('Reconnect the VacuGlide after the failed command.');
      if (native !== undefined && !priority && native === this._lastNative) return { sent: false, reason: 'unchanged' };
      await this._request(cluster, path, 'PUT', body, token);
      if (epoch !== this._epoch) return canceled();
      if (native !== undefined) this._lastNative = native;
      return { sent: true, ...(native === undefined ? {} : { nativeLevel: native }) };
    }, { key, priority });
  }

  setOutput(displayPercent) {
    const native = vacuglideNativeLevel(displayPercent);
    if (native === 0) return this.stop();
    if (!this.connected) return Promise.reject(new Error('VacuGlide is not connected and ready.'));
    return this._enqueue('/vacuglide/target-speed', { targetSpeed: Math.min(35, native) }, { native });
  }

  stop() {
    this._lastNative = null;
    if (!this._queue || !this._token || !this._cluster) return Promise.reject(new Error('VacuGlide is not connected.'));
    const epoch = this._epoch, token = this._token, cluster = this._cluster;
    return this._queue.enqueue(async () => {
      if (epoch !== this._epoch) return canceled();
      const failures = [];
      // The active request finishes before this job. If it opened a valve,
      // these closures still run after it, even when a queued release was
      // superseded by Stop. Try every stop action, reporting partial failure.
      for (const [path, body] of [
        ['/vacuglide/target-speed/stop', undefined],
        ['/vacuglide/valve/stroke-plus', { valveState: false }],
        ['/vacuglide/valve/stroke-minus', { valveState: false }],
      ]) {
        try { await this._request(cluster, path, 'PUT', body, token); }
        catch (error) { failures.push(asError(error).message); }
      }
      if (failures.length) throw new Error(`VacuGlide stop was not fully confirmed: ${failures.join(' ')}`);
      if (epoch !== this._epoch) return canceled();
      this._lastNative = 0;
      return { sent: true, nativeLevel: 0 };
    }, { key: 'stop', priority: true });
  }

  setValve(direction, open) {
    if (!['plus', 'minus'].includes(direction) || typeof open !== 'boolean') return Promise.reject(new TypeError('Valve needs plus/minus and a boolean state.'));
    if (!this.connected) return Promise.reject(new Error('VacuGlide is not connected and ready.'));
    return this._enqueue(`/vacuglide/valve/stroke-${direction}`, { valveState: open }, { key: `valve-${direction}` });
  }

  _startHeartbeat(epoch) {
    this._stopHeartbeat();
    if (!(this.heartbeatMs > 0)) return;
    this._heartbeatTimer = setInterval(async () => {
      if (!this.connected || this._heartbeatBusy || epoch !== this._epoch) return;
      this._heartbeatBusy = true;
      try { await this._request(this._cluster, '/vacuglide/state'); }
      catch (error) { this._error(asError(error), epoch); }
      finally { this._heartbeatBusy = false; }
    }, this.heartbeatMs);
    this._heartbeatTimer?.unref?.();
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer !== null) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
  }

  async disconnect() {
    this._stopHeartbeat();
    this._ready = false;
    let failure;
    try { if (this._queue && this._cluster && this._token) await this.stop(); }
    catch (error) { failure = error; }
    finally {
      this._epoch += 1;
      this._queue?.close();
      this._queue = null;
      this._token = null;
      this._cluster = null;
      this._lastNative = null;
      this._status('disconnected', failure ? 'Disconnected locally. Physical stop was not confirmed.' : 'VacuGlide stopped and disconnected from this app.');
    }
    if (failure) throw failure;
  }
}
