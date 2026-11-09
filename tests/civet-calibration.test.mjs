import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CIVET_CALIBRATION as C,
  SIM_HOLDS,
  adjustApplied,
  assessSamples,
  assessZero,
  captureTimedOut,
  deriveProfile,
  draftErrors,
  enteredReading,
  forgetProfile,
  legacyProfileUnusable,
  migrateProfile,
  outputPermitted,
  parseEnteredKpa,
  profileMatches,
  rememberProfile,
  sourceLabel,
  storedProfile,
  toCents,
  fromCents,
} from '../app/civet-calibration.js';
import { SessionEngine } from '../app/engine.js';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
  };
}

function samples(mean, start = 10_000, count = C.sampleCount, step = 100, jitter = 0) {
  return Array.from({ length: count }, (_, index) => ({
    kpa: mean + (index % 2 === 0 ? jitter : -jitter),
    at: start + index * step,
  }));
}

const real = { id: 'civet-a', name: 'Civet' };
const other = { id: 'civet-b', name: 'Civet' };
const sim = { id: C.simulatedDeviceId, name: 'Simulated Civet' };

function reading(mean, extra = {}) {
  return { mean, std: 0.02, range: 0.08, count: 12, commandSent: extra.commandSent, ...extra };
}

function accepted(device = real, simulated = false) {
  return deriveProfile({
    device,
    simulated,
    zero: reading(0.15, { commandSent: true }),
    relaxed: reading(6),
    half: reading(12),
    full: reading(20),
  });
}

test('a sent zero command is not a measurement, and a stable offset is kept', () => {
  const now = 10_000 + 11 * 100;
  const measured = assessZero(samples(0.4), now);
  assert.equal(measured.ok, true);
  assert.notEqual(measured.mean, 0);
  assert.ok(Math.abs(measured.mean - 0.4) < 0.02);
  const offset = assessZero(samples(3.2), now);
  assert.equal(offset.ok, true);
  assert.ok(Math.abs(offset.mean - 3.2) < 0.02);
  assert.equal(offset.commandSent, true);
});

test('captures reject short, stale, gapped, reordered, and unstable samples', () => {
  const now = 10_000 + 11 * 100;
  assert.match(assessSamples(samples(6, 10_000, 5), now).reason, /Not enough/);
  const gapped = samples(6);
  const jump = C.maxGapMs + 50;
  for (let index = 4; index < gapped.length; index += 1) gapped[index] = { ...gapped[index], at: gapped[index].at + jump };
  assert.match(assessSamples(gapped, gapped.at(-1).at).reason, /gap/);
  const reversed = samples(6);
  reversed[6] = { ...reversed[6], at: reversed[5].at - 10 };
  assert.match(assessSamples(reversed, reversed.at(-1).at + 10).reason, /unique/);
  const stale = samples(6);
  assert.match(assessSamples(stale, stale.at(-1).at + C.maxSampleAgeMs + 5).reason, /stale/);
  assert.match(assessSamples(samples(6, 10_000, C.sampleCount, 100, 0.5), now).reason, /moved too much/);
});

test('derived cutoff stays inside relaxed and half and keeps a reset above relaxed', () => {
  const profile = accepted();
  assert.equal(profile.applied.threshold, 10.2);
  assert.equal(profile.applied.resetThreshold, 9);
  assert.ok(profile.applied.threshold <= profile.half.mean);
  assert.ok(profile.applied.resetThreshold > profile.relaxed.mean);
  assert.equal(profile.bounds.adjustmentStep, 0.1);
  assert.equal(profile.noiseKpa, 0.02);
});

test('a half reading that cannot fit a reset is refused, and small real gaps are not', () => {
  assert.throws(() => deriveProfile({
    device: real,
    zero: reading(0.1, { commandSent: true }),
    relaxed: reading(0.18),
    half: reading(0.19),
    full: reading(0.22),
  }), /0\.02 kPa/);
  const subtle = deriveProfile({
    device: real,
    zero: reading(0.18, { commandSent: true, std: 0.4 }),
    relaxed: reading(0.18, { std: 0.4 }),
    half: reading(0.21, { std: 0.4 }),
    full: reading(0.22, { std: 0.4 }),
  });
  assert.equal(subtle.applied.threshold, 0.2);
  assert.equal(subtle.applied.resetThreshold, 0.19);
});

test('adjustment stays inside the measured bounds and keeps hysteresis', () => {
  const profile = accepted();
  const higher = adjustApplied(profile, profile.bounds.cutoffMax);
  assert.equal(higher.applied.threshold, profile.bounds.cutoffMax);
  assert.ok(higher.applied.threshold - higher.applied.resetThreshold >= profile.bounds.minHysteresis - 0.001);
  assert.throws(() => adjustApplied(profile, profile.bounds.cutoffMax + 1), /between/);
  assert.throws(() => adjustApplied(profile, profile.relaxed.mean), /between/);
});

