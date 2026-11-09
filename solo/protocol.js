/**
 * Byte and HTTP shapes for the three toys and the Civet sensor.
 * The Civet and Opossum layouts are the ones already used by /suc/:
 * service 0x180C, write 0x150A, notify 0x150B.
 * D0 notifications carry a signed int16 at bytes 8–9. Dividing by 100
 * is the DG-LAB kPa scale (2042 → 20.42), not a 0–1 fraction.
 */

import {
  civetReportingCommand,
  lushNativeLevel,
  opossumHardwareNative,
  opossumNativeLevel,
  opossumPulseCommand,
  opossumStrengthCommand,
  parseCivetPressure,
} from '../app/devices.js';

export { civetReportingCommand, parseCivetPressure };

export const CIVET_SERVICE = 0x180c;
export const CIVET_WRITE = 0x150a;
export const CIVET_NOTIFY = 0x150b;

export const LUSH_PROFILES = Object.freeze([
  { service: '53300001-0023-4bd4-bbd5-a6920e4c5653', write: '53300002-0023-4bd4-bbd5-a6920e4c5653' },
  { service: '0000fff0-0000-1000-8000-00805f9b34fb', write: '0000fff2-0000-1000-8000-00805f9b34fb' },
  { service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', write: '6e400002-b5a3-f393-e0a9-e50e24dcca9e' },
]);

export const VACUGLIDE_CLUSTERS = new Set([
  'us-east-1.autoblowapi.com',
  'us-east-2.autoblowapi.com',
  'us-west-1.autoblowapi.com',
  'us-west-2.autoblowapi.com',
  'ca-central-1.autoblowapi.com',
  'ap-southeast-2.autoblowapi.com',
  'eu-west-2.autoblowapi.com',
  'eu-central-1.autoblowapi.com',
]);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function formatKpa(value) {
  if (!Number.isFinite(value)) return '–';
  return (Math.round(value * 100) / 100).toFixed(2);
}

/** Midpoint between the half and full readings, at 0.01 kPa. */
export function cutoffFrom(half, full) {
  if (!Number.isFinite(half) || !Number.isFinite(full)) return null;
  const low = Math.round(half * 100);
  const high = Math.round(full * 100);
  return Math.round((low + high) / 2) / 100;
}

export function gaugeScale(points) {
  const values = points.filter((value) => Number.isFinite(value));
  if (!values.length) return { lo: 19.5, hi: 21 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  let lo = Math.round((min - 0.12) * 100) / 100;
  let hi = Math.round((max + 0.45) * 100) / 100;
  if (hi - lo < 0.8) {
    const mid = (lo + hi) / 2;
    lo = Math.round((mid - 0.75) * 100) / 100;
    hi = Math.round((mid + 0.75) * 100) / 100;
  }
  return { lo, hi };
}

export function lushNative(displayPercent, ceilingPercent = 65) {
  const cap = clamp(Math.round(clamp(ceilingPercent, 0, 100) * 20 / 100), 0, 20);
  const percent = clamp(displayPercent, 0, 100);
  if (cap === 13) return lushNativeLevel(percent);
  return Math.min(cap, Math.floor(percent * cap / 100 + 1e-9));
}

export function lushFrame(displayPercent, ceilingPercent = 65) {
  const native = lushNative(displayPercent, ceilingPercent);
  const text = `Vibrate:${native};`;
  return { native, text, bytes: new TextEncoder().encode(text) };
}

export function opossumFrames(displayA, displayB, ceilingPercent = 40) {
  const cap = opossumHardwareNative(ceilingPercent);
  const native = {
    a: opossumNativeLevel(displayA, cap),
    b: opossumNativeLevel(displayB, cap),
  };
  return {
    native,
    cap,
    strength: opossumStrengthCommand(native, cap),
    pulse: opossumPulseCommand(native),
  };
}

export function vacuglideSpeed(displayPercent, ceiling = 35) {
  const cap = clamp(Number(ceiling) || 0, 0, 100);
  const percent = clamp(Number(displayPercent) || 0, 0, 100);
  return Math.round(percent * cap / 100);
}

export function vacuglideConnectedUrl() {
  return 'https://latency.autoblowapi.com/vacuglide/connected';
}

export function vacuglideUrl(cluster, path) {
  if (!VACUGLIDE_CLUSTERS.has(cluster)) throw new Error('Unrecognized Vacuglide cluster.');
  return `https://${cluster}${path}`;
}

export function describeOutput(toy, channels, ceiling) {
  if (toy === 'lush') return lushFrame(channels.a, ceiling).text;
  if (toy === 'vacuglide') {
    const speed = vacuglideSpeed(channels.a, ceiling);
    return speed
      ? `PUT /vacuglide/target-speed ${speed}`
      : 'PUT /vacuglide/target-speed/stop';
  }
  const frame = opossumFrames(channels.a, channels.b, ceiling);
  return `B3 ${frame.native.a},${frame.native.b} · B0 ${frame.pulse.length} bytes`;
}
