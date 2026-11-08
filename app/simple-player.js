/**
 * Solo Civet + Opossum player. Reuses the existing engine and device
 * adapters, including their power caps and recovery limits. Grok Control
 * is enabled only on /GROK/. Test mode substitutes simulated devices.
 */
import { SessionEngine, OPOSSUM_PATTERNS } from './engine.js?v=20261108-v215';
import { CivetDevice, OpossumDevice, confirmDeviceStopped, opossumNativeLevel, opossumHardwareNative } from './devices.js?v=20261107-v212';
import { BUILD } from './config.js?v=20261108-v215';
import { ackEvent, controlEvent, createGrokSession, runAcceptedCommand, settleChannelCommand, signInFailureMessage, stateEvent } from './grok-control.js?v=20261108-v219';
import { PlayTimer, formatPlayDuration } from './play-timer.js?v=20261107-v212';
import { lifecycleDecision } from './page-lifecycle.js?v=20261107-v212';
import {
  CIVET_CALIBRATION,
  SIM_HOLDS,
  adjustApplied,
  assessSamples,
  assessZero,
  captureTimedOut,
  deriveProfile,
  draftErrors,
  enteredReading,
  forgetProfile,
  outputPermitted,
  parseEnteredKpa,
  profileMatches,
  rememberProfile,
  sourceLabel,
  storedProfile,
} from './civet-calibration.js?v=20261107-v212';

const PLAY_PATTERNS = OPOSSUM_PATTERNS.filter(name => name !== 'custom');
const PATTERN_LABELS = {
  synchronized: 'Synchronized',
  alternating: 'Opposites',
  'sine-wave': 'Sine wave',
  'offset-wave': 'Offset waves',
  chase: 'Chase',
  'ramp-up': 'Ramp up',
  'ramp-down': 'Ramp down',
  staircase: 'Staircase',
  heartbeat: 'Heartbeat',
  'random-walk': 'Random walk',
  'tease-build': 'Teasing build',
  'ping-pong': 'Ping-pong',
  'steady-pulse': 'Steady + pulse',
  sawtooth: 'Sawtooth',
  bursts: 'Bursts',
  'slow-swell': 'Slow swell',
  'edge-tease': 'Edge tease',
  pulse: 'Pulse',
  custom: 'Custom',
};
const TOY_MAX_KEY = 'ctmp-toy-max-power';
const ACTIVE = new Set(['running', 'cooldown', 'settling']);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const randomPattern = except => {
  const pool = PLAY_PATTERNS.filter(name => name !== except);
  const list = pool.length ? pool : PLAY_PATTERNS;
  return list[Math.floor(Math.random() * list.length)];
};
const patternLabel = name => PATTERN_LABELS[name] || name || '—';
const readStoredToyMax = () => {
  try {
    const stored = localStorage.getItem(TOY_MAX_KEY);
    if (stored == null || stored === '') return 40;
    const raw = Number(stored);
    if (Number.isFinite(raw)) return clamp(Math.round(raw), 5, 100);
  } catch { /* private mode */ }
  return 40;
};
const app = document.getElementById('app');

let view = 'setup';
let message = '';
let error = '';
let recoveryMin = 20;
let recoveryMax = 40;
let ticker = null;
let wakeLock = null;
let lastEdgeCount = 0;
let civetHint = 'Not connected';
let opossumHint = 'Not connected';
let testMode = new URLSearchParams(location.search).has('test');
const grokMode = /^\/GROK\/?$/.test(location.pathname);
const grokBridgeTest = grokMode && new URLSearchParams(location.search).has('bridge');
const grokPatterns = OPOSSUM_PATTERNS.filter(name => name !== 'custom');
const grok = grokMode ? createGrokSession({ patterns: grokPatterns }) : null;
let grokUserId = null;
let grokBinding = null;
let grokLink = null;
let grokLinkState = 'off';
let grokStatus = grokMode ? 'Remote control is disarmed.' : '';
let grokBotToken = '';
const grokPublished = [];
let grokPublishTimer = null;
let grokFaultKey = '';
let civet = null;
let opossum = null;
let toyMaxPower = readStoredToyMax();
let patternTimer = null;
let patternsSeen = [];
let finalElapsedVisible = false;
let calibrationMessage = '';
let calibrationDraft = { zero: null, relaxed: null, half: null, full: null };
const calibrationFields = { zero: '', relaxed: '', half: '', full: '' };
const calibrationErrors = { zero: '', relaxed: '', half: '', full: '' };
let calibrationDirty = false;
let calibrationCapture = null;
let activeProfile = null;
let outputHeld = false;
let captureTimer = null;
const playTimer = new PlayTimer();
const elapsedNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

function elapsedLabel() {
  return formatPlayDuration(playTimer.sync(engine.phase, elapsedNow()));
}

const SIM_REST = 20.3;
const SIM_REST_MIN = 20.05;
const SIM_REST_MAX = 20.7;

class SimulatedCivet {
  constructor({ onPressure = () => {}, onStatus = () => {}, now = () => Date.now() } = {}) {
    this.onPressure = onPressure;
    this.onStatus = onStatus;
    this.now = now;
    this.pressure = SIM_REST;
    this._connected = false;
    this._timer = null;
    this._spikeUntil = 0;
    this._hold = null;
    this._unstable = false;
    this._tickIndex = 0;
  }

  get connected() { return this._connected; }

  get identity() {
    if (!this._connected) return null;
    return { id: CIVET_CALIBRATION.simulatedDeviceId, name: 'Simulated Civet' };
  }

  setHold(name) {
    if (!Object.prototype.hasOwnProperty.call(SIM_HOLDS, name)) throw new Error('Unknown simulated hold.');
    this.setPressure(SIM_HOLDS[name]);
  }

  setPressure(kpa) {
    if (typeof kpa !== 'number' || !Number.isFinite(kpa)) throw new Error('Enter a finite kPa number.');
    this._hold = kpa;
    this.pressure = kpa;
    this._spikeUntil = 0;
    if (this._connected) this._emit();
  }

  setUnstable(enabled) {
    this._unstable = Boolean(enabled);
  }

  connect() {
    if (this._connected) return Promise.resolve(this);
    this._connected = true;
    this.pressure = SIM_REST;
    this._spikeUntil = 0;
    this._status('connected', 'Simulated Civet connected. No hardware is used.');
    this._start();
    this._emit();
    return Promise.resolve(this);
  }

  reconnect() { return this.connect(); }

  async zero() {
    if (!this._connected) throw new Error('Connect the simulated Civet before zeroing.');
    this._hold = SIM_HOLDS.zeroed;
    this.pressure = SIM_HOLDS.zeroed;
    this._spikeUntil = 0;
    this._emit();
    return { sent: true };
  }

  simulateEdge(threshold = 22.9) {
    if (!this._connected) throw new Error('Simulated Civet is not connected.');
    const cutoff = Number(threshold);
    this.pressure = (Number.isFinite(cutoff) ? cutoff : 22.9) + 0.8;
    this._spikeUntil = this.now() + 220;
    this._emit();
    return this.pressure;
  }

  async disconnect() {
    this._stop();
    this._connected = false;
    this._status('disconnected', 'Simulated Civet disconnected.');
  }

  _status(state, message) {
    try { this.onStatus({ state, connected: this.connected, message }); } catch { /* observer only */ }
  }

  _start() {
    this._stop();
    this._timer = setInterval(() => this._tick(), 100);
  }

  _stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _tick() {
    if (!this._connected) return;
    const at = this.now();
    if (this._hold !== null && at >= this._spikeUntil) {
      this._tickIndex += 1;
      const wobble = this._unstable ? (this._tickIndex % 2 ? 0.9 : -0.9) : 0;
      this.pressure = this._hold + wobble;
    } else if (at < this._spikeUntil) {
      this.pressure += (Math.random() - 0.5) * 0.04;
    } else if (this.pressure > SIM_REST_MAX) {
      this.pressure = Math.max(SIM_REST, this.pressure - 2.4 * 0.1);
    } else {
      this.pressure = clamp(SIM_REST + (Math.random() - 0.5) * 0.12, SIM_REST_MIN, SIM_REST_MAX);
    }
    this._emit(at);
  }

  _emit(at = this.now()) {
    try { this.onPressure(this.pressure, at); } catch { /* observer only */ }
  }
}

class SimulatedOpossum {
  constructor({ onStatus = () => {}, maxHardwarePercent = 40 } = {}) {
    this.onStatus = onStatus;
    this.levels = { a: 0, b: 0 };
    this.nativeLevels = { a: 0, b: 0 };
    this.maxDisplayWritten = 0;
    this.maxNativeWritten = 0;
    this.writeCount = 0;
    this._connected = false;
    this.setMaxHardwarePercent(maxHardwarePercent);
  }

  get connected() { return this._connected; }

