/**
 * Shared Civet setup for the root player and SUC.
 *
 * The DG-LAB public protocol (dungeonlab-open/dglab-bluetooth-protocol,
 * civet-edging-sensor) labels the signed int16 at notification bytes 8–9,
 * divided by 100, as kPa:
 * https://github.com/dungeonlab-open/dglab-bluetooth-protocol/blob/main/civet-edging-sensor/README.md
 * That page's 66 command "resets the pressure reading" with the 13-byte
 * write 0x66000000000000000000000002. It publishes no tolerance, no
 * confirmation packet, and no statement that the reading remains numerically
 * near 0 after the sensor is later attached or loaded. This module records
 * the measured post-command samples. It does not invent a 0, and it does
 * not reject a stable offset merely for being away from 0. Zero is an
 * unloaded step. Relaxed is a separate loaded resting step.
 * Nothing here is a medical or physiological limit.
 */
export const CIVET_CALIBRATION = Object.freeze({
  version: 1,
  unit: 'kPa',
  sampleCount: 12,
  minHoldMs: 900,
  maxGapMs: 1000,
  maxSampleAgeMs: 1000,
  discardAfterZeroMs: 500,
  maxWindowMs: 5000,
  minStepKpa: 0.4,
  noiseFloorKpa: 0.05,
  relaxedClearanceSigma: 4,
  stabilityRangeKpa: 0.6,
  minHysteresisKpa: 0.3,
  hysteresisNoiseSigma: 3,
  hysteresisSpanFraction: 0.2,
  cutoffSpanFraction: 0.7,
  roundingKpa: 0.1,
  realStorageKey: 'ctmp.civet-calibration.v1',
  simStorageKey: 'ctmp.civet-calibration.sim.v1',
  simulatedDeviceId: 'simulated-civet',
});

export const SIM_HOLDS = Object.freeze({
  zeroed: 0.15,
  relaxed: 6,
  half: 12,
  full: 20,
});

const C = CIVET_CALIBRATION;
const round2 = value => Math.round((value + Number.EPSILON) * 100) / 100;
const ceilTenth = value => Math.ceil(value * 10 - 1e-8) / 10;
const floorTenth = value => Math.floor(value * 10 + 1e-8) / 10;

function finiteKpa(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= -327.6 && value <= 327.6;
}

export function deviceIdentity(device) {
  const id = String(device?.id || '').trim();
  if (!id) return null;
  return { id, name: String(device?.name || '').trim() };
}

export function assessSamples(samples, now) {
  if (!Array.isArray(samples) || samples.length < C.sampleCount) {
    return { ok: false, reason: 'Not enough fresh samples yet.' };
  }
  const window = samples.slice(-C.sampleCount);
  const atNow = Number(now);
  if (!Number.isFinite(atNow)) return { ok: false, reason: 'Capture clock is invalid.' };
  for (let i = 0; i < window.length; i += 1) {
    const sample = window[i];
    if (!sample || !finiteKpa(sample.kpa) || !Number.isFinite(sample.at)) {
      return { ok: false, reason: 'A sample was missing or implausible.' };
    }
    if (sample.at > atNow || atNow - sample.at > C.maxSampleAgeMs + C.maxWindowMs) {
      return { ok: false, reason: 'A sample was stale or from the future.' };
    }
    if (i > 0 && sample.at <= window[i - 1].at) {
      return { ok: false, reason: 'Samples must have unique, increasing timestamps.' };
    }
    if (i > 0 && sample.at - window[i - 1].at > C.maxGapMs) {
      return { ok: false, reason: 'The sensor stream had a gap. Hold steady and try again.' };
    }
  }
  const span = window[window.length - 1].at - window[0].at;
  if (span < C.minHoldMs) {
    return { ok: false, reason: 'Samples arrived too quickly to be a held reading.' };
  }
  if (atNow - window[window.length - 1].at > C.maxSampleAgeMs) {
    return { ok: false, reason: 'The latest sample is stale.' };
  }
  if (span > C.maxWindowMs) {
    return { ok: false, reason: 'The hold took too long to settle.' };
  }
  const values = window.map(sample => sample.kpa);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const std = Math.sqrt(variance);
  const range = Math.max(...values) - Math.min(...values);
  if (range > C.stabilityRangeKpa) {
    return { ok: false, reason: 'Readings moved too much. Hold steady and try again.', mean: round2(mean), std: round2(std), range: round2(range), count: values.length };
  }
  return {
    ok: true,
    mean: round2(mean),
    std: round2(std),
    range: round2(range),
    count: values.length,
    startedAt: window[0].at,
    endedAt: window[window.length - 1].at,
  };
}