test('profiles do not cross devices or simulated and real stores', () => {
  const realStore = memoryStorage();
  const simStore = memoryStorage();
  const realProfile = rememberProfile(realStore, accepted());
  const simProfile = rememberProfile(simStore, accepted(sim, true));
  assert.equal(profileMatches(realProfile, other, false), false);
  assert.equal(profileMatches(realProfile, sim, true), false);
  assert.equal(profileMatches(simProfile, real, false), false);
  assert.equal(storedProfile(realStore, sim, false), null);
  assert.ok(storedProfile(simStore, sim, true));
  assert.equal(realStore.getItem(C.realStorageKey) !== null, true);
  assert.equal(realStore.getItem(C.simStorageKey), null);
  assert.equal(simStore.getItem(C.realStorageKey), null);
  forgetProfile(realStore, real, false);
  assert.equal(storedProfile(realStore, real, false), null);
  assert.equal(legacyProfileUnusable({ zero: 0, rest: 6, half: 12, full: 20 }), true);
  assert.equal(profileMatches({ version: 1, device: real, simulated: false, applied: { threshold: 10, resetThreshold: 9 } }, real, false), false);
});

test('a failed save does not report success', () => {
  const storage = {
    getItem: () => null,
    setItem() { throw new Error('quota'); },
  };
  assert.throws(() => rememberProfile(storage, accepted()), /quota|saved/);
});

test('simulated holds are reproducible and distinct', () => {
  assert.ok(SIM_HOLDS.relaxed < SIM_HOLDS.half && SIM_HOLDS.half < SIM_HOLDS.full);
  const profile = accepted(sim, true);
  assert.equal(profile.simulated, true);
  assert.equal(profile.device.id, C.simulatedDeviceId);
});

test('holds reject a burst and repeated timestamps', () => {
  const burst = samples(6, 10_000, C.sampleCount, 10);
  assert.match(assessSamples(burst, burst.at(-1).at).reason, /too quickly/);
  const repeated = samples(6);
  repeated[3] = { ...repeated[3], at: repeated[2].at };
  assert.match(assessSamples(repeated, repeated.at(-1).at).reason, /unique/);
});

test('rounding keeps reset reachable below every allowed cutoff', () => {
  const profile = accepted();
  for (let cutoff = profile.bounds.cutoffMin; cutoff <= profile.bounds.cutoffMax + 1e-9; cutoff = Math.round((cutoff + 0.1) * 10) / 10) {
    const next = adjustApplied(profile, cutoff);
    assert.ok(next.applied.resetThreshold >= next.bounds.resetFloor);
    assert.ok(next.applied.threshold - next.applied.resetThreshold >= next.bounds.minHysteresis - 1e-9);
    assert.ok(next.applied.resetThreshold < next.applied.threshold);
    assert.ok(next.applied.threshold <= next.full.mean);
    assert.ok(next.applied.threshold <= next.half.mean || next.applied.threshold <= next.bounds.cutoffMax);
  }
  assert.ok(profile.bounds.cutoffMax <= profile.full.mean);
  assert.ok(profile.applied.threshold <= profile.half.mean);
});

test('saved output needs a matching id and a fresh in-range reading', () => {
  const profile = accepted();
  const now = 50_000;
  const relaxed = { kpa: 6, at: now - 100 };
  assert.equal(outputPermitted(profile, real, false, relaxed, now), true);
  assert.equal(outputPermitted(profile, other, false, relaxed, now), false);
  assert.equal(outputPermitted(profile, real, false, { kpa: 6, at: now - C.maxSampleAgeMs - 1 }, now), false);
  assert.equal(outputPermitted(profile, real, false, { kpa: profile.full.mean + 5, at: now }, now), false);
  assert.equal(outputPermitted(profile, real, false, { kpa: profile.applied.threshold, at: now }, now), false);
  assert.equal(legacyProfileUnusable({ zero: 0, rest: 6, half: 12, full: 20 }), true);
  assert.equal(outputPermitted(null, real, false, relaxed, now), false);
});

test('a capture deadline does not accept a short hold', () => {
  const capture = { samples: samples(6, 0, 3), collectAfter: 0 };
  assert.equal(captureTimedOut(capture, C.maxWindowMs + 1), true);
  assert.equal(captureTimedOut({ samples: samples(6), collectAfter: 0 }, 1000), false);
});

