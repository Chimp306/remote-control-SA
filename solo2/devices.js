import {
  DG_SERVICE, DG_WRITE, DG_NOTIFY, LUSH_PROFILES, clamp,
  civetReportingCommand, parseCivetPressure, opossumFrames,
  lushFrame, vacuglideSpeed, vacuglideUrl,
} from './protocol.js';

const KEYS = ['opossum', 'lush', 'vacuglide', 'civet'];
const TOYS = KEYS.slice(0, 3);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const noop = () => {};
const superseded = () => ({ sent: false, reason: 'superseded' });
const deviceName = key => ({ opossum: 'Opossum', lush: 'Lush Mini', vacuglide: 'Vacuglide', civet: 'Civet' }[key]);

/** One physical transaction at a time, one latest output queued, priority stop.
 * An in-flight transport command cannot be recalled. A stop invalidates every
 * queued output and is the next transaction. check() also guards multiwrites.
 */
export class CommandQueue {
  constructor() { this.pending = []; this.active = null; this.generation = 0; this.closed = false; }
  cancel() {
    this.generation += 1;
    for (const job of this.pending.splice(0)) job.resolve(superseded());
  }
  cancelPendingOutput() {
    this.pending = this.pending.filter(job => {
      if (!job.priority) { job.resolve(superseded()); return false; }
      return true;
    });
  }
  enqueue(run, { priority = false, key = 'output' } = {}) {
    if (this.closed) return Promise.reject(new Error('Connection closed.'));
    if (priority) {
      // Repeated stops share the same transaction; they cannot invalidate it.
      const current = [this.active, ...this.pending].find(job => job?.priority && job.key === key);
      if (current) {
        this.pending = this.pending.filter(job => {
          if (job !== current) { job.resolve(superseded()); return false; }
          return true;
        });
        return current.promise;
      }
      this.cancel();
    } else {
      this.pending = this.pending.filter(job => {
        if (!job.priority && job.key === key) { job.resolve(superseded()); return false; }
        return true;
      });
    }
    const job = { run, priority, key, generation: this.generation };
    job.promise = new Promise((resolve, reject) => Object.assign(job, { resolve, reject }));
    priority ? this.pending.unshift(job) : this.pending.push(job);
    this.drain();
    return job.promise;
  }
  close() { this.closed = true; this.cancel(); }
  async drain() {
    if (this.active || this.closed) return;
    while (this.pending.length && !this.closed) {
      const job = this.pending.shift();
      this.active = job;
      const valid = () => !this.closed && job.generation === this.generation;
      try { job.resolve(valid() ? await job.run(valid) : superseded()); }
      catch (error) { job.reject(error); }
      finally { this.active = null; }
    }
  }
}

function timed(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}

async function write(characteristic, bytes) {
  if (!characteristic) throw new Error('No writable Bluetooth connection.');
  let operation;
  if (characteristic.properties?.writeWithoutResponse && characteristic.writeValueWithoutResponse) operation = characteristic.writeValueWithoutResponse(bytes);
  else if (characteristic.writeValueWithResponse) operation = characteristic.writeValueWithResponse(bytes);
  else if (characteristic.writeValue) operation = characteristic.writeValue(bytes);
  else throw new Error('Bluetooth characteristic is not writable.');
  await timed(operation, 1000, 'Bluetooth write timed out. Output stopped; reconnect before restarting.');
}

function filters(key) {
  if (key === 'civet') return { filters: [{ name: '47L124000' }, { namePrefix: 'Civet' }], optionalServices: [DG_SERVICE] };
  if (key === 'opossum') return { filters: [{ name: '47L127000' }, { namePrefix: 'Opossum' }], optionalServices: [DG_SERVICE] };
  return { filters: [{ namePrefix: 'LVS-' }, { namePrefix: 'LOVE-' }, { services: [LUSH_PROFILES[0].service] }], optionalServices: LUSH_PROFILES.map(p => p.service) };
}
function matches(key, device) {
  const name = device?.name || '';
  if (key === 'civet') return name === '47L124000' || name.startsWith('Civet');
  if (key === 'opossum') return name === '47L127000' || name.startsWith('Opossum');
  return name.startsWith('LVS-') || name.startsWith('LOVE-');
}