export function assessZero(samples, now) {
  const measured = assessSamples(samples, now);
  if (!measured.ok) return measured;
  return { ...measured, commandSent: true };
}

export function captureTimedOut(capture, now) {
  if (!capture || !Number.isFinite(now)) return false;
  return capture.samples.length < C.sampleCount && now > capture.collectAfter + C.maxWindowMs;
}

function noiseOf(zero, relaxed, half, full) {
  return Math.max(zero.std || 0, relaxed.std || 0, half.std || 0, full.std || 0, C.noiseFloorKpa);
}

export function deriveProfile({ device, simulated = false, zero, relaxed, half, full, acceptedAt = Date.now() }) {
  const identity = deviceIdentity(device);
  if (!identity) throw new Error('This sensor has no browser device id, so a profile cannot be saved for it.');
  if (Boolean(simulated) !== (identity.id === C.simulatedDeviceId)) {
    throw new Error('Simulated and real sensors cannot share a calibration profile.');
  }
  for (const [name, reading] of [['zero', zero], ['relaxed', relaxed], ['half', half], ['full', full]]) {
    if (!reading || reading.commandSent === false || !finiteKpa(reading.mean) || !Number.isFinite(reading.std)) {
      throw new Error(`The ${name} reading is missing.`);
    }
  }
  if (!zero.commandSent) throw new Error('Hardware zero was not confirmed from post-command samples.');
  const noise = noiseOf(zero, relaxed, half, full);
  const stepRelaxedToHalf = half.mean - relaxed.mean;
  const stepHalfToFull = full.mean - half.mean;
  const minStep = Math.max(C.minStepKpa, C.relaxedClearanceSigma * noise);
  if (stepRelaxedToHalf < minStep || stepHalfToFull < minStep) {
    throw new Error('Relaxed, half, and full readings are too close together for the measured variation.');
  }
  const minHysteresis = ceilTenth(Math.max(C.minHysteresisKpa, 2 * noise));
  const resetFloor = ceilTenth(relaxed.mean + 2 * noise);
  const cutoffFloor = ceilTenth(Math.max(
    relaxed.mean + C.relaxedClearanceSigma * noise + C.roundingKpa,
    resetFloor + minHysteresis,
  ));
  const halfCap = floorTenth(half.mean);
  const fullCap = floorTenth(full.mean - Math.max(minHysteresis, 2 * noise));
  if (!(cutoffFloor < halfCap) || !(cutoffFloor < fullCap)) {
    throw new Error('The full and half holds do not leave room for a cutoff above the relaxed variation.');
  }
  let cutoff = relaxed.mean + C.cutoffSpanFraction * stepRelaxedToHalf;
  cutoff = Math.min(halfCap, fullCap, Math.max(cutoffFloor, ceilTenth(cutoff)));
  const resetMax = floorTenth(cutoff - minHysteresis);
  if (resetFloor > resetMax) {
    throw new Error('Could not place a reset level above the relaxed reading and clearly below the cutoff.');
  }
  let reset = floorTenth(cutoff - Math.max(minHysteresis, C.hysteresisNoiseSigma * noise, C.hysteresisSpanFraction * stepRelaxedToHalf));
  if (reset < resetFloor) reset = resetFloor;
  if (reset > resetMax) reset = resetMax;
  if (!(reset >= resetFloor && reset <= resetMax && cutoff - reset >= minHysteresis - 1e-9 && cutoff <= halfCap && cutoff <= fullCap)) {
    throw new Error('Could not place a reset level above the relaxed reading and clearly below the cutoff.');
  }
  const bounds = {
    cutoffMin: cutoffFloor,
    cutoffMax: fullCap,
    minHysteresis,
    resetFloor,
  };
  if (!(bounds.cutoffMin <= cutoff && cutoff <= bounds.cutoffMax && bounds.cutoffMax > bounds.cutoffMin)) {
    throw new Error('The measured range cannot contain an adjustable cutoff.');
  }
  const applied = { threshold: cutoff, resetThreshold: reset };
  return {
    version: C.version,
    unit: C.unit,
    simulated: Boolean(simulated),
    device: identity,
    acceptedAt,
    zero: { ...zero, commandSent: true },
    relaxed: { ...relaxed },
    half: { ...half },
    full: { ...full },
    noiseKpa: round2(noise),
    suggested: { ...applied },
    applied: { ...applied },
    bounds,
  };
}

