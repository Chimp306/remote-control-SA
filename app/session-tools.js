/**
 * CTMP V2.1 local persistence, pressure filtering and development telemetry.
 * No device credentials are stored here.
 */
export const PROFILE_KEY = 'ctmp.profile.v2.1';
export const RECOVERY_KEY = 'ctmp.session-recovery.v2.1';
export const DATA_KEY = 'ctmp.last-session-data.v2.1';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const clone = value => JSON.parse(JSON.stringify(value));

function storageGet(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
export function clearStored(key) {
  try { localStorage.removeItem(key); return true; } catch { return false; }
}

export function loadProfile() {
  const value = storageGet(PROFILE_KEY);
  return value && value.version === 1 ? value : null;
}
export function saveProfile(profile) {
  return storageSet(PROFILE_KEY, { version: 1, savedAt: Date.now(), ...clone(profile) });
}

export function loadRecovery() {
  const value = storageGet(RECOVERY_KEY);
  return value && value.version === 1 ? value : null;
}
export function saveRecovery(recovery) {
  return storageSet(RECOVERY_KEY, { version: 1, savedAt: Date.now(), ...clone(recovery) });
}
export function clearRecovery() { return clearStored(RECOVERY_KEY); }

export function loadLastSessionData() {
  const value = storageGet(DATA_KEY);
  return value && value.version === 1 ? value : null;
}
export function saveLastSessionData(data) {
  return storageSet(DATA_KEY, { version: 1, savedAt: Date.now(), ...clone(data) });
}

export class PressureFilter {
  constructor({ alpha = 0.34, window = 5 } = {}) {
    this.alpha = Math.max(0.05, Math.min(1, Number(alpha) || 0.34));
    this.window = Math.max(1, Math.min(9, Math.round(Number(window) || 5)));
    this.samples = [];
    this.value = null;
  }
  reset(value = null) {
    this.samples = [];
    this.value = finite(value) ? value : null;
    return this.value;
  }
  push(value) {
    if (!finite(value)) return this.value;
    this.samples.push(value);
    if (this.samples.length > this.window) this.samples.shift();
    const sorted = [...this.samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    this.value = this.value === null ? median : this.value + this.alpha * (median - this.value);
    return Math.round(this.value * 100) / 100;
  }
}

const csvValue = value => {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
};

export class SessionRecorder {
  constructor({ now = () => Date.now(), maxRows = 30000 } = {}) {
    this.now = now;
    this.maxRows = maxRows;
    this.reset();
  }
  reset() {
    this.startedAt = null;
    this.endedAt = null;
    this.meta = {};
    this.rows = [];
    this.events = [];
    this.lastSampleAt = 0;
  }
  start(meta = {}) {
    this.reset();
    this.startedAt = this.now();
    this.meta = clone(meta);
    this.event('session-start', meta);
  }
  restore(data) {
    if (!data || data.version !== 1 || !data.startedAt) return false;
    const started = Date.parse(data.startedAt);
    if (!Number.isFinite(started)) return false;
    this.startedAt = started;
    this.endedAt = null;
    this.meta = clone(data.meta || {});
    this.rows = Array.isArray(data.rows) ? clone(data.rows).slice(-this.maxRows) : [];
    this.events = Array.isArray(data.events) ? clone(data.events).slice(-5000) : [];
    this.lastSampleAt = this.rows.length ? Date.parse(this.rows.at(-1).at) || 0 : 0;
    this.event('session-restored');
    return true;
  }
  get active() { return this.startedAt !== null && this.endedAt === null; }
  get runtimeMs() {
    if (this.startedAt === null) return 0;
    return Math.max(0, (this.endedAt ?? this.now()) - this.startedAt);
  }
  sample(snapshot, extra = {}, force = false) {
    if (this.startedAt === null) return;
    const at = this.now();
    if (!force && at - this.lastSampleAt < 1000) return;
    this.lastSampleAt = at;
    const row = {
      at: new Date(at).toISOString(),
      elapsedSeconds: Math.round((at - this.startedAt) / 100) / 10,
      phase: snapshot?.phase ?? '',
      pressureKpa: finite(snapshot?.pressure) ? snapshot.pressure : null,
      cutoffKpa: finite(snapshot?.threshold) ? snapshot.threshold : null,
      resetKpa: finite(snapshot?.resetThreshold) ? snapshot.resetThreshold : null,
      edgeCount: Number.isSafeInteger(snapshot?.edgeCount) ? snapshot.edgeCount : 0,
      outputPercent: finite(snapshot?.outputPercent) ? snapshot.outputPercent : 0,
      outputA: finite(snapshot?.outputPercentA) ? snapshot.outputPercentA : 0,
      outputB: finite(snapshot?.outputPercentB) ? snapshot.outputPercentB : 0,
      cycleSeconds: finite(snapshot?.cycleElapsedSeconds) ? snapshot.cycleElapsedSeconds : null,
      recoveryMin: finite(snapshot?.recoveryMinSeconds) ? snapshot.recoveryMinSeconds : null,
      recoveryMax: finite(snapshot?.recoveryMaxSeconds) ? snapshot.recoveryMaxSeconds : null,
      recoveryBase: finite(snapshot?.recoveryBaseSeconds) ? snapshot.recoveryBaseSeconds : null,
      recoveryActual: finite(snapshot?.recoverySeconds) ? snapshot.recoverySeconds : null,
      recoveryRemaining: finite(snapshot?.remainingCooldown) ? snapshot.remainingCooldown : 0,
      adaptiveMultiplier: finite(snapshot?.adaptiveMultiplier) ? snapshot.adaptiveMultiplier : 1,
      pattern: snapshot?.pattern ?? '',
      toy: snapshot?.toy ?? '',
      mode: snapshot?.mode ?? '',
      ...clone(extra),
    };
    this.rows.push(row);
    if (this.rows.length > this.maxRows) this.rows.splice(0, this.rows.length - this.maxRows);
  }
  event(type, data = {}) {
    if (this.startedAt === null) return;
    const at = this.now();
    this.events.push({
      at: new Date(at).toISOString(),
      elapsedSeconds: Math.round((at - this.startedAt) / 100) / 10,
      type: String(type).slice(0, 80),
      ...clone(data),
    });
    if (this.events.length > 5000) this.events.shift();
  }
  stop(meta = {}) {
    if (this.startedAt === null || this.endedAt !== null) return this.exportObject();
    this.event('session-end', meta);
    this.endedAt = this.now();
    return this.exportObject();
  }
  exportObject() {
    return {
      version: 1,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      endedAt: this.endedAt ? new Date(this.endedAt).toISOString() : null,
      runtimeSeconds: Math.round(this.runtimeMs / 100) / 10,
      meta: clone(this.meta),
      rows: clone(this.rows),
      events: clone(this.events),
    };
  }
  toJson() { return JSON.stringify(this.exportObject(), null, 2); }
  toCsv(data = null) {
    const rows = data?.rows || this.rows;
    const headers = rows.length ? Object.keys(rows.reduce((all, row) => Object.assign(all, row), {})) : ['at', 'elapsedSeconds'];
    return [headers.join(','), ...rows.map(row => headers.map(key => csvValue(row[key])).join(','))].join('\n');
  }
}