/** No device access occurs until connect() is explicitly called. */
export class DeviceManager {
  constructor({ onStatus = noop, onPressure = noop, onFault = noop,
    bluetooth = globalThis.navigator?.bluetooth, fetchImpl = globalThis.fetch,
    now = () => Date.now(), sleep = delay } = {}) {
    Object.assign(this, { onStatus, onPressure, onFault, bluetooth, fetchImpl, now, sleep });
    this.test = false;
    this.fakePressure = 19.8;
    this.slots = Object.fromEntries(KEYS.map(key => [key, {
      key, state: 'disconnected', desired: false, epoch: 0, queue: new CommandQueue(),
      peripheral: null, write: null, notify: null, reconnectTimer: null, attempts: 0,
      lastPulse: null, lastNative: null, outputActive: false, faultReported: false,
    }]));
  }
  status(key) { return this.slots[key]?.state || 'disconnected'; }
  connected(key) { return this.status(key) === 'connected'; }
  _status(slot, state, detail = '') {
    slot.state = state;
    if (state === 'connected') slot.closing = false;
    try { this.onStatus(slot.key, state, detail || deviceName(slot.key)); } catch { /* UI observer */ }
  }
  _fault(slot, message) {
    if (slot.faultReported) return;
    slot.faultReported = true;
    try { this.onFault(message, slot.key); } catch { /* UI observer */ }
  }
  _get(key) { if (!this.slots[key]) throw new Error('Unknown device.'); return this.slots[key]; }

  async setTest(enabled) {
    if (this.test === Boolean(enabled)) return;
    // A failed real stop is surfaced rather than silently switching to simulation.
    this.switching = true;
    try {
      await this.stopAll();
      for (const key of KEYS) await this.disconnect(key);
      this.test = Boolean(enabled);
    } finally { this.switching = false; }
  }
  setFakePressure(kpa) {
    this.fakePressure = clamp(kpa, -327.68, 327.67);
    this.tickFakePressure();
  }
  tickFakePressure() {
    if (this.test && this.connected('civet')) this.onPressure(this.fakePressure, this.now());
  }

  async connect(key, { token } = {}) {
    const slot = this._get(key);
    if (slot.connecting) return slot.connecting;
    if (this.connected(key)) return;
    if (TOYS.includes(key)) {
      for (const other of TOYS) if (other !== key && this.status(other) !== 'disconnected') await this.disconnect(other);
    }
    slot.desired = true;
    slot.faultReported = false;
    slot.attempts = 0;
    clearTimeout(slot.reconnectTimer);
    if (this.test) {
      this._status(slot, 'connected', 'Simulated device');
      this.tickFakePressure();
      return;
    }
    if (key === 'vacuglide') {
      slot.connecting = this._prepareCloud(slot, token).finally(() => { slot.connecting = null; });
    } else {
      if (!this.bluetooth?.requestDevice) throw new Error('Web Bluetooth needs Chrome or Edge on a supported desktop or Android device. Test mode works here.');
      this._status(slot, 'connecting', 'Choose your device');
      // Start the chooser directly from the click, before the first await.
      const chooser = this.bluetooth.requestDevice(filters(key));
      slot.connecting = this._chooseBLE(slot, chooser).finally(() => { slot.connecting = null; });
    }
    return slot.connecting;
  }

  async _chooseBLE(slot, chooser) {
    const epoch = ++slot.epoch;
    try {
      const peripheral = await chooser;
      if (epoch !== slot.epoch || !slot.desired) return;
      slot.peripheral = peripheral;
      await this._openBLE(slot, epoch);
    } catch (error) {
      if (epoch !== slot.epoch) return;
      slot.desired = false;
      this._detachBLE(slot);
      const canceled = ['NotFoundError', 'NotAllowedError', 'AbortError'].includes(error.name);
      this._status(slot, canceled ? 'disconnected' : 'error', canceled ? 'No device selected' : error.message);
      if (!canceled) throw error;
    }
  }