  setMaxHardwarePercent(percent) {
    const next = clamp(Math.round(Number(percent) || 40), 5, 100);
    this._maxHardwarePercent = next;
    this._maxNative = opossumHardwareNative(next);
    this.nativeLevels = {
      a: Math.min(this.nativeLevels?.a || 0, this._maxNative),
      b: Math.min(this.nativeLevels?.b || 0, this._maxNative),
    };
    return this._maxNative;
  }

  connect() {
    if (this._connected) return Promise.resolve(this);
    this._connected = true;
    this.levels = { a: 0, b: 0 };
    this.nativeLevels = { a: 0, b: 0 };
    this._status('connected', `Simulated Opossum connected. Ceiling ${this._maxHardwarePercent}% of hardware (native ${this._maxNative}/200).`);
    return Promise.resolve(this);
  }

  reconnect() { return this.connect(); }

  setLevels({ a = 0, b = 0 } = {}) {
    const display = { a: clamp(Number(a) || 0, 0, 100), b: clamp(Number(b) || 0, 0, 100) };
    const native = {
      a: Math.min(this._maxNative, opossumNativeLevel(display.a, this._maxNative)),
      b: Math.min(this._maxNative, opossumNativeLevel(display.b, this._maxNative)),
    };
    this.levels = display;
    this.nativeLevels = native;
    this.maxDisplayWritten = Math.max(this.maxDisplayWritten, display.a, display.b);
    this.maxNativeWritten = Math.max(this.maxNativeWritten, native.a, native.b);
    this.writeCount += 1;
    if (native.a === 0 && native.b === 0) return this.stop();
    if (!this._connected) return Promise.reject(new Error('Simulated Opossum is not connected.'));
    return Promise.resolve({ sent: true, nativeLevels: { ...native } });
  }

  setOutput(displayPercent) { return this.setLevels({ a: displayPercent, b: 0 }); }

  stop() {
    this.levels = { a: 0, b: 0 };
    this.nativeLevels = { a: 0, b: 0 };
    return Promise.resolve({ sent: true, nativeLevels: { a: 0, b: 0 } });
  }

  async disconnect() {
    await this.stop();
    this._connected = false;
    this._status('disconnected', 'Simulated Opossum disconnected.');
  }

  _status(state, message) {
    try { this.onStatus({ state, connected: this.connected, message }); } catch { /* observer only */ }
  }
}

let outputBlendFrom = null;

function blendedOutput(levels) {
  if (!outputBlendFrom) return levels;
  if (levels.a === 0 && levels.b === 0) return levels;
  const span = Math.max(1, outputBlendFrom.ms);
  const t = clamp((Date.now() - outputBlendFrom.at) / span, 0, 1);
  const ease = t * t * (3 - 2 * t);
  const next = {
    a: outputBlendFrom.a + (levels.a - outputBlendFrom.a) * ease,
    b: outputBlendFrom.b + (levels.b - outputBlendFrom.b) * ease,
  };
  if (t >= 1) outputBlendFrom = null;
  return next;
}

function startOutputBlendFromZero() {
  outputBlendFrom = { a: 0, b: 0, at: Date.now(), ms: 1600 };
}

const engine = new SessionEngine({
  onOutput(percent, levels) {
    if (outputHeld || calibrationCapture) {
      if (opossum?.connected) return opossum.stop();
      return undefined;
    }
    const mixed = blendedOutput(levels);
    const stopped = mixed.a === 0 && mixed.b === 0;
    if (stopped) return opossum && (opossum.connected || opossumHint.toLowerCase().includes('error')) ? opossum.stop() : undefined;
    if (!opossum?.connected) return Promise.reject(new Error('Opossum is disconnected.'));
    return opossum.setLevels({ a: mixed.a, b: mixed.b });
  },
  onEvent(event) {
    const state = event.snapshot;
    if (event.type === 'edge' && state.edgeCount !== lastEdgeCount) {
      lastEdgeCount = state.edgeCount;
      applyPattern(randomPattern(engine.snapshot().opossumPattern));
      if (grokMode) publishGrokEvent('edge');
    }
    if (grokMode && state.phase === 'fault') {
      const key = `${state.reason || ''}|${state.edgeCount}`;
      if (key !== grokFaultKey) {
        grokFaultKey = key;
        publishGrokEvent('fault');
      }
    } else if (grokMode) grokFaultKey = '';
    if (view === 'play') updatePlay();
  },
});

function civetCallbacks() {
  return {
    onPressure(kpa, at) {
      engine.updatePressure(kpa, at);
      noteCalibrationSample(kpa, at);
      if (view === 'setup') updateSetupReadings();
      else updatePlay();
    },
    onStatus(status) {
      civetHint = status.message || (status.connected ? 'Connected' : 'Disconnected');
      noteGrokSensor();
      if (status.state === 'error' || status.state === 'disconnected') {
        abortCapture('The sensor disconnected. This capture was discarded.');
        activeProfile = null;
        if (!testMode && ACTIVE.has(engine.phase)) handleDeviceLoss('Civet');
      }
      refresh();
    },
  };
}

function opossumCallbacks() {
  return {
    onStatus(status) {
      opossumHint = status.message || (status.connected ? 'Connected' : 'Disconnected');
      if (!testMode && ACTIVE.has(engine.phase) && (status.state === 'error' || status.state === 'disconnected')) handleDeviceLoss('Opossum');
      refresh();
    },
  };
}

function createRealDevices() {
  civet = new CivetDevice(civetCallbacks());
  opossum = new OpossumDevice({ ...opossumCallbacks(), maxHardwarePercent: toyMaxPower });
}

function createSimulatedDevices() {
  opossum = new SimulatedOpossum({ ...opossumCallbacks(), maxHardwarePercent: toyMaxPower });
  civet = new SimulatedCivet(civetCallbacks());
}

function setToyMaxPower(value, persist = true) {
  toyMaxPower = clamp(Math.round(Number(value) || 40), 5, 100);
  if (persist) {
    try { localStorage.setItem(TOY_MAX_KEY, String(toyMaxPower)); } catch { /* private mode */ }
  }
  opossum?.setMaxHardwarePercent?.(toyMaxPower);
  const slider = document.getElementById('toy-max');
  const number = document.getElementById('toy-max-number');
  const label = document.getElementById('toy-max-value');
  if (slider && document.activeElement !== slider) slider.value = String(toyMaxPower);
  if (number && document.activeElement !== number) number.value = String(toyMaxPower);
  if (label) label.textContent = `${toyMaxPower}%`;
  const playLabel = document.getElementById('toy-max-label');
  if (playLabel) playLabel.textContent = `Toy max ${toyMaxPower}%`;
}

function notePattern(name) {
  if (name && patternsSeen[patternsSeen.length - 1] !== name) patternsSeen.push(name);
}

function applyPattern(name) {
  if (!PLAY_PATTERNS.includes(name) && name !== 'custom') return;
  const before = engine.snapshot().opossumPattern;
  try {
    engine.configure({ opossumPattern: name, patternBlendSeconds: 1.6 });
    notePattern(name);
    schedulePatternRotation();
  } catch { /* keep current pattern */ }
  if (grokMode && engine.snapshot().opossumPattern !== before) publishGrokEvent('pattern');
  if (view === 'play') updatePlay();
}

function schedulePatternRotation() {
  if (patternTimer) clearTimeout(patternTimer);
  patternTimer = null;
  // Patterns change only at start and after each edge; no timed rotation.
}

function stopPatternRotation() {
  if (patternTimer) clearTimeout(patternTimer);
  patternTimer = null;
}

function testSnapshot() {
  const state = engine.snapshot();
  return {
    pattern: state.opossumPattern,
    patternLabel: patternLabel(state.opossumPattern),
    patternsSeen: [...patternsSeen],
    phase: state.phase,
    edges: state.edgeCount,
    barA: state.outputPercentA,
    barB: state.outputPercentB,
    displayA: opossum?.levels?.a ?? state.outputPercentA,
    displayB: opossum?.levels?.b ?? state.outputPercentB,
    nativeA: opossum?.nativeLevels?.a ?? null,
    nativeB: opossum?.nativeLevels?.b ?? null,
    maxDisplayWritten: opossum?.maxDisplayWritten ?? 0,
    maxNativeWritten: opossum?.maxNativeWritten ?? 0,
    maxNativeAllowed: opossum?._maxNative ?? opossumHardwareNative(toyMaxPower),
    toyMaxPower,
    writeCount: opossum?.writeCount ?? 0,
    ceilingOk: (opossum?.maxNativeWritten ?? 0) <= (opossum?._maxNative ?? opossumHardwareNative(toyMaxPower)),
    barsOk: state.outputPercentA <= 100 && state.outputPercentB <= 100 && state.outputPercentA >= 0 && state.outputPercentB >= 0,
    elapsedMs: playTimer.sync(state.phase, elapsedNow()),
    elapsedLabel: formatPlayDuration(playTimer.displayMs(elapsedNow())),
    paused: state.phase === 'paused',
    reason: state.reason || '',
  };
}