export function adjustApplied(profile, nextCutoff) {
  if (!profile || profile.version !== C.version) throw new Error('No accepted calibration for this sensor.');
  const cutoff = Math.round(Number(nextCutoff) * 10) / 10;
  const { bounds } = profile;
  if (!Number.isFinite(cutoff) || cutoff < bounds.cutoffMin || cutoff > bounds.cutoffMax) {
    throw new Error(`Cutoff must stay between ${bounds.cutoffMin.toFixed(1)} and ${bounds.cutoffMax.toFixed(1)} kPa for this calibration.`);
  }
  const resetMax = floorTenth(cutoff - bounds.minHysteresis);
  if (bounds.resetFloor > resetMax) {
    throw new Error('That cutoff does not leave a usable reset level for this calibration.');
  }
  let reset = Math.min(profile.applied.resetThreshold, resetMax);
  if (reset < bounds.resetFloor) reset = bounds.resetFloor;
  if (reset > resetMax) reset = resetMax;
  if (!(reset >= bounds.resetFloor && reset <= resetMax && cutoff - reset >= bounds.minHysteresis - 1e-9)) {
    throw new Error('That cutoff does not leave a usable reset level for this calibration.');
  }
  return { ...profile, applied: { threshold: cutoff, resetThreshold: reset } };
}

export function profileMatches(profile, device, simulated = false) {
  const identity = deviceIdentity(device);
  if (!profile || profile.version !== C.version || !identity) return false;
  if (Boolean(profile.simulated) !== Boolean(simulated)) return false;
  if (profile.device?.id !== identity.id) return false;
  if (profile.simulated && identity.id !== C.simulatedDeviceId) return false;
  if (!profile.simulated && identity.id === C.simulatedDeviceId) return false;
  if (!profile.zero?.commandSent || !finiteKpa(profile.relaxed?.mean) || !finiteKpa(profile.half?.mean) || !finiteKpa(profile.full?.mean)) return false;
  const applied = profile.applied;
  const bounds = profile.bounds;
  if (!applied || !bounds) return false;
  if (!Number.isFinite(applied.threshold) || !Number.isFinite(applied.resetThreshold)) return false;
  if (applied.threshold < bounds.cutoffMin || applied.threshold > bounds.cutoffMax) return false;
  if (applied.resetThreshold < bounds.resetFloor) return false;
  return applied.threshold - applied.resetThreshold >= bounds.minHysteresis - 1e-9;
}

export function outputPermitted(profile, device, simulated, sample, now) {
  if (!profileMatches(profile, device, simulated)) return false;
  if (!sample || !finiteKpa(sample.kpa) || !Number.isFinite(sample.at) || !Number.isFinite(now)) return false;
  if (sample.at > now || now - sample.at > C.maxSampleAgeMs) return false;
  const margin = Math.max(C.stabilityRangeKpa, Number(profile.noiseKpa) || C.noiseFloorKpa);
  if (sample.kpa > profile.full.mean + margin) return false;
  if (sample.kpa < profile.zero.mean - margin) return false;
  return sample.kpa < profile.applied.resetThreshold;
}

export function storageKey(simulated) {
  return simulated ? C.simStorageKey : C.realStorageKey;
}

export function readStore(storage, simulated = false) {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(storageKey(simulated)) || 'null');
    if (!parsed || parsed.version !== C.version || typeof parsed.devices !== 'object' || !parsed.devices) return {};
    return parsed.devices;
  } catch {
    return {};
  }
}

export function writeStore(storage, devices, simulated = false) {
  if (!storage) throw new Error('Calibration could not be saved in this browser.');
  const key = storageKey(simulated);
  if (simulated && key === C.realStorageKey) throw new Error('Simulated calibration must not use the real profile store.');
  const payload = JSON.stringify({ version: C.version, devices });
  storage.setItem(key, payload);
  const written = storage.getItem(key);
  if (written !== payload) throw new Error('Calibration could not be saved in this browser.');
  if (!simulated && storage.getItem(C.simStorageKey) === payload) {
    throw new Error('Real and simulated calibration stores collided.');
  }
}

