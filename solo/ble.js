/**
 * Web Bluetooth for Civet, Opossum and Lush. Writes are queued per device and
 * happen when the page asks — the 100 ms Opossum pulse is driven by the worker
 * clock, not by a timer inside this file. A dropped GATT link reconnects unless
 * Steve pressed Disconnect.
 */

import {
  CIVET_NOTIFY,
  CIVET_SERVICE,
  CIVET_WRITE,
  LUSH_PROFILES,
  civetReportingCommand,
  lushFrame,
  opossumFrames,
  parseCivetPressure,
} from './protocol.js';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function bluetooth() {
  return globalThis.navigator?.bluetooth;
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

function queueFor() {
  let chain = Promise.resolve();
  let generation = 0;
  return {
    bump() { generation += 1; return generation; },
    get generation() { return generation; },
    enqueue(fn, gen = generation) {
      const job = chain.then(async () => {
        if (gen !== generation) return false;
        await fn();
        return true;
      });
      chain = job.catch(() => false);
      return job;
    },
  };
}

function requireBluetooth() {
  if (!bluetooth()?.requestDevice) {
    throw new Error('Web Bluetooth is not available in this browser. Use Chrome on Android or desktop, over HTTPS. Test mode still runs here.');
  }
}

function cancelled(error) {
  return error?.name === 'NotFoundError' || error?.name === 'AbortError' || error?.name === 'NotAllowedError';
}

async function prepare(device, { name, connectGatt }) {
  device.userClosed = false;
  device.queue = queueFor();
  if (device.gatt?.connected) {
    try { device.gatt.disconnect(); } catch { /* already closing */ }
    await sleep(300);
  }
  device.link = device.device || null;
  const peripheral = device.link || await connectGatt();
  device.link = peripheral;
  device.onGone = () => {
    if (device.userClosed || device.recovering) return;
    device.ready = false;
    device.recovering = true;
    recover(device, name).finally(() => { device.recovering = false; });
  };
  peripheral.addEventListener('gattserverdisconnected', device.onGone);
  device.server = await peripheral.gatt.connect();
  return peripheral;
}

async function recover(device, name) {
  let wait = 400;
  for (let attempt = 1; attempt <= 6 && !device.userClosed; attempt += 1) {
    device.onStatus?.('reconnecting', `Reconnecting ${name}… (${attempt})`);
    try {
      if (!device.link?.gatt) throw new Error('missing link');
      device.server = await device.link.gatt.connect();
      await device.subscribe();
      device.ready = true;
      device.onStatus?.('connected', 'Connected');
      return;
    } catch {
      await sleep(wait);
      wait = Math.min(5000, wait * 2);
    }
  }
  if (!device.userClosed) {
    device.ready = false;
    device.onStatus?.('disconnected', `${name} disconnected. Press Reconnect.`);
    device.onLost?.();
  }
}

function detach(device) {
  device.userClosed = true;
  device.ready = false;
  device.queue?.bump();
  const link = device.link;
  if (link && device.onGone) link.removeEventListener('gattserverdisconnected', device.onGone);
  if (device.notify && device.onNote) device.notify.removeEventListener('characteristicvaluechanged', device.onNote);
  device.write = null;
  device.notify = null;
  if (link?.gatt?.connected) {
    try { link.gatt.disconnect(); } catch { /* already gone */ }
  }
}

export function createRadio({ onPressure = () => {}, onStatus = () => {}, onLost = () => {} } = {}) {
  const slots = {
    civet: { ready: false, onStatus: (state, message) => onStatus('civet', state, message), onLost: () => onLost('civet') },
    opossum: { ready: false, onStatus: (state, message) => onStatus('opossum', state, message), onLost: () => onLost('opossum') },
    lush: { ready: false, onStatus: (state, message) => onStatus('lush', state, message), onLost: () => onLost('lush') },
  };

  async function subscribeCivet(device) {
    const service = await device.server.getPrimaryService(CIVET_SERVICE);
    device.write = await service.getCharacteristic(CIVET_WRITE);
    device.notify = await service.getCharacteristic(CIVET_NOTIFY);
    try { await device.notify.stopNotifications(); } catch { /* not subscribed yet */ }
    if (device.onNote) device.notify.removeEventListener('characteristicvaluechanged', device.onNote);
    device.onNote = (event) => {
      const kpa = parseCivetPressure(event.target?.value);
      if (kpa === null) return;
      onPressure(kpa, Date.now());
    };
    device.notify.addEventListener('characteristicvaluechanged', device.onNote);
    await device.notify.startNotifications();
    const arm = () => device.queue.enqueue(() => writeCharacteristic(device.write, civetReportingCommand(true)));
    await arm();
    await sleep(200);
    if (!device.userClosed) await arm();
  }

  async function subscribeOpossum(device) {
    const service = await device.server.getPrimaryService(CIVET_SERVICE);
    device.write = await service.getCharacteristic(CIVET_WRITE);
    const zeros = opossumFrames(0, 0, 40);
    await device.queue.enqueue(() => writeCharacteristic(device.write, zeros.strength));
    await device.queue.enqueue(() => writeCharacteristic(device.write, zeros.pulse));
  }

  async function subscribeLush(device) {
    device.write = null;
    for (const profile of LUSH_PROFILES) {
      try {
        const service = await device.server.getPrimaryService(profile.service);
        const characteristic = await service.getCharacteristic(profile.write);
        if (characteristic.properties?.write || characteristic.properties?.writeWithoutResponse) {
          device.write = characteristic;
          break;
        }
      } catch { /* try the next profile */ }
    }
    if (!device.write) throw new Error('No supported Lush write characteristic was found.');
    const frame = lushFrame(0, 65);
    await device.queue.enqueue(() => writeCharacteristic(device.write, frame.bytes));
  }

  const subscribers = { civet: subscribeCivet, opossum: subscribeOpossum, lush: subscribeLush };

  function filters(kind) {
    if (kind === 'civet') return { filters: [{ name: '47L124000' }, { namePrefix: 'Civet' }], optionalServices: [CIVET_SERVICE, 0x180a] };
    if (kind === 'opossum') return { filters: [{ name: '47L127000' }, { namePrefix: 'Opossum' }], optionalServices: [CIVET_SERVICE, 0x180a] };
    return {
      filters: [{ namePrefix: 'LVS-' }, { namePrefix: 'LOVE-' }, { services: [LUSH_PROFILES[0].service] }],
      optionalServices: LUSH_PROFILES.map((profile) => profile.service),
    };
  }

  function remembered(kind, devices) {
    return devices.find((device) => {
      const name = device?.name || '';
      if (kind === 'civet') return name === '47L124000' || name.startsWith('Civet');
      if (kind === 'opossum') return name === '47L127000' || name.startsWith('Opossum');
      return name.startsWith('LVS-') || name.startsWith('LOVE-');
    });
  }

  async function open(kind, existing) {
    requireBluetooth();
    const device = slots[kind];
    device.userClosed = true;
    detach(device);
    device.userClosed = false;
    device.ready = false;
    device.subscribe = () => subscribers[kind](device);
    device.onStatus('connecting', existing ? 'Reconnecting…' : 'Choose the device.');
    try {
      await prepare(device, {
        name: kind,
        connectGatt: async () => existing || bluetooth().requestDevice(filters(kind)),
      });
      device.queue = queueFor();
      await device.subscribe();
      device.ready = true;
      device.onStatus('connected', 'Connected');
    } catch (error) {
      device.ready = false;
      detach(device);
      if (cancelled(error)) {
        device.onStatus('disconnected', 'No device selected.');
        return;
      }
      device.onStatus('error', error.message || 'Connection failed.');
      throw error;
    }
  }

  async function writePair(kind, bytesList) {
    const device = slots[kind];
    if (!device.ready || !device.write) throw new Error(`${kind} is not connected.`);
    const gen = device.queue.generation;
    for (const bytes of bytesList) {
      const wrote = await device.queue.enqueue(() => writeCharacteristic(device.write, bytes), gen);
      if (!wrote) return false;
    }
    return true;
  }

  return {
    connected(kind) { return Boolean(slots[kind]?.ready); },

    connect(kind) { return open(kind, null); },

    async reconnect(kind) {
      requireBluetooth();
      const granted = typeof bluetooth().getDevices === 'function' ? await bluetooth().getDevices() : [];
      const existing = remembered(kind, granted);
      if (!existing) throw new Error('This browser has not been given permission yet. Press Connect.');
      return open(kind, existing);
    },

    async disconnect(kind) {
      const device = slots[kind];
      device.userClosed = true;
      try {
        if (device.ready && device.write) {
          if (kind === 'civet') {
            await device.queue.enqueue(() => writeCharacteristic(device.write, civetReportingCommand(false)));
          } else if (kind === 'opossum') {
            const zeros = opossumFrames(0, 0, 40);
            device.queue.bump();
            await device.queue.enqueue(() => writeCharacteristic(device.write, zeros.strength));
            await device.queue.enqueue(() => writeCharacteristic(device.write, zeros.pulse));
          } else if (kind === 'lush') {
            const frame = lushFrame(0, 65);
            device.queue.bump();
            await device.queue.enqueue(() => writeCharacteristic(device.write, frame.bytes));
          }
        }
      } finally {
        detach(device);
        device.onStatus('disconnected', 'Disconnected');
      }
    },

    async writeOpossum(displayA, displayB, ceiling) {
      const frame = opossumFrames(displayA, displayB, ceiling);
      const device = slots.opossum;
      if (!device.ready) return frame;
      device.queue.bump();
      const gen = device.queue.generation;
      await device.queue.enqueue(() => writeCharacteristic(device.write, frame.strength), gen);
      await device.queue.enqueue(() => writeCharacteristic(device.write, frame.pulse), gen);
      return frame;
    },

    async stopOpossum(ceiling) {
      const device = slots.opossum;
      if (!device.ready || !device.write) return;
      const frame = opossumFrames(0, 0, ceiling);
      device.queue.bump();
      const gen = device.queue.generation;
      await device.queue.enqueue(() => writeCharacteristic(device.write, frame.strength), gen);
      await device.queue.enqueue(() => writeCharacteristic(device.write, frame.pulse), gen);
    },

    async writeLush(display, ceiling) {
      const frame = lushFrame(display, ceiling);
      const device = slots.lush;
      if (!device.ready) return frame;
      if (frame.native === device.lastNative) return frame;
      device.queue.bump();
      await device.queue.enqueue(() => writeCharacteristic(device.write, frame.bytes));
      device.lastNative = frame.native;
      return frame;
    },

    async stopLush(ceiling) {
      const device = slots.lush;
      if (!device.ready || !device.write) {
        device.lastNative = 0;
        return;
      }
      const frame = lushFrame(0, ceiling);
      device.queue.bump();
      await device.queue.enqueue(() => writeCharacteristic(device.write, frame.bytes));
      device.lastNative = 0;
    },
  };
}