async function detachCurrentDevices() {
  try { await civet?.disconnect?.(); } catch { /* best effort */ }
  try { await opossum?.disconnect?.(); } catch { /* best effort */ }
}

async function enableTestMode() {
  await detachCurrentDevices();
  testMode = true;
  createSimulatedDevices();
  await Promise.all([civet.connect(), opossum.connect()]);
  refreshStoredProfile();
  message = 'Test mode on. Simulated Civet and Opossum are running; nothing is sent to hardware.';
  error = '';
}

async function disableTestMode() {
  await detachCurrentDevices();
  testMode = false;
  activeProfile = null;
  calibrationDraft = { zero: null, relaxed: null, half: null, full: null };
  for (const name of ['zero', 'relaxed', 'half', 'full']) {
    calibrationFields[name] = '';
    calibrationErrors[name] = '';
  }
  calibrationDirty = false;
  calibrationCapture = null;
  createRealDevices();
  civetHint = 'Not connected';
  opossumHint = 'Not connected';
  message = 'Test mode off. Connect your Civet and Opossum to play.';
  error = '';
}

engine.configure({
  toy: 'opossum',
  mode: 'solo',
  startPercent: 10,
  rampSeconds: 60,
  maxPercentA: 100,
  maxPercentB: 100,
  recoveryMinSeconds: recoveryMin,
  recoveryMaxSeconds: recoveryMax,
  adaptiveEnabled: true,
  opossumPattern: 'synchronized',
  patternBlendSeconds: 1.6,
});

function handleDeviceLoss(name) {
  error = `${name} disconnected. Output was stopped.`;
  abortCapture(`${name} disconnected. The capture was discarded.`);
  if (name === 'Civet') activeProfile = null;
  try { engine.fault(`${name} disconnected.`); } catch { /* already faulted */ }
  opossum?.stop?.().catch(() => {});
  grokDisarm('device');
}

function setRecovery(nextMin, nextMax) {
  let min = clamp(Math.round(Number(nextMin) || recoveryMin), 1, 300);
  let max = clamp(Math.round(Number(nextMax) || recoveryMax), 1, 300);
  if (max < min) max = min;
  recoveryMin = min;
  recoveryMax = max;
  engine.configure({ recoveryMinSeconds: min, recoveryMaxSeconds: max });
}

function fresh() {
  return Boolean(engine.snapshot().sensorFresh);
}

function sensorIdentity() {
  return civet?.identity || null;
}

function profileReady() {
  return profileMatches(activeProfile, sensorIdentity(), testMode);
}

function applyActiveProfile() {
  if (!profileReady()) return;
  engine.configure({
    threshold: activeProfile.applied.threshold,
    resetThreshold: activeProfile.applied.resetThreshold,
  });
}

function syncDraftFromProfile(profile) {
  if (!profile) return;
  calibrationDraft = { zero: profile.zero, relaxed: profile.relaxed, half: profile.half, full: profile.full };
  for (const name of ['zero', 'relaxed', 'half', 'full']) {
    calibrationFields[name] = Number(profile[name].mean).toFixed(2);
    calibrationErrors[name] = '';
  }
}

function refreshStoredProfile() {
  if (calibrationDirty || calibrationCapture) {
    activeProfile = null;
    return;
  }
  activeProfile = storedProfile(localStorage, sensorIdentity(), testMode);
  if (activeProfile) {
    applyActiveProfile();
    syncDraftFromProfile(activeProfile);
  }
}

function paintCalibration() {
  const status = document.getElementById('calibration-status');
  if (status) {
    status.textContent = calibrationMessage || (profileReady()
      ? `This sensor is calibrated. Cutoff ${activeProfile.applied.threshold.toFixed(2)} kPa, reset ${activeProfile.applied.resetThreshold.toFixed(2)} kPa.`
      : 'No accepted profile for the connected sensor.');
  }
  for (const name of ['zero', 'relaxed', 'half', 'full']) {
    const source = document.getElementById(`cal-source-${name}`);
    const error = document.getElementById(`cal-error-${name}`);
    if (source) source.textContent = sourceLabel(calibrationDraft[name], name);
    if (error) error.textContent = calibrationErrors[name] || '';
  }
  const play = document.querySelector('[data-act="play"]');
  if (play) play.disabled = !canPlay();
  const accept = document.querySelector('[data-act="cal-accept"]');
  if (accept) accept.disabled = Boolean(calibrationCapture);
  for (const button of document.querySelectorAll('[data-act="cal-zero"], [data-act="cal-level"]')) {
    button.disabled = !civet?.connected || Boolean(calibrationCapture);
  }
}

function editCalibrationField(name, raw) {
  if (!['zero', 'relaxed', 'half', 'full'].includes(name)) return;
  calibrationFields[name] = raw;
  calibrationDirty = true;
  outputHeld = true;
  if (calibrationCapture) abortCapture('Capture discarded because a number was typed.');
  outputHeld = true;
  try { forgetProfile(localStorage, sensorIdentity(), testMode); }
  catch (err) { calibrationMessage = err.message || 'The saved profile could not be cleared.'; }
  activeProfile = null;
  const parsed = parseEnteredKpa(raw);
  if (!parsed.ok) {
    calibrationDraft[name] = null;
    calibrationErrors[name] = parsed.empty ? '' : parsed.reason;
  } else {
    calibrationDraft[name] = enteredReading(parsed.mean);
    calibrationErrors[name] = '';
  }
  calibrationMessage = 'Typed numbers are not a hardware reset and were not measured. Accept the profile before output can start.';
  if (ACTIVE.has(engine.phase)) onPause('Paused because the calibration changed.');
  paintCalibration();
}

function clearCaptureTimer() {
  if (captureTimer) clearTimeout(captureTimer);
  captureTimer = null;
}

function abortCapture(reason) {
  clearCaptureTimer();
  calibrationCapture = null;
  if (!ACTIVE.has(engine.phase)) outputHeld = false;
  if (reason) calibrationMessage = reason;
}

function armCaptureTimer() {
  clearCaptureTimer();
  const capture = calibrationCapture;
  captureTimer = setTimeout(() => {
    if (calibrationCapture !== capture) return;
    abortCapture('The hold timed out before enough stable samples arrived.');
    void opossum?.stop?.();
    render();
  }, CIVET_CALIBRATION.discardAfterZeroMs + CIVET_CALIBRATION.maxWindowMs + 50);
}

function noteCalibrationSample(kpa, at) {
  const capture = calibrationCapture;
  if (!capture || !civet?.connected) {
    if (capture) abortCapture('The sensor disconnected before the hold finished.');
    return;
  }
  if (capture.kind === 'zero' && at < capture.discardUntil) return;
  if (capture.samples.length && at <= capture.samples[capture.samples.length - 1].at) return;
  if (captureTimedOut(capture, at)) {
    abortCapture('The hold timed out before enough stable samples arrived.');
    void opossum?.stop?.();
    render();
    return;
  }
  capture.samples.push({ kpa, at });
  const elapsed = at - capture.collectAfter;
  const ready = capture.samples.length >= CIVET_CALIBRATION.sampleCount && elapsed >= CIVET_CALIBRATION.minHoldMs;
  if (!ready && elapsed <= CIVET_CALIBRATION.maxWindowMs) return;
  const verdict = capture.kind === 'zero' ? assessZero(capture.samples, at) : assessSamples(capture.samples, at);
    clearCaptureTimer();
    calibrationCapture = null;
    if (!ACTIVE.has(engine.phase)) outputHeld = false;
    if (!verdict.ok) {
      calibrationMessage = verdict.reason;
      render();
      return;
    }
    calibrationDraft = { ...calibrationDraft, [capture.kind]: verdict };
    calibrationFields[capture.kind] = verdict.mean.toFixed(2);
    calibrationErrors[capture.kind] = '';
    calibrationDirty = true;
    const label = capture.kind === 'zero' ? 'post-zero' : capture.kind;
    calibrationMessage = `${label} measured ${verdict.mean.toFixed(2)} kPa from ${verdict.count} samples. Variation ${verdict.std.toFixed(2)} kPa is recorded, not used as a minimum gap.`;
    render();
}

async function ensureOutputOff(reason = 'Output held at zero during calibration.') {
  if (ACTIVE.has(engine.phase)) onPause(reason);
  if (!opossum?.connected) return;
  await confirmDeviceStopped(opossum);
}

function readingNow() {
  const state = engine.snapshot();
  return { kpa: state.pressure, at: state.pressureAt };
}