test('SUC still stops output before zero and says the sensor is unloaded', () => {
  const suc = fs.readFileSync(new URL('../suc/index.html', import.meta.url), 'utf8');
  const slice = (source, start, end) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, `${start} before ${end}`);
    return source.slice(from, to);
  };
  const sucZero = slice(suc, 'async beginZero()', 'async beginLevel');
  assert.ok(sucZero.indexOf('this.blocked=true') < sucZero.indexOf('confirmConnectedOutputStopped'));
  assert.ok(sucZero.indexOf('confirmConnectedOutputStopped') < sucZero.indexOf('forgetProfile'));
  assert.ok(sucZero.indexOf('forgetProfile') < sucZero.indexOf('.zero()'));
  assert.match(sucZero, /Output is not connected/);
  const sucLevel = slice(suc, 'async beginLevel', 'acceptCalibration()');
  assert.ok(sucLevel.indexOf('confirmConnectedOutputStopped') < sucLevel.indexOf('this.calCapture='));
  assert.match(suc, /Zero only while the sensor is unloaded/);
  assert.match(suc, /not clenching/);
  assert.match(suc, /outputPermitted/);
  const sucTyped = slice(suc, 'editReading(name,raw)', 'adjustCutoff(next)');
  assert.match(sucTyped, /forgetProfile/);
  assert.doesNotMatch(sucTyped, /\.zero\(/);
  assert.match(suc, /0\.01 kPa/);
  assert.doesNotMatch(suc, /uncertain by 0\.2/);
});

function manualReadings() {
  return {
    zero: enteredReading(0.15),
    relaxed: enteredReading(6),
    half: enteredReading(12),
    full: enteredReading(20),
  };
}

test('typed numbers are not a reset and keep Steve’s 0.01 kPa readings', () => {
  assert.deepEqual(parseEnteredKpa(''), { ok: false, empty: true, reason: 'Enter a kPa number.' });
  assert.match(parseEnteredKpa('abc').reason, /finite/);
  assert.match(parseEnteredKpa('1e2').reason, /finite/);
  assert.match(parseEnteredKpa('NaN').reason, /finite/);
  assert.match(parseEnteredKpa('400').reason, /range/);
  assert.equal(parseEnteredKpa(' 0.185 ').mean, 0.19);
  for (const cents of [18, 21, 22]) {
    const packet = new DataView(new ArrayBuffer(2));
    packet.setInt16(0, cents, true);
    assert.equal(packet.getInt16(0, true) / 100, fromCents(cents));
  }
  const steve = (zero) => deriveProfile({
    device: real,
    zero: enteredReading(zero),
    relaxed: enteredReading(0.18),
    half: enteredReading(0.21),
    full: enteredReading(0.22),
  });
  for (const baseline of [0.18, 0, 0.3]) {
    const profile = steve(baseline);
    assert.equal(profile.zero.mean, baseline);
    assert.equal(profile.zero.commandSent, false);
    assert.equal(profile.zero.count, undefined);
    assert.equal(profile.noiseKpa, 0);
    assert.equal(profile.applied.threshold, 0.2);
    assert.equal(profile.applied.resetThreshold, 0.19);
    assert.equal(profile.bounds.adjustmentStep, 0.01);
    assert.equal(profile.bounds.minHysteresis, 0.01);
    assert.equal(profile.bounds.resetFloor, 0.19);
    const now = 50_000;
    assert.equal(outputPermitted(profile, real, false, { kpa: 0.18, at: now - 100 }, now), true);
    assert.equal(outputPermitted(profile, real, false, { kpa: 0.19, at: now - 100 }, now), false);
    assert.equal(outputPermitted(profile, real, false, { kpa: 0, at: now - 100 }, now), true);
  }
  const wide = deriveProfile({ device: real, ...manualReadings() });
  assert.equal(wide.applied.threshold, 10.2);
  assert.equal(wide.applied.resetThreshold, 9);
  assert.equal(wide.bounds.adjustmentStep, 0.1);
  for (let cents = toCents(wide.bounds.cutoffMin); cents <= toCents(wide.bounds.cutoffMax); cents += toCents(wide.bounds.adjustmentStep)) {
    const next = adjustApplied(wide, fromCents(cents));
    assert.equal(toCents(next.applied.threshold), cents);
    assert.ok(toCents(next.applied.resetThreshold) >= toCents(next.bounds.resetFloor));
    assert.ok(toCents(next.applied.threshold) - toCents(next.applied.resetThreshold) >= toCents(next.bounds.minHysteresis));
  }
});