  async reconnect(key, { token } = {}) {
    const slot = this._get(key);
    if (slot.connecting) return slot.connecting;
    if (this.test) return this.connect(key);
    clearTimeout(slot.reconnectTimer);
    if (key === 'vacuglide') {
      slot.desired = true;
      slot.faultReported = false;
      slot.connecting = this._prepareCloud(slot, token).finally(() => { slot.connecting = null; });
      return slot.connecting;
    }
    slot.closing = true;
    if (this.connected(key)) {
      try { await this.stop(key); }
      catch {
        // Reconnect is also the recovery path for a wedged write channel.
        // Drop it and require a fresh zero handshake before declaring ready.
        this._status(slot, 'reconnecting', 'Previous stop unconfirmed; resetting Bluetooth at zero');
      }
    }
    const granted = !slot.peripheral && this.bluetooth?.getDevices ? await this.bluetooth.getDevices() : [];
    const peripheral = slot.peripheral || granted.find(device => matches(key, device));
    if (!peripheral) throw new Error('No remembered permission. Use Connect to select this device.');
    this._detachBLE(slot);
    slot.peripheral = peripheral;
    slot.desired = true;
    slot.faultReported = false;
    slot.attempts = 0;
    const epoch = ++slot.epoch;
    this._status(slot, 'reconnecting', 'Reconnecting at zero');
    slot.connecting = this._openBLE(slot, epoch).catch(error => {
      if (epoch === slot.epoch) { this._status(slot, 'error', error.message); this._scheduleReconnect(slot); }
      throw error;
    }).finally(() => { slot.connecting = null; });
    return slot.connecting;
  }

  _detachBLE(slot) {
    slot.queue.close();
    if (slot.notify && slot.note) slot.notify.removeEventListener('characteristicvaluechanged', slot.note);
    if (slot.peripheral && slot.gone) slot.peripheral.removeEventListener('gattserverdisconnected', slot.gone);
    slot.write = null; slot.notify = null; slot.note = null;
    slot.lastNative = null; slot.lastPulse = null; slot.outputActive = false;
    if (slot.peripheral?.gatt?.connected) { slot.needsSettle = true; slot.peripheral.gatt.disconnect(); }
  }

  async _openBLE(slot, epoch) {
    const valid = () => { if (epoch !== slot.epoch || !slot.desired) throw new Error('Connection canceled.'); };
    this._detachBLE(slot);
    slot.queue = new CommandQueue();
    if (slot.needsSettle) { slot.needsSettle = false; await this.sleep(250); valid(); }
    slot.gone = () => this._lost(slot, 'Bluetooth disconnected. Output stopped; reconnecting at zero.');
    slot.peripheral.addEventListener('gattserverdisconnected', slot.gone);
    const server = await timed(slot.peripheral.gatt.connect(), 12000, 'Bluetooth connection timed out.');
    valid();
    if (slot.key === 'lush') {
      for (const profile of LUSH_PROFILES) {
        try {
          const service = await server.getPrimaryService(profile.service);
          valid();
          const characteristic = await service.getCharacteristic(profile.write);
          valid();
          if (characteristic.properties?.write || characteristic.properties?.writeWithoutResponse) { slot.write = characteristic; break; }
        } catch (error) { valid(); }
      }
      if (!slot.write) throw new Error('No supported Lush UART found.');
      await write(slot.write, lushFrame(0).bytes);
    } else {
      const service = await server.getPrimaryService(DG_SERVICE);
      valid();
      slot.write = await service.getCharacteristic(DG_WRITE);
      valid();
      if (slot.key === 'civet') {
        slot.notify = await service.getCharacteristic(DG_NOTIFY);
        valid();
        try { await slot.notify.stopNotifications(); } catch { /* new connection */ }
        valid();
        slot.note = event => {
          if (epoch !== slot.epoch || !slot.desired) return;
          const kpa = parseCivetPressure(event.target?.value);
          if (kpa !== null) this.onPressure(kpa, this.now());
        };
        slot.notify.addEventListener('characteristicvaluechanged', slot.note);
        await slot.notify.startNotifications();
        valid();
        await write(slot.write, civetReportingCommand());
        await this.sleep(200);
        valid();
        await write(slot.write, civetReportingCommand());
      } else {
        const zero = opossumFrames(0, 0);
        await write(slot.write, zero.strength);
        valid();
        await write(slot.write, zero.pulse);
      }
    }
    valid();
    slot.lastNative = 0;
    slot.faultReported = false;
    slot.attempts = 0;
    this._status(slot, 'connected', 'Connected at zero');
  }

