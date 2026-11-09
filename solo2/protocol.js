/** Self-contained wire formats; see README.md for manufacturer sources. */
export const DG_SERVICE = 0x180c;
export const DG_WRITE = 0x150a;
export const DG_NOTIFY = 0x150b;
export const LUSH_PROFILES = Object.freeze([
  { service: '53300001-0023-4bd4-bbd5-a6920e4c5653', write: '53300002-0023-4bd4-bbd5-a6920e4c5653' },
  { service: '0000fff0-0000-1000-8000-00805f9b34fb', write: '0000fff2-0000-1000-8000-00805f9b34fb' },
  { service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', write: '6e400002-b5a3-f393-e0a9-e50e24dcca9e' },
]);
export const VACUGLIDE_CLUSTERS = new Set([
  'us-east-1.autoblowapi.com', 'us-east-2.autoblowapi.com',
  'us-west-1.autoblowapi.com', 'us-west-2.autoblowapi.com',
  'ca-central-1.autoblowapi.com', 'ap-southeast-2.autoblowapi.com',
  'eu-west-2.autoblowapi.com', 'eu-central-1.autoblowapi.com',
]);
export const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : 0));

export function civetReportingCommand(enabled = true) {
  const bytes = new Uint8Array(17);
  bytes.set([0x50, 0x01, enabled ? 0xd0 : 0]);
  return bytes;
}

export function parseCivetPressure(bytes) {
  const view = bytes instanceof DataView ? bytes
    : ArrayBuffer.isView(bytes) ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : bytes instanceof ArrayBuffer ? new DataView(bytes) : null;
  if (!view || view.byteLength < 17 || view.getUint8(0) !== 0xd0) return null;
  return view.getInt16(8, true) / 100;
}

export function opossumFrames(a, b, hardwareCap = 40) {
  const cap = Math.floor(clamp(hardwareCap) * 2);
  const native = { a: Math.floor(clamp(a) * cap / 100), b: Math.floor(clamp(b) * cap / 100) };
  const strength = new Uint8Array([0xb3, native.a, native.b]);
  const pulse = new Uint8Array(20);
  pulse[0] = 0xb0;
  if (native.a > 0) pulse.fill(100, 8, 12);
  if (native.b > 0) pulse.fill(100, 16, 20);
  return { strength, pulse, native, cap };
}

export function lushFrame(percent) {
  const native = Math.floor(clamp(percent) / 5 + 1e-9);
  const text = `Vibrate:${native};`;
  return { native, text, bytes: new TextEncoder().encode(text) };
}

export function vacuglideSpeed(percent, speedCap = 35) {
  return Math.floor(clamp(percent) * clamp(speedCap) / 100);
}

export function vacuglideUrl(cluster, path) {
  if (!VACUGLIDE_CLUSTERS.has(cluster)) throw new Error('Unrecognised Vacuglide server.');
  if (!path.startsWith('/vacuglide/')) throw new Error('Invalid Vacuglide API path.');
  return `https://${cluster}${path}`;
}