test('mixed captured and typed readings keep their own sources', () => {
  const profile = deriveProfile({
    device: real,
    zero: reading(0.15, { commandSent: true }),
    relaxed: reading(6),
    half: enteredReading(12),
    full: enteredReading(20),
  });
  assert.equal(profile.zero.source, 'captured');
  assert.equal(profile.zero.commandSent, true);
  assert.equal(profile.zero.count, 12);
  assert.equal(profile.relaxed.source, 'captured');
  assert.equal(profile.half.source, 'entered');
  assert.equal(profile.half.commandSent, false);
  assert.equal(profile.half.std, undefined);
  assert.equal(profile.full.count, undefined);
  assert.equal(profile.noiseKpa, 0.02);
  assert.equal(profile.applied.threshold, 10.2);
  assert.equal(profile.applied.resetThreshold, 9);
  const captured = accepted();
  assert.equal(captured.zero.source, 'captured');
  assert.equal(captured.noiseKpa, 0.02);
  assert.equal(captured.applied.threshold, 10.2);
  assert.equal(captured.applied.resetThreshold, 9);
});

test('invalid drafts and forged proof cannot authorise output', () => {
  const bad = [
    { ...manualReadings(), half: enteredReading(6.01) },
    { ...manualReadings(), full: enteredReading(11) },
    { ...manualReadings(), zero: { source: 'entered', mean: 0.15, commandSent: true } },
    { ...manualReadings(), relaxed: { source: 'entered', mean: 6, count: 12, std: 0.01, commandSent: false } },
    { ...manualReadings(), zero: { source: 'captured', mean: 0.15, std: 0.02, count: 12, commandSent: false } },
  ];
  for (const readings of bad) {
    const issues = draftErrors(readings);
    assert.equal(issues.ok, false);
    assert.equal(Object.values(issues.errors).some(Boolean), true);
    assert.throws(() => deriveProfile({ device: real, ...readings }), /./);
  }
  const storage = memoryStorage();
  const saved = rememberProfile(storage, deriveProfile({ device: real, ...manualReadings() }));
  assert.equal(outputPermitted(saved, other, false, { kpa: 6, at: 1000 }, 1100), false);
  assert.equal(outputPermitted(saved, sim, true, { kpa: 6, at: 1000 }, 1100), false);
  forgetProfile(storage, real, false);
  assert.equal(storedProfile(storage, real, false), null);
  assert.equal(outputPermitted(storedProfile(storage, real, false), real, false, { kpa: 6, at: 1000 }, 1100), false);
  const simStorage = memoryStorage();
  rememberProfile(simStorage, deriveProfile({ device: sim, simulated: true, ...manualReadings() }));
  assert.equal(simStorage.getItem(C.realStorageKey), null);
  assert.equal(storedProfile(simStorage, real, false), null);
});

test('saved captured profiles gain source metadata without losing their proof', () => {
  const legacy = accepted();
  for (const name of ['zero', 'relaxed', 'half', 'full']) delete legacy[name].source;
  delete legacy.relaxed.commandSent;
  const storage = memoryStorage();
  storage.setItem(C.realStorageKey, JSON.stringify({ version: 1, devices: { [real.id]: legacy } }));
  const loaded = storedProfile(storage, real, false);
  assert.equal(loaded.zero.source, 'captured');
  assert.equal(loaded.zero.commandSent, true);
  assert.equal(loaded.zero.count, 12);
  assert.equal(loaded.relaxed.source, 'captured');
  assert.equal(Number.isFinite(loaded.relaxed.std), true);
  assert.equal(loaded.version, 2);
  assert.equal(loaded.applied.threshold, 10.2);
  assert.equal(loaded.applied.resetThreshold, 9);
  assert.equal(loaded.noiseKpa, 0.02);
  assert.equal(outputPermitted(loaded, real, false, { kpa: 6, at: 1000 }, 1100), true);
  assert.equal(migrateProfile(loaded), loaded);
});

test('start at relaxed 0.18 and edge once at half 0.21', () => {
  let time = 1_000;
  const engine = new SessionEngine({ now: () => time });
  const profile = deriveProfile({
    device: real,
    zero: enteredReading(0.18),
    relaxed: enteredReading(0.18),
    half: enteredReading(0.21),
    full: enteredReading(0.22),
  });
  engine.configure({ toy: 'opossum', threshold: profile.applied.threshold, resetThreshold: profile.applied.resetThreshold });
  assert.equal(engine.snapshot().threshold, 0.2);
  assert.equal(engine.snapshot().resetThreshold, 0.19);
  engine.updatePressure(0.18, time);
  engine.start();
  assert.equal(engine.snapshot().phase, 'running');
  assert.equal(engine.snapshot().edgeCount, 0);
  time += 100;
  engine.updatePressure(0.18, time);
  assert.equal(engine.snapshot().edgeCount, 0);
  time += 100;
  engine.updatePressure(0.21, time);
  assert.equal(engine.snapshot().phase, 'cooldown');
  assert.equal(engine.snapshot().edgeCount, 1);
  time += 100;
  engine.updatePressure(0.21, time);
  assert.equal(engine.snapshot().edgeCount, 1);
});