function canPlay() {
  return Boolean(civet?.connected && opossum?.connected && !calibrationCapture && !calibrationDirty && !outputHeld
    && outputPermitted(activeProfile, sensorIdentity(), testMode, readingNow(), Date.now()));
}

async function startZero() {
  outputHeld = true;
  if (!civet?.connected) { calibrationMessage = 'Connect the sensor before zeroing.'; outputHeld = false; render(); return; }
  if (!sensorIdentity()) { calibrationMessage = 'This browser did not provide a sensor id, so a profile cannot be matched later.'; outputHeld = false; render(); return; }
  calibrationMessage = opossum?.connected
    ? 'Stopping output, then sending the hardware zero.'
    : 'Output is not connected, so it stays off. Sending the hardware zero.';
  render();
  try { await ensureOutputOff(); }
  catch (err) { calibrationMessage = err.message || 'Output stop was not confirmed. Zero was not sent.'; render(); return; }
  try { forgetProfile(localStorage, sensorIdentity(), testMode); } catch (err) { calibrationMessage = err.message; render(); return; }
  activeProfile = null;
  calibrationDirty = true;
  calibrationDraft = { zero: null, relaxed: null, half: null, full: null };
  for (const name of ['zero', 'relaxed', 'half', 'full']) {
    calibrationFields[name] = '';
    calibrationErrors[name] = '';
  }
  calibrationCapture = null;
  let sent = false;
  try {
    const result = await civet.zero();
    sent = result?.sent !== false;
  } catch (err) {
    calibrationMessage = err.message || 'Zero command failed.';
    render();
    return;
  }
  if (!sent) { calibrationMessage = 'Zero command was not sent.'; render(); return; }
  const now = Date.now();
  calibrationCapture = { kind: 'zero', samples: [], discardUntil: now + CIVET_CALIBRATION.discardAfterZeroMs, collectAfter: now + CIVET_CALIBRATION.discardAfterZeroMs };
  armCaptureTimer();
  calibrationMessage = 'Zero command sent with the sensor unloaded. Collecting fresh samples. A sent command is not a measured baseline.';
  render();
}

async function startLevel(kind) {
  const heldBefore = outputHeld;
  outputHeld = true;
  if (!['relaxed', 'half', 'full'].includes(kind)) { outputHeld = heldBefore; return; }
  if (!civet?.connected || !sensorIdentity()) { calibrationMessage = 'The sensor is not connected.'; outputHeld = heldBefore; render(); return; }
  calibrationMessage = opossum?.connected
    ? 'Stopping output, then collecting this hold.'
    : 'Output is not connected, so it stays off. Collecting this hold.';
  render();
  try { await ensureOutputOff(); }
  catch (err) { calibrationMessage = err.message || 'Output stop was not confirmed. This capture was not started.'; outputHeld = true; render(); return; }
  try { forgetProfile(localStorage, sensorIdentity(), testMode); }
  catch (err) { calibrationMessage = err.message || 'The saved profile could not be cleared.'; render(); return; }
  activeProfile = null;
  calibrationDirty = true;
  const now = Date.now();
  calibrationCapture = { kind, samples: [], discardUntil: now, collectAfter: now };
  armCaptureTimer();
  calibrationMessage = kind === 'relaxed'
    ? 'Sensor fitted and at rest, not clenched. Hold steady.'
    : `Hold steady for the ${kind} reading.`;
  render();
}

function acceptCalibration() {
  const issues = draftErrors(calibrationDraft);
  for (const name of ['zero', 'relaxed', 'half', 'full']) calibrationErrors[name] = issues.errors?.[name] || '';
  if (!issues.ok) {
    activeProfile = null;
    calibrationDirty = true;
    outputHeld = true;
    calibrationMessage = issues.reason;
    render();
    return;
  }
  try {
    const profile = deriveProfile({
      device: sensorIdentity(),
      simulated: testMode,
      zero: calibrationDraft.zero,
      relaxed: calibrationDraft.relaxed,
      half: calibrationDraft.half,
      full: calibrationDraft.full,
    });
    activeProfile = rememberProfile(localStorage, profile);
    applyActiveProfile();
    calibrationDirty = false;
    if (!calibrationCapture && !ACTIVE.has(engine.phase)) outputHeld = false;
    syncDraftFromProfile(activeProfile);
    const typed = ['zero', 'relaxed', 'half', 'full'].some(name => activeProfile[name].source === 'entered');
    calibrationMessage = `Starting cutoff ${activeProfile.applied.threshold.toFixed(2)} kPa, reset ${activeProfile.applied.resetThreshold.toFixed(2)} kPa. ${typed ? 'Typed values are used as entered and did not send a hardware reset.' : 'Captured variation is recorded and is not a minimum gap.'}`;
  } catch (err) {
    activeProfile = null;
    calibrationDirty = true;
    outputHeld = true;
    calibrationMessage = err.message || 'Calibration could not be saved.';
  }
  render();
}

function changeCutoff(delta) {
  if (!profileReady()) { error = 'Calibrate this sensor before adjusting the cutoff.'; updatePlay(); return; }
  const before = engine.snapshot().threshold;
  try {
    activeProfile = adjustApplied(activeProfile, engine.config.threshold + delta);
    activeProfile = rememberProfile(localStorage, activeProfile);
    applyActiveProfile();
    error = '';
  } catch (err) {
    error = err.message || 'That cutoff is outside this calibration.';
  }
  if (grokMode && engine.snapshot().threshold !== before) publishGrokEvent('cutoff');
  updatePlay();
}

async function requestWake() {
  try { wakeLock = await navigator.wakeLock?.request?.('screen'); } catch { wakeLock = null; }
}

async function releaseWake() {
  try { await wakeLock?.release(); } catch { /* already released */ }
  wakeLock = null;
}

function startTicker() {
  stopTicker();
  ticker = setInterval(() => {
    if (!ACTIVE.has(engine.phase) && engine.phase !== 'paused' && engine.phase !== 'fault') return;
    engine.tick();
    if (view === 'play') updatePlay();
  }, 100);
}

function stopTicker() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

function phaseCopy(state) {
  if (state.phase === 'running') return 'Output active';
  if (state.phase === 'cooldown') return `Recovery · ${Math.max(0, Math.ceil(state.remainingCooldown))}s`;
  if (state.phase === 'settling') return 'Waiting for pressure to settle';
  if (state.phase === 'paused') return 'PAUSED';
  if (state.phase === 'fault') return state.reason || 'Stopped by a fault';
  if (state.phase === 'stopped') return 'Stopped';
  return 'Ready';
}

function formatKpa(value) {
  return Number.isFinite(value) ? value.toFixed(2) : '—';
}

function cutoffStep() {
  const step = activeProfile?.bounds?.adjustmentStep;
  return step === CIVET_CALIBRATION.resolutionKpa || step === CIVET_CALIBRATION.wideAdjustmentKpa ? step : CIVET_CALIBRATION.wideAdjustmentKpa;
}

function formatCutoffStep(step = cutoffStep()) {
  return step >= CIVET_CALIBRATION.wideAdjustmentKpa ? '0.1' : '0.01';
}

function formatPercent(value) {
  return `${Math.round(clamp(Number(value) || 0, 0, 100))}%`;
}

function calibrationFieldsHTML(civetOn) {
  const rows = [
    ['zero', 'Post-zero baseline', 'cal-zero', '', 'Zero unloaded sensor'],
    ['relaxed', 'Relaxed, fitted at rest', 'cal-level', 'relaxed', 'Capture loaded rest'],
    ['half', 'Half', 'cal-level', 'half', 'Capture half'],
    ['full', 'Full', 'cal-level', 'full', 'Capture full'],
  ];
  const enabled = civetOn && !calibrationCapture ? '' : 'disabled';
  return rows.map(([name, label, act, level, button]) => `
    <div class="cal-step">
      <div class="field">
        <label for="cal-kpa-${name}">${label} · kPa</label>
        <input id="cal-kpa-${name}" data-cal-field="${name}" type="text" inputmode="decimal" autocomplete="off" value="${escapeHtml(calibrationFields[name])}" ${calibrationCapture ? 'disabled' : ''}>
      </div>
      <p class="cal-source" id="cal-source-${name}">${escapeHtml(sourceLabel(calibrationDraft[name], name))}</p>
      <p class="cal-error" id="cal-error-${name}">${escapeHtml(calibrationErrors[name] || '')}</p>
      <button class="button" type="button" data-act="${act}" ${level ? `data-level="${level}"` : ''} ${enabled}>${button}</button>
    </div>`).join('');
}

