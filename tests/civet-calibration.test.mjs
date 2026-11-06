import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CIVET_CALIBRATION as C,
  SIM_HOLDS,
  adjustApplied,
  assessSamples,
  assessZero,
  deriveProfile,
  forgetProfile,
  legacyProfileUnusable,
  profileMatches,
  rememberProfile,
  storedProfile,
} from '../app/civet-calibration.js';

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

test('a sent zero command is not a measurement, and a fabricated 0 is not required', () => {
  const measured = assessZero(samples(0.4), 10_000 + 11 * 100);
  assert.equal(measured.ok, true);
  assert.notEqual(measured.mean, 0);
  assert.ok(Math.abs(measured.mean - 0.4) < 0.02);
  const far = assessZero(samples(8), 10_000 + 11 * 100);
  assert.equal(far.ok, false);
  assert.match(far.reason, /command alone/);
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
  assert.match(assessSamples(reversed, reversed.at(-1).at + 10).reason, /out of order/);
  const stale = samples(6);
  assert.match(assessSamples(stale, stale.at(-1).at + C.maxSampleAgeMs + 5).reason, /stale/);
  assert.match(assessSamples(samples(6, 10_000, C.sampleCount, 100, 0.5), now).reason, /moved too much/);
});

test('derived cutoff stays above the relaxed spread and below the half reading', () => {
  const profile = accepted();
  const noise = profile.noiseKpa;
  assert.ok(profile.applied.threshold >= profile.relaxed.mean + C.relaxedClearanceSigma * noise);
  assert.ok(profile.applied.threshold <= profile.half.mean);
  assert.ok(profile.applied.resetThreshold > profile.relaxed.mean);
  assert.ok(profile.applied.threshold - profile.applied.resetThreshold >= C.minHysteresisKpa - 0.001);
  const restNoise = profile.relaxed.mean + 3 * noise;
  assert.ok(restNoise < profile.applied.threshold);
});

test('too little range or too much variation is refused', () => {
  assert.throws(() => deriveProfile({
    device: real,
    zero: reading(0.1, { commandSent: true }),
    relaxed: reading(10, { std: 0.4 }),
    half: reading(10.5, { std: 0.4 }),
    full: reading(11, { std: 0.4 }),
  }), /too close|not enough room/);
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
  assert.ok(SIM_HOLDS.zeroed < C.postZeroMaxAbsKpa);
  assert.ok(SIM_HOLDS.relaxed < SIM_HOLDS.half && SIM_HOLDS.half < SIM_HOLDS.full);
  const profile = accepted(sim, true);
  assert.equal(profile.simulated, true);
  assert.equal(profile.device.id, C.simulatedDeviceId);
});