  _lost(slot, message) {
    if (!slot.desired || ['disconnected', 'reconnecting'].includes(slot.state)) return;
    slot.epoch += 1;
    if (slot.key !== 'vacuglide') this._detachBLE(slot);
    else { slot.queue.cancel(); slot.outputActive = false; this._stopCloud(slot).catch(noop); }
    this._status(slot, 'reconnecting', message);
    this._fault(slot, message);
    this._scheduleReconnect(slot);
  }
  _scheduleReconnect(slot) {
    clearTimeout(slot.reconnectTimer);
    if (!slot.desired || this.test) return;
    if (slot.attempts >= 6) { this._status(slot, 'disconnected', 'Reconnect stopped after six attempts. Press Reconnect.'); return; }
    const wait = Math.min(5000, 500 * 2 ** slot.attempts);
    slot.reconnectTimer = setTimeout(async () => {
      if (!slot.desired) return;
      slot.attempts += 1;
      const epoch = ++slot.epoch;
      this._status(slot, 'reconnecting', `Reconnecting · attempt ${slot.attempts} of 6`);
      const operation = slot.key === 'vacuglide' ? this._prepareCloud(slot, undefined, true, epoch) : this._openBLE(slot, epoch);
      slot.connecting = operation;
      try {
        await operation;
      } catch {
        if (slot.desired && epoch === slot.epoch) this._scheduleReconnect(slot);
      } finally { if (slot.connecting === operation) slot.connecting = null; }
    }, wait);
  }

  setOutput(key, { a = 0, b = 0 } = {}, { hardwareCap = 40, speedCap = 35 } = {}) {
    const slot = this._get(key);
    if (key === 'civet') return Promise.reject(new Error('Civet is a sensor.'));
    a = clamp(a); b = clamp(b);
    if (!a && (!b || key !== 'opossum')) return this.stop(key);
    if (!this.connected(key) || !slot.desired || slot.closing || this.switching) return Promise.reject(new Error(`${deviceName(key)} is not connected and ready.`));
    if (this.test) { slot.outputActive = true; return Promise.resolve({ sent: true, simulated: true }); }
    if (key === 'vacuglide') return this._cloudSpeed(slot, vacuglideSpeed(a, speedCap));
    if (key === 'opossum' && slot.outputActive && slot.lastPulse !== null && this.now() - slot.lastPulse > 500) {
      const message = 'Opossum output gap exceeded 500 ms. Stopped; press Start after reconnecting.';
      // Queue zero immediately, then close the stale link when its write settles.
      const stopping = this.stop(key);
      this._status(slot, 'error', message);
      this._fault(slot, message);
      stopping.catch(noop).finally(() => this._lost(slot, message));
      return Promise.reject(new Error(message));
    }
    const frames = key === 'opossum' ? opossumFrames(a, b, hardwareCap) : lushFrame(a);
    const epoch = slot.epoch;
    return slot.queue.enqueue(async valid => {
      if (!valid() || epoch !== slot.epoch) return superseded();
      if (key === 'lush') {
        if (slot.lastNative === frames.native) return { sent: false, reason: 'unchanged' };
        await write(slot.write, frames.bytes);
        if (valid() && epoch === slot.epoch) slot.lastNative = frames.native;
      } else {
        await write(slot.write, frames.strength);
        if (!valid() || epoch !== slot.epoch) return superseded();
        await write(slot.write, frames.pulse);
        if (valid() && epoch === slot.epoch) slot.lastPulse = this.now();
      }
      if (valid() && epoch === slot.epoch) slot.outputActive = true;
      return { sent: true, native: frames.native };
    }).catch(error => { this._lost(slot, error.message); throw error; });
  }