function setupHTML() {
  const civetOn = Boolean(civet?.connected);
  const toyOn = Boolean(opossum?.connected);
  return `
    <div class="shell" data-view="setup" data-test-mode="${testMode ? '1' : '0'}">
      <div class="brand"><h1>CTMP</h1><small>${grokMode ? 'Grok Control' : 'Solo player'}</small></div>
      ${grokPanelHTML()}
      <button class="button test-toggle ${testMode ? 'on' : ''}" type="button" data-act="toggle-test" aria-pressed="${testMode ? 'true' : 'false'}">Test mode (no toys)</button>
      ${testMode ? '<p class="note">Simulated sensor and output are running. Use this to check patterns, cutoff and recovery without connecting hardware.</p>' : ''}
      <section class="panel">
        <div class="status-row">
          <div class="status-copy"><b><span class="dot ${civetOn ? 'on' : ''}"></span>Civet</b><span>${escapeHtml(civetHint)}</span></div>
          ${testMode ? '<span class="sim-tag">Simulated</span>' : `<button class="button" type="button" data-act="connect-civet">${civetOn ? 'Reconnect' : 'Connect'}</button>`}
        </div>
        <div class="status-row">
          <div class="status-copy"><b><span class="dot ${toyOn ? 'on' : ''}"></span>Opossum</b><span>${escapeHtml(opossumHint)}</span></div>
          ${testMode ? '<span class="sim-tag">Simulated</span>' : `<button class="button" type="button" data-act="connect-opossum">${toyOn ? 'Reconnect' : 'Connect'}</button>`}
        </div>
        <div class="reading"><span>Live reading</span><b id="setup-pressure">${formatKpa(engine.snapshot().pressure)} ${CIVET_CALIBRATION.unit}</b></div>
      </section>
      <section class="panel calibration-panel" data-simulated="${testMode ? '1' : '0'}">
        <p class="note">${testMode ? 'Simulated sensor. These holds are not a real Civet, and they are stored separately. ' : ''}Zero only while the sensor is unloaded and you are not clenching. The baseline is a reference and may match or sit above the loaded rest. You can capture a hold or type a known value. Typing does not send the hardware reset. Readings are used at 0.01 kPa. Output stays off until a profile for this sensor is accepted.</p>
        ${testMode ? `<div class="sim-holds">
          <button class="button" type="button" data-act="sim-hold" data-hold="relaxed">Hold relaxed</button>
          <button class="button" type="button" data-act="sim-hold" data-hold="half">Hold half</button>
          <button class="button" type="button" data-act="sim-hold" data-hold="full">Hold full</button>
          <button class="button ${civet?._unstable ? 'on' : ''}" type="button" data-act="sim-unstable" aria-pressed="${civet?._unstable ? 'true' : 'false'}">Unstable samples</button>
          <button class="button" type="button" data-act="sim-drop">Drop simulated Civet</button>
          <label class="field">Sim pressure kPa<input id="sim-pressure" data-sim-pressure type="text" inputmode="decimal" autocomplete="off"></label>
        </div>` : ''}
        <div class="stack">
          ${calibrationFieldsHTML(civetOn)}
          <button class="button button-primary" type="button" data-act="cal-accept" ${calibrationCapture ? 'disabled' : ''}>Accept starting cutoff</button>
        </div>
        <p class="note" id="calibration-status">${escapeHtml(calibrationMessage || (profileReady() ? `This sensor is calibrated. Cutoff ${activeProfile.applied.threshold.toFixed(2)} kPa, reset ${activeProfile.applied.resetThreshold.toFixed(2)} kPa.` : 'No accepted profile for the connected sensor.'))}</p>
      </section>
      <section class="panel power">
        <p class="note">Toy max power is a percentage of the Opossum's hardware maximum. App bars from 0 to 100% scale into the range you set here.</p>
        <div class="field">
          <label for="toy-max">Toy max power</label>
          <div class="power-line">
            <input id="toy-max" type="range" min="5" max="100" step="1" value="${toyMaxPower}" aria-valuemin="5" aria-valuemax="100" aria-valuenow="${toyMaxPower}">
            <input id="toy-max-number" type="number" min="5" max="100" inputmode="numeric" value="${toyMaxPower}" aria-label="Toy max power percent">
            <b id="toy-max-value">${toyMaxPower}%</b>
          </div>
        </div>
      </section>
      <section class="panel recovery">
        <p class="note">Each edge picks a recovery at random between these two times. You can change them while playing.</p>
        <div class="recovery-line">
          <div class="field"><label for="setup-min">Min seconds</label><input id="setup-min" type="number" min="1" max="300" inputmode="numeric" value="${recoveryMin}"></div>
          <div class="recovery-and">to</div>
          <div class="field"><label for="setup-max">Max seconds</label><input id="setup-max" type="number" min="1" max="300" inputmode="numeric" value="${recoveryMax}"></div>
        </div>
      </section>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
      ${message ? `<p class="note">${escapeHtml(message)}</p>` : ''}
      ${finalElapsedVisible ? `<p class="final-time" id="final-play-time"><span>Time being tormented</span><b>${elapsedLabel()}</b></p>` : ''}
      <button class="button button-primary" type="button" data-act="play" ${canPlay() ? '' : 'disabled'}>Play</button>
      <p class="note">${profileReady() && !calibrationDirty ? (testMode ? 'Simulated profile accepted. Play uses that cutoff and does not write a real sensor profile.' : 'Play uses the accepted profile for this sensor. Output never exceeds the toy max power you set above.') : 'Play stays off until this sensor has an accepted calibration. Output is held at zero while a draft is unfinished.'}</p>
      <p class="note">Switching away from this tab does not pause output while the browser keeps the page running and the Civet reading stays under a second old. If the browser freezes or closes the page, output stops and does not restart by itself. The screen wake lock only applies while this tab is visible.</p>
      <p class="fineprint">Build ${escapeHtml(BUILD)}</p>
    </div>`;
}

