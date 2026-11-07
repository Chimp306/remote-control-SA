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
 * A typed number is not a hardware reset and is not a measured hold.
 * Typed readings carry no sample count and no measured standard
 * deviation. They are trusted configuration at the protocol resolution
 * of 0.01 kPa. The baseline is reference metadata: it may match the
 * loaded rest or sit above it, and it is not a lower bound on live
 * pressure. Nothing here is a medical or physiological limit.
 */
export const CIVET_CALIBRATION = Object.freeze({
  version: 2,
  unit: 'kPa',
  sampleCount: 12,
  minHoldMs: 900,
  maxGapMs: 1000,
  maxSampleAgeMs: 1000,
  discardAfterZeroMs: 500,
  maxWindowMs: 5000,
  resolutionKpa: 0.01,
  stabilityRangeKpa: 0.6,
  hysteresisSpanFraction: 0.2,
  cutoffSpanFraction: 0.7,
  wideAdjustmentKpa: 0.1,
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
const round2 = value => fromCents(toCents(value));
export function toCents(value) {
  if (!Number.isFinite(value)) return NaN;
  return Math.round(value * 100 + Math.sign(value || 1) * 1e-8);
}
export function fromCents(cents) {
  return cents / 100;
}

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
    source: 'captured',
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

const READING_NAMES = ['zero', 'relaxed', 'half', 'full'];
const READING_LABELS = {
  zero: 'Post-zero baseline',
  relaxed: 'Relaxed',
  half: 'Half',
  full: 'Full',
};

export function parseEnteredKpa(text) {
  const raw = String(text ?? '').trim().replace(/^\+/, '');
  if (!raw) return { ok: false, empty: true, reason: 'Enter a kPa number.' };
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) return { ok: false, reason: 'Enter a finite kPa number.' };
  const value = Number(raw);
  if (!Number.isFinite(value)) return { ok: false, reason: 'Enter a finite kPa number.' };
  const mean = round2(value);
  if (!finiteKpa(mean)) return { ok: false, reason: 'That number is outside the sensor range (−327.6 to 327.6 kPa).' };
  return { ok: true, mean };
}

export function enteredReading(value) {
  const parsed = typeof value === 'number'
    ? (finiteKpa(round2(value)) ? { ok: true, mean: round2(value) } : { ok: false, reason: 'That number is outside the sensor range (−327.6 to 327.6 kPa).' })
    : parseEnteredKpa(value);
  if (!parsed.ok) throw new Error(parsed.reason || 'Enter a finite kPa number.');
  return { source: 'entered', mean: parsed.mean, commandSent: false };
}

export function sourceLabel(reading, name = '') {
  if (!reading) return 'No reading yet';
  if (reading.source === 'entered') return name === 'zero' ? 'Entered · hardware was not reset' : 'Entered · not measured';
  if (reading.source === 'captured') {
    const samples = reading.count === C.sampleCount ? ` · ${C.sampleCount} samples` : '';
    return reading.commandSent ? `Captured after hardware reset${samples}` : `Captured${samples}`;
  }
  return 'No reading yet';
}

function hasMeasuredProof(reading) {
  return reading.count != null || Number.isFinite(reading.std) || Number.isFinite(reading.range) || Number.isFinite(reading.startedAt) || Number.isFinite(reading.endedAt);
}

function normalizeReading(reading, name) {
  const label = READING_LABELS[name];
  if (!reading || typeof reading !== 'object') return { error: `${label} is missing.` };
  const legacyCaptured = !reading.source && reading.count === C.sampleCount && Number.isFinite(reading.std) && finiteKpa(reading.mean);
  const source = reading.source || (legacyCaptured ? 'captured' : '');
  if (source === 'entered') {
    if (reading.commandSent === true) return { error: `${label} was marked as a hardware reset. Typing a number does not send that command.` };
    if (hasMeasuredProof(reading)) return { error: `${label} is typed, so it cannot include sample counts or measured variation.` };
    if (!finiteKpa(reading.mean)) return { error: `${label} must be a finite kPa number.` };
    return { reading: { source: 'entered', mean: round2(reading.mean), commandSent: false } };
  }
  if (source === 'captured') {
    if (reading.count !== C.sampleCount || !Number.isFinite(reading.std) || !finiteKpa(reading.mean)) {
      return { error: `${label} is missing a real ${C.sampleCount}-sample hold.` };
    }
    if (name === 'zero' && reading.commandSent !== true) return { error: 'A captured zero must follow a sent hardware reset. Typing a number does not send that command.' };
    if (name !== 'zero' && reading.commandSent === true) return { error: `${label} cannot be marked as a hardware reset.` };
    return {
      reading: {
        source: 'captured',
        mean: round2(reading.mean),
        std: round2(reading.std),
        range: Number.isFinite(reading.range) ? round2(reading.range) : round2(reading.std),
        count: C.sampleCount,
        ...(Number.isFinite(reading.startedAt) ? { startedAt: reading.startedAt } : {}),
        ...(Number.isFinite(reading.endedAt) ? { endedAt: reading.endedAt } : {}),
        commandSent: name === 'zero',
      },
    };
  }
  return { error: `${label} is missing.` };
}

function measuredNoise(readings) {
  const stds = READING_NAMES
    .filter(name => readings[name].source === 'captured')
    .map(name => readings[name].std);
  return stds.length ? round2(Math.max(...stds)) : 0;
}

function placeThresholds(relaxed, half, full) {
  const relaxedCents = toCents(relaxed.mean);
  const halfCents = toCents(half.mean);
  const fullCents = toCents(full.mean);
  const step = halfCents - relaxedCents;
  if (step < 2) {
    return { ok: false, field: 'half', reason: 'Half must be at least 0.02 kPa above relaxed so a reset can sit between them on the sensor’s 0.01 kPa steps.' };
  }
  if (fullCents < halfCents) {
    return { ok: false, field: 'full', reason: 'Full is below the half reading, so the cutoff has no top.' };
  }
  const hysteresis = Math.max(1, Math.round(C.hysteresisSpanFraction * step));
  const cutoffMin = relaxedCents + hysteresis + 1;
  const cutoffMax = fullCents;
  if (cutoffMax < cutoffMin) {
    return { ok: false, field: 'half', reason: 'These readings do not leave 0.01 kPa steps for a reset below the cutoff and above relaxed.' };
  }
  let cutoff = relaxedCents + Math.round(C.cutoffSpanFraction * step);
  const halfCap = Math.min(halfCents, cutoffMax);
  if (halfCap >= cutoffMin) cutoff = Math.min(Math.max(cutoff, cutoffMin), halfCap);
  else cutoff = Math.min(Math.max(cutoff, cutoffMin), cutoffMax);
  const reset = cutoff - hysteresis;
  if (!(reset > relaxedCents && reset < cutoff && cutoff <= cutoffMax)) {
    return { ok: false, field: 'relaxed', reason: 'Could not place a reset above relaxed and a cutoff at or below half.' };
  }
  const span = cutoffMax - cutoffMin;
  const bounds = {
    cutoffMin: fromCents(cutoffMin),
    cutoffMax: fromCents(cutoffMax),
    minHysteresis: fromCents(hysteresis),
    resetFloor: fromCents(relaxedCents + 1),
    adjustmentStep: span <= 100 ? C.resolutionKpa : C.wideAdjustmentKpa,
  };
  return { ok: true, applied: { threshold: fromCents(cutoff), resetThreshold: fromCents(reset) }, bounds };
}

export function draftErrors(parts) {
  const errors = { zero: '', relaxed: '', half: '', full: '' };
  const readings = {};
  for (const name of READING_NAMES) {
    const result = normalizeReading(parts?.[name], name);
    if (result.error) errors[name] = result.error;
    else readings[name] = result.reading;
  }
  if (READING_NAMES.some(name => errors[name])) {
    return { ok: false, errors, reason: READING_NAMES.map(name => errors[name]).find(Boolean) };
  }
  const placed = placeThresholds(readings.relaxed, readings.half, readings.full);
  if (!placed.ok) {
    errors[placed.field] = placed.reason;
    return { ok: false, errors, reason: placed.reason, noiseKpa: measuredNoise(readings) };
  }
  return { ok: true, errors, readings, noiseKpa: measuredNoise(readings), applied: placed.applied, bounds: placed.bounds };
}

function appliedFits(applied, draft) {
  if (!applied || !Number.isFinite(applied.threshold) || !Number.isFinite(applied.resetThreshold)) return false;
  const cutoff = toCents(applied.threshold);
  const reset = toCents(applied.resetThreshold);
  return cutoff >= toCents(draft.bounds.cutoffMin)
    && cutoff <= toCents(draft.bounds.cutoffMax)
    && reset >= toCents(draft.bounds.resetFloor)
    && cutoff - reset >= toCents(draft.bounds.minHysteresis)
    && reset < cutoff;
}

export function migrateProfile(profile) {
  if (!profile || typeof profile !== 'object') return profile;
  const next = { ...profile };
  for (const name of READING_NAMES) {
    const reading = profile[name];
    if (!reading || reading.source) continue;
    const normalized = normalizeReading(reading, name);
    if (normalized.reading?.source === 'captured') next[name] = { ...reading, source: 'captured', commandSent: name === 'zero' };
  }
  const draft = draftErrors(next);
  if (!draft.ok) return next === profile ? profile : next;
  const applied = appliedFits(next.applied, draft)
    ? { threshold: fromCents(toCents(next.applied.threshold)), resetThreshold: fromCents(toCents(next.applied.resetThreshold)) }
    : { ...draft.applied };
  const migrated = {
    ...next,
    version: C.version,
    zero: draft.readings.zero,
    relaxed: draft.readings.relaxed,
    half: draft.readings.half,
    full: draft.readings.full,
    noiseKpa: draft.noiseKpa,
    suggested: { ...draft.applied },
    applied,
    bounds: draft.bounds,
  };
  return JSON.stringify(migrated) === JSON.stringify(profile) ? profile : migrated;
}

export function deriveProfile({ device, simulated = false, zero, relaxed, half, full, acceptedAt = Date.now() }) {
  const identity = deviceIdentity(device);
  if (!identity) throw new Error('This sensor has no browser device id, so a profile cannot be saved for it.');
  if (Boolean(simulated) !== (identity.id === C.simulatedDeviceId)) {
    throw new Error('Simulated and real sensors cannot share a calibration profile.');
  }
  const draft = draftErrors({ zero, relaxed, half, full });
  if (!draft.ok) throw new Error(draft.reason);
  return {
    version: C.version,
    unit: C.unit,
    simulated: Boolean(simulated),
    device: identity,
    acceptedAt,
    zero: draft.readings.zero,
    relaxed: draft.readings.relaxed,
    half: draft.readings.half,
    full: draft.readings.full,
    noiseKpa: draft.noiseKpa,
    suggested: { ...draft.applied },
    applied: { ...draft.applied },
    bounds: draft.bounds,
  };
}

export function adjustApplied(profile, nextCutoff) {
  if (!profile || profile.version !== C.version) throw new Error('No accepted calibration for this sensor.');
  const cutoff = toCents(Number(nextCutoff));
  const { bounds } = profile;
  const min = toCents(bounds.cutoffMin);
  const max = toCents(bounds.cutoffMax);
  if (!Number.isFinite(cutoff) || cutoff < min || cutoff > max) {
    throw new Error(`Cutoff must stay between ${bounds.cutoffMin.toFixed(2)} and ${bounds.cutoffMax.toFixed(2)} kPa for this calibration.`);
  }
  const resetMax = cutoff - toCents(bounds.minHysteresis);
  const resetFloor = toCents(bounds.resetFloor);
  if (resetFloor > resetMax) throw new Error('That cutoff does not leave a usable reset level for this calibration.');
  let reset = Math.min(toCents(profile.applied.resetThreshold), resetMax);
  if (reset < resetFloor) reset = resetFloor;
  if (reset > resetMax || cutoff - reset < toCents(bounds.minHysteresis)) {
    throw new Error('That cutoff does not leave a usable reset level for this calibration.');
  }
  return { ...profile, applied: { threshold: fromCents(cutoff), resetThreshold: fromCents(reset) } };
}

export function profileMatches(profile, device, simulated = false) {
  const identity = deviceIdentity(device);
  if (!profile || profile.version !== C.version || !identity) return false;
  if (Boolean(profile.simulated) !== Boolean(simulated)) return false;
  if (profile.device?.id !== identity.id) return false;
  if (Boolean(profile.simulated) !== (identity.id === C.simulatedDeviceId)) return false;
  const draft = draftErrors(profile);
  if (!draft.ok) return false;
  for (const name of READING_NAMES) {
    const stored = profile[name];
    const canonical = draft.readings[name];
    if (!stored || stored.mean !== canonical.mean) return false;
    if (stored.source && stored.source !== canonical.source) return false;
    if (!stored.source && canonical.source !== 'captured') return false;
    if (Boolean(stored.commandSent) !== canonical.commandSent) return false;
    if (canonical.source === 'captured' && (stored.count !== C.sampleCount || !Number.isFinite(stored.std))) return false;
    if (canonical.source === 'entered' && hasMeasuredProof(stored)) return false;
  }
  const applied = profile.applied;
  const bounds = profile.bounds;
  if (!applied || !bounds) return false;
  if (['cutoffMin', 'cutoffMax', 'minHysteresis', 'resetFloor', 'adjustmentStep'].some(key => toCents(bounds[key]) !== toCents(draft.bounds[key]))) return false;
  if (!appliedFits(applied, draft)) return false;
  return toCents(applied.threshold) - toCents(applied.resetThreshold) >= toCents(bounds.minHysteresis);
}

export function outputPermitted(profile, device, simulated, sample, now) {
  if (!profileMatches(profile, device, simulated)) return false;
  if (!sample || !finiteKpa(sample.kpa) || !Number.isFinite(sample.at) || !Number.isFinite(now)) return false;
  if (sample.at > now || now - sample.at > C.maxSampleAgeMs) return false;
  return toCents(sample.kpa) < toCents(profile.applied.resetThreshold);
}

export function storageKey(simulated) {
  return simulated ? C.simStorageKey : C.realStorageKey;
}

export function readStore(storage, simulated = false) {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(storageKey(simulated)) || 'null');
    if (!parsed || (parsed.version !== 1 && parsed.version !== C.version) || typeof parsed.devices !== 'object' || !parsed.devices) return {};
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
  const saved = readStore(storage, simulated)[identity.id] || null;
  if (!saved) return null;
  const migrated = migrateProfile(saved);
  if (!profileMatches(migrated, identity, simulated)) return null;
  if (migrated !== saved) {
    const devices = readStore(storage, simulated);
    devices[identity.id] = migrated;
    writeStore(storage, devices, simulated);
    return readStore(storage, simulated)[identity.id];
  }
  return migrated;
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
    this.setPressure(SIM_HOLDS[name]);
  }

  setPressure(kpa) {
    if (typeof kpa !== 'number' || !Number.isFinite(kpa)) throw new Error('Enter a finite kPa number.');
    this.hold = kpa;
    this.pressure = kpa;
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
