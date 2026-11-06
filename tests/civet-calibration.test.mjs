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
  forgetProfile,
  legacyProfileUnusable,
  outputPermitted,
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
  assert.ok(profile.bounds.cutoffMax < profile.full.mean);
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

test('both hosts stop output before zero and say the sensor is unloaded', () => {
  const root = fs.readFileSync(new URL('../app/simple-player.js', import.meta.url), 'utf8');
  const suc = fs.readFileSync(new URL('../suc/index.html', import.meta.url), 'utf8');
  const slice = (source, start, end) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, `${start} before ${end}`);
    return source.slice(from, to);
  };
  const zero = slice(root, 'async function startZero()', 'async function startLevel');
  assert.ok(zero.indexOf('outputHeld = true') < zero.indexOf('await ensureOutputOff()'));
  assert.ok(zero.indexOf('await ensureOutputOff()') < zero.indexOf('forgetProfile('));
  assert.ok(zero.indexOf('forgetProfile(') < zero.indexOf('civet.zero()'));
  assert.match(zero, /unloaded/);
  assert.doesNotMatch(root, /act === 'zero'/);
  assert.match(root, /Zero only while the sensor is unloaded/);
  assert.match(root, /outputPermitted/);
  const sucZero = slice(suc, 'async beginZero()', 'async beginLevel');
  assert.ok(sucZero.indexOf('this.blocked=true') < sucZero.indexOf('await this.pause'));
  assert.ok(sucZero.indexOf('await this.pause') < sucZero.indexOf('forgetProfile'));
  assert.ok(sucZero.indexOf('forgetProfile') < sucZero.indexOf('.zero()'));
  const sucLevel = slice(suc, 'async beginLevel', 'acceptCalibration()');
  assert.ok(sucLevel.indexOf('await this.pause') < sucLevel.indexOf('this.calCapture='));
  assert.match(suc, /Zero only while the sensor is unloaded/);
  assert.match(suc, /not clenching/);
  assert.match(suc, /outputPermitted/);
});