  stop(key) {
    const slot = this._get(key);
    slot.outputActive = false;
    slot.lastPulse = null;
    if (key === 'civet' || this.test) return Promise.resolve({ sent: true, simulated: this.test });
    if (key === 'vacuglide') return this._stopCloud(slot);
    if (!slot.write || !slot.peripheral?.gatt?.connected) return Promise.resolve({ sent: false, reason: 'disconnected' });
    return slot.queue.enqueue(async valid => {
      if (!valid()) return superseded();
      if (key === 'lush') await write(slot.write, lushFrame(0).bytes);
      else {
        const frame = opossumFrames(0, 0);
        await write(slot.write, frame.strength);
        if (!valid()) return superseded();
        await write(slot.write, frame.pulse);
      }
      slot.lastNative = 0;
      slot.outputActive = false;
      slot.lastPulse = null;
      return { sent: true };
    }, { priority: true, key: 'stop' }).catch(error => {
      this._fault(slot, `${deviceName(key)} stop could not be confirmed. Use the device’s controls. ${error.message}`);
      throw error;
    });
  }
  async stopAll() {
    const results = await Promise.allSettled(TOYS.map(key => this.stop(key)));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  async disconnect(key) {
    const slot = this._get(key);
    slot.desired = false;
    slot.closing = true;
    clearTimeout(slot.reconnectTimer);
    slot.epoch += 1;
    let failure;
    try { await this.stop(key); } catch (error) { failure = error; }
    finally {
      if (key !== 'vacuglide') this._detachBLE(slot);
      else { slot.queue.close(); slot.cluster = ''; slot.token = ''; slot.lastNative = null; }
      this._status(slot, 'disconnected', failure ? 'Disconnected; stop unconfirmed' : 'Disconnected');
    }
    if (failure) throw failure;
  }

  async _request(url, token, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const headers = { 'x-device-token': token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const response = await this.fetchImpl(url, {
        method, headers, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        if ([401, 403].includes(response.status)) throw new Error('Vacuglide token rejected.');
        if (response.status === 502) throw new Error('Vacuglide is offline. Enable its online mode.');
        if (response.status === 429) throw new Error('Vacuglide rate limit reached; reconnecting after a pause.');
        throw new Error(`Vacuglide request failed (HTTP ${response.status}).`);
      }
      if (response.status === 204) return {};
      return await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Vacuglide request timed out. A sent command may have reached the device.');
      if (error instanceof TypeError) throw new Error('Vacuglide network or CORS request failed. Check connectivity.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  _cloudCall(slot, path, body) {
    if (!slot.cluster || !slot.token) return Promise.reject(new Error('Vacuglide is not connected.'));
    return this._request(vacuglideUrl(slot.cluster, path), slot.token, { method: 'PUT', body });
  }
  async _prepareCloud(slot, token, retry = false, providedEpoch) {
    slot.closing = true;
    const epoch = providedEpoch ?? ++slot.epoch;
    // Stop the old device with its old token before accepting a replacement.
    if (slot.cluster && slot.token) await this._stopCloud(slot);
    if (epoch !== slot.epoch || !slot.desired) return;
    if (token !== undefined) slot.token = String(token).trim();
    return this._connectCloud(slot, retry, epoch);
  }
  async _connectCloud(slot, retry = false, epoch = slot.epoch) {
    if (!slot.token || slot.token.length > 512 || /[\s\u0000-\u001f\u007f]/.test(slot.token)) throw new Error('Paste a valid Vacuglide device token.');
    const token = slot.token;
    this._status(slot, retry ? 'reconnecting' : 'connecting', 'Finding your Vacuglide');
    try {
      const result = await this._request('https://latency.autoblowapi.com/vacuglide/connected', token);
      if (epoch !== slot.epoch || !slot.desired) return;
      if (result.connected !== true) throw new Error('Vacuglide is offline. Hold its mode button to enable online mode.');
      if (result.deviceType && result.deviceType !== 'vacuglide') throw new Error('This token is not for a Vacuglide.');
      vacuglideUrl(result.cluster, '/vacuglide/state');
      slot.cluster = result.cluster;
      slot.queue.close();
      slot.queue = new CommandQueue();
      slot.zeroConfirmed = false;
      await this._stopCloud(slot);
      if (epoch !== slot.epoch || !slot.desired) return;
      slot.lastNative = 0;
      slot.attempts = 0;
      slot.lastProbe = this.now();
      slot.faultReported = false;
      this._status(slot, 'connected', 'Connected at zero');
    } catch (error) {
      if (epoch === slot.epoch) this._status(slot, retry ? 'reconnecting' : 'error', error.message);
      throw error;
    }
  }
  _cloudSpeed(slot, speed) {
    if (speed === 0) return this.stop('vacuglide');
    const intent = slot.cloudIntent = (slot.cloudIntent || 0) + 1;
    const epoch = slot.epoch;
    if (slot.stopping) {
      // Cloud stop requests may outlast a short rest. Wait for ALL stop work,
      // including the immediate HTTP request, before allowing a resume. Only
      // the newest requested speed survives; any later Stop cancels it.
      return slot.stopping.then(() => {
        if (intent !== slot.cloudIntent || epoch !== slot.epoch || !slot.desired || slot.closing || slot.state !== 'connected') return superseded();
        return this._cloudSpeed(slot, speed);
      });
    }
    if (slot.lastNative === speed) { this._probeCloud(slot); return Promise.resolve({ sent: false, reason: 'unchanged' }); }
    return slot.queue.enqueue(async valid => {
      if (!valid()) return superseded();
      if (slot.lastNative === speed) return { sent: false, reason: 'unchanged' };
      slot.zeroConfirmed = false;
      await this._cloudCall(slot, '/vacuglide/target-speed', { targetSpeed: speed });
      if (valid()) { slot.lastNative = speed; slot.outputActive = true; }
      return { sent: true, native: speed };
    }).catch(error => { this._lost(slot, error.message); throw error; });
  }
  _stopCloud(slot) {
    slot.cloudIntent = (slot.cloudIntent || 0) + 1;
    if (slot.zeroConfirmed && !slot.outputActive && !slot.queue.active && !slot.queue.pending.length && !slot.strokeBusy) {
      this._probeCloud(slot);
      return Promise.resolve({ sent: false, reason: 'already-zero' });
    }
    slot.outputActive = false;
    slot.lastNative = 0;
    if (!slot.cluster || !slot.token) return Promise.resolve({ sent: false, reason: 'disconnected' });
    if (slot.stopping) { slot.queue.cancelPendingOutput(); return slot.stopping; }
    // Send a stop immediately even if a previous HTTP request is in flight.
    // Repeat it behind that transaction so a late speed request cannot win.
    const cluster = slot.cluster;
    const token = slot.token;
    const call = (path, body) => this._request(vacuglideUrl(cluster, path), token, { method: 'PUT', body });
    const zero = async () => {
      const results = await Promise.allSettled([
        call('/vacuglide/target-speed/stop'),
        call('/vacuglide/valve/stroke-plus', { valveState: false }),
        call('/vacuglide/valve/stroke-minus', { valveState: false }),
      ]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      return { sent: true };
    };
    const busy = Boolean(slot.queue.active);
    slot.queue.cancel();
    const immediate = zero();
    const final = busy ? slot.queue.enqueue(zero, { priority: true, key: 'stop' }) : immediate;
    slot.stopping = Promise.allSettled([immediate, final]).then(async results => {
      // A final confirmed stop supersedes an earlier transient stop failure.
      if (results[1].status === 'rejected') throw results[1].reason;
      if (results[1].value?.sent !== true) await zero();
      slot.zeroConfirmed = true;
      return { sent: true };
    }).catch(error => {
      this._fault(slot, `Vacuglide stop unconfirmed. Use the device’s controls. ${error.message}`);
      throw error;
    }).finally(() => { slot.stopping = null; });
    return slot.stopping;
  }

  _probeCloud(slot) {
    if (this.test || !slot.desired || slot.closing || slot.state !== 'connected' || slot.probing || this.now() - (slot.lastProbe || 0) < 5000) return;
    slot.lastProbe = this.now();
    const epoch = slot.epoch;
    slot.probing = this._request('https://latency.autoblowapi.com/vacuglide/connected', slot.token).then(result => {
      if (epoch !== slot.epoch || !slot.desired) return;
      if (!result.connected || result.cluster !== slot.cluster) this._lost(slot, 'Vacuglide connection changed. Reconnecting at zero.');
    }).catch(error => {
      if (epoch === slot.epoch && slot.desired) this._lost(slot, error.message);
    }).finally(() => { slot.probing = null; });
  }

  async stroke(direction) {
    const slot = this.slots.vacuglide;
    if (!this.connected('vacuglide') || !slot.desired || slot.closing || this.switching) throw new Error('Connect Vacuglide before changing stroke length.');
    if (![1, -1].includes(direction)) throw new Error('Stroke direction must be +1 or −1.');
    if (this.test) return { sent: true, simulated: true };
    if (slot.strokeBusy) return { sent: false, reason: 'busy' };
    const path = `/vacuglide/valve/stroke-${direction > 0 ? 'plus' : 'minus'}`;
    slot.strokeBusy = true;
    slot.zeroConfirmed = false;
    try {
      return await slot.queue.enqueue(async valid => {
        if (!valid()) return superseded();
        try {
          await this._cloudCall(slot, path, { valveState: true });
          if (valid()) await this.sleep(250);
        } finally {
          // Closing is unconditional, including Stop/disconnect during a nudge.
          await this._cloudCall(slot, path, { valveState: false });
        }
        return { sent: true };
      }, { key: 'stroke' });
    } catch (error) { this._lost(slot, error.message); throw error; }
    finally { slot.strokeBusy = false; }
  }
}