export function rememberProfile(storage, profile) {
  if (!profileMatches(profile, profile.device, profile.simulated)) throw new Error('Refusing to save an incomplete calibration.');
  const devices = readStore(storage, profile.simulated);
  devices[profile.device.id] = profile;
  writeStore(storage, devices, profile.simulated);
  const stored = readStore(storage, profile.simulated)[profile.device.id];
  if (!profileMatches(stored, profile.device, profile.simulated)) throw new Error('Saved calibration could not be read back.');
  return stored;
}

export function forgetProfile(storage, device, simulated = false) {
  const identity = deviceIdentity(device);
  if (!identity) return;
  const devices = readStore(storage, simulated);
  if (!Object.prototype.hasOwnProperty.call(devices, identity.id)) return;
  delete devices[identity.id];
  writeStore(storage, devices, simulated);
}

export function storedProfile(storage, device, simulated = false) {
  const identity = deviceIdentity(device);
  if (!identity) return null;
  const profile = readStore(storage, simulated)[identity.id] || null;
  return profileMatches(profile, identity, simulated) ? profile : null;
}

export class SimulatedCivetSensor {
  constructor({ onPressure = () => {}, onStatus = () => {}, now = () => Date.now() } = {}) {
    this.onPressure = onPressure;
    this.onStatus = onStatus;
    this.now = now;
    this.connected = false;
    this.pressure = 20.3;
    this.hold = null;
    this.unstable = false;
    this._timer = null;
    this._tickIndex = 0;
    this._readingAt = null;
  }

  sensorState() {
    const at = this.now();
    const fresh = this.connected && Number.isFinite(this._readingAt) && at >= this._readingAt && at - this._readingAt <= 1000;
    return { connected: this.connected, fresh, connecting: false, message: this.connected ? 'Simulated Civet connected. No hardware is used.' : 'Simulated Civet disconnected.' };
  }

  checkHealth() {}

  get identity() {
    return this.connected ? { id: C.simulatedDeviceId, name: 'Simulated Civet' } : null;
  }

  connect() {
    this.connected = true;
    this._status('connected', 'Simulated Civet connected. No hardware is used.');
    this._start();
    this._emit();
    return Promise.resolve(this);
  }

  reconnect() { return this.connect(); }

  setHold(name) {
    if (!Object.prototype.hasOwnProperty.call(SIM_HOLDS, name)) throw new Error('Unknown simulated hold.');
    this.hold = SIM_HOLDS[name];
    this.pressure = this.hold;
    if (this.connected) this._emit();
  }

  setUnstable(enabled) { this.unstable = Boolean(enabled); }

  zero() {
    if (!this.connected) return Promise.reject(new Error('Connect the simulated Civet before zeroing.'));
    this.hold = SIM_HOLDS.zeroed;
    this.pressure = SIM_HOLDS.zeroed;
    this._emit();
    return Promise.resolve({ sent: true });
  }

  disconnect() {
    this.connected = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._status('disconnected', 'Simulated Civet disconnected.');
    return Promise.resolve();
  }

  _start() {
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => {
      if (!this.connected) return;
      this._tickIndex += 1;
      if (this.hold !== null) this.pressure = this.hold + (this.unstable ? (this._tickIndex % 2 ? 0.9 : -0.9) : 0);
      this._emit();
    }, 100);
  }

  _emit() {
    const at = this.now();
    this._readingAt = at;
    try { this.onPressure(this.pressure, at); } catch { /* observer only */ }
  }
  _status(state, message) { try { this.onStatus({ state, connected: this.connected, message }); } catch { /* observer only */ } }
}

export class SimulatedOutputDevice {
  constructor() { this.connected = false; this.levels = { a: 0, b: 0 }; }
  connect() { this.connected = true; return Promise.resolve(this); }
  stop() { this.levels = { a: 0, b: 0 }; return Promise.resolve({ sent: true }); }
  setLevels(levels) { this.levels = { a: Number(levels?.a) || 0, b: Number(levels?.b) || 0 }; return Promise.resolve({ sent: true }); }
  setOutput() { return this.setLevels({ a: 0, b: 0 }); }
  disconnect() { this.connected = false; return Promise.resolve(); }
  cancelPending() {}
}

/** Numbers saved by older screens are not a verified capture. */
export function legacyProfileUnusable(value) {
  if (!value || typeof value !== 'object') return false;
  return ['zero', 'rest', 'half', 'full'].every(key => Number.isFinite(Number(value[key])));
}