function playHTML() {
  const state = engine.snapshot();
  const paused = state.phase === 'paused' || state.phase === 'fault';
  const levelA = state.outputPercentA;
  const levelB = state.outputPercentB;
  return `
    <div class="shell" data-view="play" data-test-mode="${testMode ? '1' : '0'}">
      ${testMode ? '<div class="test-badge" id="test-badge">TEST MODE</div>' : ''}
      ${grokPanelHTML()}
      <div class="play-top">
        <div class="session-stats">
          <div class="stat">
            <span class="stat-label" id="edge-label">Orgasms avoided</span>
            <div class="edges" id="edge-count" aria-labelledby="edge-label">${state.edgeCount}</div>
          </div>
          <div class="stat">
            <span class="stat-label" id="play-time-label">Time being tormented</span>
            <div class="play-time" id="play-time" aria-labelledby="play-time-label">${elapsedLabel()}</div>
          </div>
        </div>
        <div class="phase${state.phase === 'paused' ? ' is-paused' : ''}" id="phase-label">${escapeHtml(phaseCopy(state))}</div>
        <div class="pattern-name" id="pattern-name">${escapeHtml(patternLabel(state.opossumPattern))}</div>
        <div class="toy-max-label" id="toy-max-label">Toy max ${toyMaxPower}%</div>
      </div>
      <section class="panel">
        <div class="metrics">
          <div class="metric"><span>Pressure</span><b id="live-pressure">${formatKpa(state.pressure)}</b></div>
          <div class="metric"><span>Cutoff</span><b id="cutoff-value">${formatKpa(state.threshold)}</b></div>
        </div>
        <div class="adjust">
          <button class="button" type="button" data-act="cutoff-down" data-step="${cutoffStep()}" aria-label="Lower cutoff by ${formatCutoffStep()} kilopascal">− ${formatCutoffStep()}</button>
          <button class="button" type="button" data-act="cutoff-up" data-step="${cutoffStep()}" aria-label="Raise cutoff by ${formatCutoffStep()} kilopascal">+ ${formatCutoffStep()}</button>
        </div>
      </section>
      ${testMode ? `
      <section class="panel output-panel">
        <p class="test-caption">Test</p>
        <div class="output-bars">
          <div class="bar-row"><span>A</span><div class="bar" aria-hidden="true"><i id="bar-a" style="width:${clamp(levelA, 0, 100)}%"></i></div><b id="level-a">${formatPercent(levelA)}</b></div>
          <div class="bar-row"><span>B</span><div class="bar" aria-hidden="true"><i id="bar-b" style="width:${clamp(levelB, 0, 100)}%"></i></div><b id="level-b">${formatPercent(levelB)}</b></div>
        </div>
        <button class="button button-primary" type="button" data-act="simulate-edge">Simulate edge</button>
      </section>` : ''}
      <section class="panel recovery">
        <p class="note" id="recovery-now">Next recovery will be a random time between these limits. Current recovery ${Number(state.recoverySeconds || recoveryMin).toFixed(1)}s.</p>
        <div class="recovery-line">
          <div class="field"><label for="play-min">Min seconds</label><input id="play-min" type="number" min="1" max="300" inputmode="numeric" value="${recoveryMin}"></div>
          <div class="recovery-and">to</div>
          <div class="field"><label for="play-max">Max seconds</label><input id="play-max" type="number" min="1" max="300" inputmode="numeric" value="${recoveryMax}"></div>
        </div>
      </section>
      ${error ? `<p class="error" id="play-error">${escapeHtml(error)}</p>` : '<p class="error" id="play-error" hidden></p>'}
      <div class="stack play-actions">
        ${paused
          ? '<button class="button button-primary button-pause" type="button" data-act="resume">Resume</button>'
          : '<button class="button button-pause" type="button" data-act="pause">Pause</button>'}
        <button class="button button-danger" type="button" data-act="stop">Stop</button>
      </div>
    </div>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function render() {
  app.innerHTML = view === 'play' ? playHTML() : setupHTML();
}

function updateSetupReadings() {
  const node = document.getElementById('setup-pressure');
  if (node) node.textContent = `${formatKpa(engine.snapshot().pressure)} kPa`;
  const play = document.querySelector('[data-act="play"]');
  if (play) play.disabled = !canPlay();
  const status = document.getElementById('calibration-status');
  if (status && calibrationMessage) status.textContent = calibrationMessage;
}

function displayedLevels(state) {
  if (testMode && opossum?.levels) return { a: opossum.levels.a, b: opossum.levels.b };
  return { a: state.outputPercentA, b: state.outputPercentB };
}

function updateOutputBars(state) {
  const levels = displayedLevels(state);
  const barA = document.getElementById('bar-a');
  const barB = document.getElementById('bar-b');
  const levelA = document.getElementById('level-a');
  const levelB = document.getElementById('level-b');
  if (barA) barA.style.width = `${clamp(levels.a, 0, 100)}%`;
  if (barB) barB.style.width = `${clamp(levels.b, 0, 100)}%`;
  if (levelA) levelA.textContent = formatPercent(levels.a);
  if (levelB) levelB.textContent = formatPercent(levels.b);
}

function updatePlay() {
  if (view !== 'play') return;
  if (!document.querySelector('[data-view="play"]')) { render(); return; }
  const state = engine.snapshot();
  const edges = document.getElementById('edge-count');
  const playTime = document.getElementById('play-time');
  const phase = document.getElementById('phase-label');
  const pressure = document.getElementById('live-pressure');
  const cutoff = document.getElementById('cutoff-value');
  const recovery = document.getElementById('recovery-now');
  const playError = document.getElementById('play-error');
  if (edges) edges.textContent = String(state.edgeCount);
  if (playTime) playTime.textContent = elapsedLabel();
  if (phase) {
    phase.textContent = phaseCopy(state);
    phase.classList.toggle('is-paused', state.phase === 'paused');
  }
  if (pressure) pressure.textContent = formatKpa(state.pressure);
  if (cutoff) cutoff.textContent = formatKpa(state.threshold);
  if (recovery) recovery.textContent = `Next recovery will be a random time between these limits. Current recovery ${Number(state.recoverySeconds || recoveryMin).toFixed(1)}s.`;
  const patternName = document.getElementById('pattern-name');
  const toyMaxLabel = document.getElementById('toy-max-label');
  if (patternName) patternName.textContent = patternLabel(state.opossumPattern);
  if (toyMaxLabel) toyMaxLabel.textContent = `Toy max ${toyMaxPower}%`;
  if (playError) {
    if (error) { playError.hidden = false; playError.textContent = error; }
    else playError.hidden = true;
  }
  updateOutputBars(state);
  const wantsResume = state.phase === 'paused' || state.phase === 'fault';
  const hasResume = Boolean(document.querySelector('[data-act="resume"]'));
  if (wantsResume !== hasResume) render();
}

function refresh() {
  if (view === 'setup') render();
  else updatePlay();
}

function readRecoveryFrom(minId, maxId) {
  const minNode = document.getElementById(minId);
  const maxNode = document.getElementById(maxId);
  if (!minNode || !maxNode) return;
  setRecovery(minNode.value, maxNode.value);
  if (document.activeElement !== minNode) minNode.value = String(recoveryMin);
  if (document.activeElement !== maxNode) maxNode.value = String(recoveryMax);
}

function readToyMaxFromSetup() {
  const slider = document.getElementById('toy-max');
  const number = document.getElementById('toy-max-number');
  const source = document.activeElement === number ? number : (slider || number);
  if (!source) return;
  setToyMaxPower(source.value);
}

function grokContext() {
  const state = engine.snapshot();
  const bounds = activeProfile?.bounds;
  return {
    phase: state.phase,
    sensorFresh: state.sensorFresh === true,
    outputPermitted: outputPermitted(activeProfile, sensorIdentity(), testMode, readingNow(), Date.now()),
    deviceId: sensorIdentity()?.id || null,
    threshold: state.threshold,
    cutoffMin: bounds?.cutoffMin ?? state.threshold,
    cutoffMax: bounds?.cutoffMax ?? state.threshold,
    pattern: state.opossumPattern,
  };
}

function grokStatePayload() {
  const state = engine.snapshot();
  return stateEvent({
    sessionId: grok?.sessionId || null,
    epoch: grok?.epoch || 0,
    armed: grok?.armed === true,
    phase: state.phase,
    sensorFresh: state.sensorFresh === true,
    pressureKpa: state.pressure,
    threshold: state.threshold,
    resetThreshold: state.resetThreshold,
    edgeCount: state.edgeCount,
    pattern: state.opossumPattern,
    outputPercentA: state.outputPercentA,
    outputPercentB: state.outputPercentB,
    recoveryMin,
    recoveryMax,
    civetConnected: Boolean(civet?.connected),
    opossumConnected: Boolean(opossum?.connected),
    link: grokLinkState,
    publishedAt: Date.now(),
  });
}

function publishGrokEvent(kind) {
  if (!grokMode) return;
  const state = engine.snapshot();
  void publishGrok('event', controlEvent({
    event: kind,
    id: crypto.randomUUID(),
    at: Date.now(),
    sessionId: grok?.sessionId || null,
    epoch: grok?.epoch || 0,
    phase: state.phase,
    edgeCount: state.edgeCount,
    pattern: state.opossumPattern,
    sensorFresh: state.sensorFresh === true,
    pressureKpa: state.pressure,
    threshold: state.threshold,
    resetThreshold: state.resetThreshold,
    outputPercentA: state.outputPercentA,
    outputPercentB: state.outputPercentB,
  }));
}

async function publishGrok(event, payload) {
  if (!grokMode) return;
  const binding = grokBinding;
  grokPublished.push({ event, payload });
  if (grokPublished.length > 40) grokPublished.shift();
  if (!grokLink || !grokUserId) return;
  try {
    const result = await grokLink.publish(event, payload, binding);
    if (result?.sent === false && binding && grokBinding !== binding) return;
  } catch {
    grokLinkState = 'offline';
  }
}

function noteGrokSensor() {
  if (!grokMode || !grok?.armed) return;
  const nextId = sensorIdentity()?.id || null;
  if (!nextId || nextId === grok.deviceId) return;
  grok.noteDevice(nextId);
  grokStatus = 'Remote control is disarmed because the sensor changed.';
  publishGrokEvent('fault');
  void publishGrok('state', grokStatePayload());
}

function grokDisarm(reason) {
  if (!grok?.armed && reason !== 'auth') return;
  grok?.disarm(reason);
  grokStatus = 'Remote control is disarmed. Arm again on this page before a remote start.';
  publishGrokEvent('session');
  void publishGrok('state', grokStatePayload());
}

async function applyGrokCommand(raw, binding = grokBinding) {
  if (!grok) return;
  await settleChannelCommand({
    binding,
    current: () => ({ binding: grokBinding, userId: grokUserId }),
    async run() {
      const decision = grok.evaluate(raw, grokContext(), grokUserId);
      const hold = grok.hold();
      return runAcceptedCommand({
        decision,
        hold,
        same: token => grok.same(token),
        selfOk: token => {
          if (decision.action === 'stop') return grok.selfTransition(token, 'stop');
          if (decision.action === 'pause') return grok.selfTransition(token, 'pause');
          return false;
        },
        operations: {
          async stop() {
            return onStop();
          },
          async pause() {
            grok?.localPause();
            publishGrokEvent('session');
            onPause('Paused from Grok Control.');
            let hardware = 'not-sent';
            try {
              if (opossum?.connected) { await opossum.stop(); hardware = 'not-confirmed'; }
            } catch { hardware = 'not-sent'; }
            const applied = engine.phase === 'paused';
            return { applied, hardware: applied ? hardware : 'not-sent', reason: applied ? '' : 'not-paused' };
          },
          async start() {
            const started = await onPlay(() => grok.same(hold));
            return started;
          },
          async forceCutoff() {
            const result = engine.requestRecovery('Remote cutoff.');
            return { applied: result.applied === true, hardware: result.applied ? 'not-confirmed' : 'not-sent', reason: result.reason || '' };
          },
          async changePattern(next) {
            const before = engine.snapshot().opossumPattern;
            engine.configure({ opossumPattern: next.params.pattern, patternBlendSeconds: 1.6 });
            notePattern(next.params.pattern);
            if (engine.snapshot().opossumPattern !== before) publishGrokEvent('pattern');
            return { applied: engine.snapshot().opossumPattern === next.params.pattern, hardware: 'not-confirmed', reason: '' };
          },
          async adjustCutoff(next) {
            const before = engine.snapshot().threshold;
            changeCutoff(next.params.delta);
            return { applied: engine.snapshot().threshold !== before, hardware: 'not-confirmed', reason: '' };
          },
          async setDowntime(next) {
            setRecovery(next.params.min, next.params.max);
            return { applied: recoveryMin === next.params.min && recoveryMax === next.params.max, hardware: 'not-confirmed', reason: '' };
          },
        },
      });
    },
    async publish(outcome) {
      await publishGrok('ack', ackEvent(outcome, { sessionId: grok.sessionId, epoch: grok.epoch, hardware: outcome.hardware }));
      grokStatus = outcome.applied
        ? 'Remote command applied. The radio write is not proof the toy moved.'
        : (outcome.reason || grokStatus);
      if (outcome.action === 'start' && outcome.applied) publishGrokEvent('session');
      if (view === 'play') updatePlay(); else render();
    },
  });
}

function grokPanelHTML() {
  if (!grokMode) return '';
  return `
    <section class="panel grok-banner" aria-label="Grok Control">
      <p class="test-caption">Grok Control</p>
      <p class="note">Remote start works only while this session is armed, this sensor is calibrated, and the reading is fresh. Local Stop wins. Resume stays on this page. A network stop cannot reach the toy if this page is disconnected.</p>
      <p class="note" id="grok-status">${escapeHtml(grokStatus)}</p>
      <p class="note">Link ${escapeHtml(grokLinkState)}. ${grokUserId ? 'Owner signed in.' : 'Owner sign-in is required before arming.'} Pressure is a sensor reading, not a medical status.</p>
      ${(testMode && !grokBridgeTest) || grokUserId ? '' : `<form data-grok-auth autocomplete="off">
        <label for="grok-enrollment">Enrollment code</label>
        <input id="grok-enrollment" type="password" autocomplete="off" required>
        <button class="button button-primary" type="submit">Continue</button>
      </form>
      <p class="note">One-time code from the private setup step. This page cannot create an owner and does not send email.</p>`}
      ${grokBotToken ? `<label for="grok-bot">Bot token</label><input id="grok-bot" readonly value="${escapeHtml(grokBotToken)}"><p class="note">Copy this into the bot environment once. Do not send it in chat.</p>` : ''}
      <div class="stack">
        ${grok.armed
          ? '<button class="button" type="button" data-act="grok-disarm">Disarm remote</button>'
          : `<button class="button button-primary" type="button" data-act="grok-arm" ${grokUserId ? '' : 'disabled'}>Arm Grok Control</button>`}
        ${grokUserId && !testMode ? '<button class="button" type="button" data-act="grok-sign-out">Sign out</button>' : ''}
      </div>
    </section>`;
}

async function onPlay(stillCurrent = () => true) {
  error = '';
  message = '';
  readRecoveryFrom('setup-min', 'setup-max');
  readToyMaxFromSetup();
  if (!stillCurrent()) return { applied: false, hardware: 'not-sent', reason: 'superseded' };
  if (!civet?.connected || !opossum?.connected) { error = 'Connect Civet and Opossum first.'; render(); return { applied: false, hardware: 'not-sent', reason: 'not-connected' }; }
  if (!fresh()) { error = 'Wait for a live Civet reading first.'; render(); return { applied: false, hardware: 'not-sent', reason: 'stale-sensor' }; }
  if (outputHeld || calibrationCapture) { error = 'Calibration is still holding output at zero.'; render(); return { applied: false, hardware: 'not-sent', reason: 'calibration' }; }
  if (!outputPermitted(activeProfile, sensorIdentity(), testMode, readingNow(), Date.now())) { error = 'This sensor needs a matching calibration and a fresh reading below its reset level.'; render(); return { applied: false, hardware: 'not-sent', reason: 'calibration' }; }
  try {
    engine.configure({
      toy: 'opossum',
      mode: 'solo',
      startPercent: 10,
      rampSeconds: 60,
      maxPercentA: 100,
      maxPercentB: 100,
      recoveryMinSeconds: recoveryMin,
      recoveryMaxSeconds: recoveryMax,
      adaptiveEnabled: true,
      patternBlendSeconds: 1.6,
      opossumPattern: randomPattern(),
    });
    opossum?.setMaxHardwarePercent?.(toyMaxPower);
    const state = engine.start();
    if (!stillCurrent()) return { applied: false, hardware: 'not-sent', reason: 'superseded' };
    if (state.phase === 'fault' || (state.phase !== 'running' && state.phase !== 'settling')) {
      error = state.reason || 'Could not start.';
      render();
      return { applied: false, hardware: 'not-sent', reason: error };
    }
    playTimer.reset();
    finalElapsedVisible = false;
    lastEdgeCount = 0;
    patternsSeen = [];
    outputBlendFrom = null;
    notePattern(engine.snapshot().opossumPattern);
    view = 'play';
    startTicker();
    schedulePatternRotation();
    await requestWake();
    if (!stillCurrent()) return { applied: false, hardware: 'not-sent', reason: 'superseded' };
    render();
    return { applied: true, hardware: 'not-confirmed', reason: '' };
  } catch (err) {
    error = err.message || String(err);
    render();
    return { applied: false, hardware: 'not-sent', reason: 'not-applied' };
  }
}

function onPause(reason = 'Paused.') {
  if (!ACTIVE.has(engine.phase)) return;
  error = '';
  outputBlendFrom = null;
  const fromRemote = reason.startsWith('Paused from Grok Control.');
  const ownerLeft = reason.startsWith('Owner ');
  if (grokMode && !fromRemote && !ownerLeft) {
    grok?.localPause();
    publishGrokEvent('session');
  }
  try { engine.pause(reason); } catch { /* already idle */ }
  if (!fromRemote) {
    void Promise.resolve(opossum?.stop?.()).catch(err => {
      error = err?.message || 'Output stop was not confirmed.';
      if (view === 'play') render();
    });
  }
  if (view === 'play') render();
}

async function onStop() {
  stopTicker();
  stopPatternRotation();
  outputBlendFrom = null;
  if (grokMode) {
    grok?.localStop();
    publishGrokEvent('session');
  }
  try { engine.stop(); } catch { /* already idle */ }
  finalElapsedVisible = true;
  let stopError = '';
  let hardware = 'not-sent';
  try {
    if (opossum?.connected) {
      await opossum.stop();
      hardware = 'not-confirmed';
    }
  } catch (err) {
    stopError = err?.message || 'Output stop was not confirmed.';
    hardware = 'not-sent';
  }
  await releaseWake();
  view = 'setup';
  message = stopError ? 'Session ended, but output stop was not confirmed.' : (testMode ? 'Stopped. Test mode is still on.' : 'Stopped.');
  error = stopError;
  render();
  return { applied: engine.phase === 'stopped', hardware, reason: String(stopError || '').slice(0, 120) };
}

async function onResume() {
  error = '';
  try {
    if (!civet?.connected || !opossum?.connected) throw new Error('Reconnect Civet and Opossum first.');
    if (!fresh()) throw new Error('Wait for a live Civet reading first.');
    if (outputHeld || calibrationCapture) throw new Error('Calibration is still holding output at zero.');
    if (!outputPermitted(activeProfile, sensorIdentity(), testMode, readingNow(), Date.now())) throw new Error('This sensor needs a matching calibration and a fresh reading below its reset level.');
    if (grokMode && grok?.localLatch === 'pause') grok.disarm('pause');
    startOutputBlendFromZero();
    const state = engine.resume();
    if (state.phase === 'fault') {
      outputBlendFrom = null;
      throw new Error(state.reason || 'Could not resume.');
    }
    startTicker();
    await requestWake();
    render();
  } catch (err) {
    error = err.message || String(err);
    render();
  }
}

async function onToggleTest() {
  if (view !== 'setup') return;
  try {
    if (testMode) await disableTestMode();
    else await enableTestMode();
  } catch (err) {
    error = err.message || String(err);
  }
  render();
}

function onSimulateEdge() {
  if (!testMode || typeof civet?.simulateEdge !== 'function') return;
  if (engine.phase === 'paused' || engine.phase === 'fault') return;
  try {
    civet.simulateEdge(engine.snapshot().threshold);
    updatePlay();
  } catch (err) {
    error = err.message || String(err);
    updatePlay();
  }
}

app.addEventListener('submit', event => {
  if (!event.target?.matches?.('[data-grok-auth]')) return;
  event.preventDefault();
  const field = document.getElementById('grok-enrollment');
  const secret = field?.value.trim() || '';
  if (field) field.value = '';
  if (!secret) { grokStatus = signInFailureMessage('credentials'); render(); return; }
  if (!grokLink) { grokStatus = 'Sign-in is not available yet. Nothing was sent.'; render(); return; }
  grokStatus = 'Checking the enrollment code…';
  render();
  grokLink.signIn(secret).then(() => {
    grokBotToken = grokLink.takeRefresh();
    grokStatus = 'Owner session ready on this browser.';
    render();
  }).catch(err => {
    grokBotToken = '';
    grokStatus = signInFailureMessage(err?.kind);
    render();
  });
});

app.addEventListener('click', event => {
  const button = event.target.closest('[data-act]');
  if (!button || button.disabled) return;
  const act = button.dataset.act;
  if (act === 'toggle-test') onToggleTest();
  else if (act === 'simulate-edge') onSimulateEdge();
  else if (act === 'connect-civet') {
    if (testMode) return;
    error = '';
    civet.connect().then(() => { message = 'Civet connected.'; refreshStoredProfile(); refresh(); }).catch(err => { error = err.message || String(err); refresh(); });
  } else if (act === 'connect-opossum') {
    if (testMode) return;
    error = '';
    opossum.connect().then(() => { message = 'Opossum connected.'; refresh(); }).catch(err => { error = err.message || String(err); refresh(); });
  } else if (act === 'play') onPlay();
  else if (act === 'grok-arm') {
    const deviceId = sensorIdentity()?.id;
    const owner = grokUserId || (testMode ? 'simulated-owner' : null);
    if (!grok || !deviceId || !owner) { grokStatus = 'Connect the sensor and sign in before arming.'; render(); return; }
    const result = grok.arm({ nextUserId: owner, nextDeviceId: deviceId });
    grokStatus = result.ok ? 'Armed. Remote start is allowed only while this sensor stays fresh and calibrated.' : 'Arming failed.';
    if (result.ok) publishGrokEvent('session');
    void publishGrok('state', grokStatePayload());
    render();
  }
  else if (act === 'grok-disarm') { grokDisarm('disarm'); render(); }
  else if (act === 'grok-sign-out') {
    grokOwnerLost('Signed out. Remote start stays off until you sign in and arm again.');
    grokLink?.drop();
    grokLink?.signOut().catch(() => { grokStatus = 'Signed out on this page. The account store could not be reached.'; render(); });
  }
  else if (act === 'pause') onPause();
  else if (act === 'stop') onStop();
  else if (act === 'resume') onResume();
  else if (act === 'cutoff-down') changeCutoff(-Number(button.dataset.step || cutoffStep()));
  else if (act === 'cutoff-up') changeCutoff(Number(button.dataset.step || cutoffStep()));
  else if (act === 'cal-zero') void startZero();
  else if (act === 'cal-level') void startLevel(button.dataset.level);
  else if (act === 'cal-accept') acceptCalibration();
  else if (act === 'sim-hold') { try { civet?.setHold?.(button.dataset.hold); } catch (err) { calibrationMessage = err.message; } render(); }
  else if (act === 'sim-unstable') { civet?.setUnstable?.(!civet._unstable); render(); }
  else if (act === 'sim-drop') { abortCapture('Simulated sensor dropped.'); void civet?.disconnect?.().then(() => { activeProfile = null; render(); }); }
});

app.addEventListener('change', event => {
  if (event.target.id === 'setup-min' || event.target.id === 'setup-max') readRecoveryFrom('setup-min', 'setup-max');
  if (event.target.id === 'play-min' || event.target.id === 'play-max') readRecoveryFrom('play-min', 'play-max');
  if (event.target.id === 'toy-max' || event.target.id === 'toy-max-number') readToyMaxFromSetup();
});

app.addEventListener('input', event => {
  if (event.target.dataset?.calField) {
    editCalibrationField(event.target.dataset.calField, event.target.value);
    return;
  }
  if (event.target.dataset?.simPressure !== undefined) {
    const parsed = parseEnteredKpa(event.target.value);
    if (!parsed.ok) return;
    try { civet?.setPressure?.(parsed.mean); } catch (err) { calibrationMessage = err.message; }
    const live = document.getElementById('setup-pressure');
    if (live) live.textContent = `${formatKpa(engine.snapshot().pressure)} ${CIVET_CALIBRATION.unit}`;
  }
  if (event.target.id === 'toy-max' || event.target.id === 'toy-max-number') readToyMaxFromSetup();
});

app.addEventListener('focusout', event => {
  const name = event.target.dataset?.calField;
  if (!name) return;
  const parsed = parseEnteredKpa(event.target.value);
  if (!parsed.ok) return;
  calibrationFields[name] = parsed.mean.toFixed(2);
  event.target.value = calibrationFields[name];
});

function onPageLifecycle(event) {
  const stillRunning = ACTIVE.has(engine.phase);
  if (lifecycleDecision({ type: event.type, stillRunning }) !== 'stop') {
    if (event.type === 'visibilitychange' && !document.hidden && stillRunning) void requestWake();
    return;
  }
  if (!stillRunning) return;
  const reason = event.type === 'pagehide'
    ? 'This page is closing. Output stopped.'
    : event.type === 'resume'
      ? 'The browser resumed a frozen page. Output stays stopped until you resume.'
      : 'The browser froze this page. Output stopped. Resume explicitly.';
  onPause(reason);
  releaseWake();
}

document.addEventListener('visibilitychange', onPageLifecycle);
document.addEventListener('freeze', onPageLifecycle);
document.addEventListener('resume', onPageLifecycle);
window.addEventListener('pagehide', onPageLifecycle);

if (grokMode && testMode && !grokBridgeTest) {
  grokUserId = 'simulated-owner';
  window.__ctmpGrok = {
    arm() { return grok.arm({ nextUserId: 'simulated-owner', nextDeviceId: sensorIdentity()?.id }); },
    disarm() { grokDisarm('disarm'); },
    command(raw) { return applyGrokCommand(raw); },
    published() { return grokPublished.map(item => item.event); },
    status() { return { armed: grok.armed, epoch: grok.epoch, latch: grok.localLatch, phase: engine.phase }; },
  };
}
function grokOwnerLost(status) {
  const changed = Boolean(grokUserId) || grok?.armed === true || grok?.userId != null;
  grokUserId = null;
  grokBinding = null;
  grokLinkState = 'signed-out';
  grokBotToken = '';
  if (changed) {
    grok?.authLost();
    if (ACTIVE.has(engine.phase)) onPause('Owner signed out. Output paused.');
    publishGrokEvent('session');
  }
  grokStatus = status;
  render();
}

if ((grokMode && !testMode) || grokBridgeTest) {
  import('./grok-link.js?v=20261108-v219').then(mod => {
    grokLink = mod.createGrokLink();
    grokLinkState = 'signed-out';
    render();
    grokLink.restore().catch(() => { grokLinkState = 'signed-out'; render(); });
    grokLink.onAuth((event, session) => {
      if (event === 'TOKEN_REFRESHED' && session?.user?.id && session.user.id === grokUserId) return;
      if (!session?.user?.id || event === 'SIGNED_OUT') {
        grokOwnerLost('Signed out. Remote start stays off until you sign in and arm again.');
        grokLink?.drop();
        return;
      }
      if (session.user.id !== grokUserId) {
        const hadOwner = Boolean(grokUserId) || grok?.armed === true;
        grokBinding = null;
        if (hadOwner) {
          grok?.authLost();
          if (ACTIVE.has(engine.phase)) onPause('Owner changed. Output paused.');
          publishGrokEvent('session');
        }
      }
      grokUserId = session.user.id;
      grokLinkState = 'opening';
      grokLink.open((payload, binding) => { void applyGrokCommand(payload, binding); }, session.user.id).then(opened => {
        if (!opened || opened.stale || opened.userId !== grokUserId) return;
        grokBinding = { generation: opened.generation, userId: opened.userId };
        grokLinkState = 'live';
        render();
      }).catch(() => { grokLinkState = 'offline'; render(); });
    });
  }).catch(() => { grokLinkState = 'offline'; grokStatus = 'Sign-in library did not load. Nothing was sent.'; render(); });
}
if (grokMode) {
  grokPublishTimer = setInterval(() => { if (grok?.armed) void publishGrok('state', grokStatePayload()); }, 2000);
}
if (testMode) {
  window.__ctmpTest = testSnapshot;
  window.__ctmpSimPressure = value => civet?.setPressure?.(Number(value));
  enableTestMode().finally(render);
} else {
  createRealDevices();
  render();
}
