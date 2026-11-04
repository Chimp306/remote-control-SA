import { UI } from './ui.js?v=20261101-dual40';
import { SessionEngine } from './engine.js?v=20261101-dual40';
import { CivetDevice, LushDevice, OpossumDevice, VacuGlideDevice } from './devices.js?v=20261101-dual40';
import { Backend } from './backend.js?v=20261101-dual40';
import { runDiagnostics } from './diagnostics.js?v=20261101-dual40';
import { PressureFilter, SessionRecorder, loadProfile, saveProfile, loadRecovery, saveRecovery, clearRecovery, loadLastSessionData, saveLastSessionData } from './session-tools.js?v=20261104-v21';

const ACTIVE = new Set(['running', 'cooldown', 'settling']);
const TOYS = new Set(['lush', 'opossum', 'vacuglide']);
const CODE = /^\/([ABCDEFGHJKLMNPQRSTUVWXYZ]{6})\/?$/i;
const BEST_KEY = 'ctmp.best.v2';
const backend = new Backend();
const pressureFilter = new PressureFilter({ alpha: 0.34, window: 5 });
const recorder = new SessionRecorder();
const storedProfile = loadProfile();
let recoveryCandidate = loadRecovery();
let lastSessionData = loadLastSessionData();
const ui = new UI({ onAction: handleAction });
const match = location.pathname.match(CODE);
const hostPage = location.pathname === '/' || location.pathname === '/index.html';
const guestPage = !hostPage;
let alive = true;
let busy = false;
let simulation = false;
let simulatedPressure = 21;
let simulatedSensor = true;
let simulationBest = 0;
let best = readBest();
let newRecord = false;
let hardwareArmed = false;
let operationGeneration = 0;
let hardwareGeneration = 0;
let connectionError = '';
let wakeStatus = 'released';
let wakeSentinel = null;
let wakeBusy = false;
let wakeWarning = false;
let logs = [];
let testResults = [];
let calibration = normalizeCalibration(storedProfile?.calibration) || emptyCalibration();
let capture = null;
let navigationGuard = false;
let reconnectTimers = new Map();
let reconnectAttempts = new Map();
let guestPreview = false;
let previewOverlay = null;
let previewEndsAt = null;
let engine;
let drivers = null;
let deviceStates = { civet: { connected: false }, lush: { connected: false }, opossum: { connected: false }, vacuglide: { connected: false } };
let remote = null;
let epoch = 0;
let lastPhase = 'idle';
let hostSyncBusy = false;
let hostSyncDue = false;
let lastHostSync = 0;
let lastCommandSeq = 0;
let hadGuest = false;
let guestConnected = false;
let remoteFaulted = false;
let bestSaveBusy = false;
let pendingBestSave = null;
let guest = null;
let guestState = { phase: 'idle', mode: 'guest', outputPercent: 0, guestPercent: 0, guestPercentA: 0, guestPercentB: 0, outputPercentA: 0, outputPercentB: 0, edgeCount: 0, recoveryMinSeconds: 20, recoveryMaxSeconds: 20, recoverySeconds: 20, pattern: 'steady', epoch: 0 };
let guestBest = 0;
let guestNewRecord = false;
let guestNetwork = 'connecting';
let lastGuestPoll = 0;
let guestPollBusy = false;
let guestCommandBusy = false;
let guestPending = null;
let guestCommandTimer = null;
let guestDesired = { percent: 0, pattern: 'steady', recoveryMinSeconds: 20, recoveryMaxSeconds: 20 };
let guestDesiredUntil = 0;

function emptyCalibration() { return { mode: 'manual', zeroed: false, complete: false, step: 'zero', autoSampleMs: 1000, status: 'Connect Civet, then zero it while deflated and unloaded.', values: { zero: null, relaxed: null, partial: null, full: null } }; }
function calibrationNumber(value) { return typeof value === 'object' && value ? Number(value.mean) : Number(value); }
function normalizeCalibration(value) {
  if (!value || typeof value !== 'object') return null;
  const next = { ...emptyCalibration(), ...value, values: { ...emptyCalibration().values, ...(value.values || {}) } };
  for (const key of ['zero','relaxed','partial','full']) {
    const n = calibrationNumber(next.values[key]);
    if (Number.isFinite(n)) next.values[key] = typeof next.values[key] === 'object' ? next.values[key] : { mean: n, std: 0, range: 0, samples: 1 };
    else next.values[key] = null;
  }
  return next;
}
function profilePayload() {
  const config = engine?.snapshot() || {};
  const settings = {};
  for (const key of ['threshold','resetThreshold','startPercent','rampSeconds','maxPercentA','maxPercentB','recoveryMinSeconds','recoveryMaxSeconds','adaptiveEnabled','shortPhaseSeconds','shortPhaseCount','stablePhaseSeconds','stablePhaseCount','adaptiveMaxMultiplier','opossumPattern','patternSpeedSeconds','phaseOffset','patternMinA','patternMinB']) if (config[key] !== undefined) settings[key] = config[key];
  return { calibration, settings };
}
function persistProfile(sync = true) {
  const profile = profilePayload();
  saveProfile(profile);
  if (sync && backend.ownerToken) backend.call('profile-save', { profile }).catch(() => log('Profile saved locally; cloud backup unavailable.'));
}
function persistRecovery() {
  if (!engine || simulation) return;
  const state = engine.snapshot();
  if (['idle','stopped'].includes(state.phase)) return;
  saveRecovery({ engine: state, best, recorder: recorder.exportObject(), savedReason: state.reason });
}
function armNavigationGuard() {
  if (guestPage || navigationGuard) return;
  history.pushState({ ctmpSessionGuard: true }, '', location.href);
  navigationGuard = true;
}
function finalizeSessionData(reason = '') {
  if (!recorder.active) return;
  const data = recorder.stop({ reason, finalState: engine?.snapshot() });
  lastSessionData = data;
  saveLastSessionData(data);
}
function downloadSessionData(format = 'csv') {
  const data = recorder.startedAt !== null ? recorder.exportObject() : lastSessionData;
  if (!data) throw new Error('No session data is available yet.');
  const body = format === 'json' ? JSON.stringify(data, null, 2) : recorder.toCsv(data);
  const blob = new Blob([body], { type: format === 'json' ? 'application/json' : 'text/csv' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = 'ctmp-session-' + new Date().toISOString().replace(/[:.]/g,'-') + '.' + format;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function safeError(error) {
  return String(error?.message || error || 'The action could not be completed.')
    .replace(/(?:Bearer\s+)?[a-f0-9]{32,}/gi, '[redacted]')
    .replace(/sb_(?:secret|publishable)_[\w-]+/g, '[redacted]')
    .slice(0, 300);
}
function log(message) { logs.push({ time: new Date().toLocaleTimeString(), message: safeError(message) }); if (logs.length > 100) logs.shift(); }
function score(value) { return Number.isSafeInteger(value) && value >= 0 && value <= 1000000 ? value : 0; }
function readBest() { try { return score(Number(localStorage.getItem(BEST_KEY))); } catch { return 0; } }
function keepBest(value) {
  best = Math.max(best, score(value));
  try { localStorage.setItem(BEST_KEY, String(best)); } catch { log('Personal best is available for this page, but browser storage is unavailable.'); }
}
function requireDev() { if (!backend.ownerToken) throw new Error('Unlock Debugging first.'); }
function requireSimulation() { requireDev(); if (!simulation) throw new Error('Enable the isolated test session first.'); }
function requireInactive() { if (ACTIVE.has(engine?.phase)) throw new Error('Pause or stop the session first.'); }
function currentDriver() { return drivers?.[engine?.config.toy]; }
function freshSnapshot() { return engine?.snapshot(); }
function randomClient() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''); }
function commandLevels(command = {}) {
  // Legacy scalar requests address A only. Explicit B can never be hidden by a
  // zero scalar: every stop/cooldown decision inspects both channel values.
  const vector = command.percentA !== undefined || command.percentB !== undefined;
  return vector ? { a: command.percentA === undefined ? 0 : command.percentA, b: command.percentB === undefined ? 0 : command.percentB } : { a: command.percent ?? 0, b: 0 };
}
function commandIsZero(command, toy) {
  if (toy !== 'opossum') return command?.percent === 0;
  const levels = commandLevels(command);
  return levels.a === 0 && levels.b === 0;
}
function zeroGuestOutput(toy) { return toy === 'opossum' ? { percent: 0, percentA: 0, percentB: 0 } : { percent: 0 }; }
function desiredFromState(state) {
  const desired = { percent: Number(state.guestPercent) || 0, pattern: state.pattern || 'steady', recoveryMinSeconds: Number(state.recoveryMinSeconds) || 20, recoveryMaxSeconds: Number(state.recoveryMaxSeconds) || 20 };
  if (state.toy === 'opossum') {
    desired.percentA = Number.isFinite(state.guestPercentA) ? state.guestPercentA : desired.percent;
    desired.percentB = Number.isFinite(state.guestPercentB) ? state.guestPercentB : 0;
    desired.percent = Math.max(desired.percentA, desired.percentB);
  }
  return desired;
}

function makeEngine(isSimulation) {
  let instance;
  instance = new SessionEngine({
    simulation: isSimulation,
    onOutput: (percent, levels) => {
      if (instance !== engine || isSimulation) return;
      const device = drivers?.[instance.config.toy];
      const dual = instance.config.toy === 'opossum';
      if (dual && (!levels || !Number.isFinite(levels.a) || !Number.isFinite(levels.b))) return Promise.reject(new Error('Both Opossum channel levels are required. Reload the updated control page.'));
      const stopped = dual ? levels.a === 0 && levels.b === 0 : percent === 0;
      if (stopped) return device && (device.connected || deviceStates[instance.config.toy]?.state === 'error') ? device.stop() : undefined;
      if (document.hidden) return Promise.reject(new Error('Keep the control page visible before resuming.'));
      if (!device?.connected) return Promise.reject(new Error('The output device is disconnected.'));
      return dual ? device.setLevels({ a: levels.a, b: levels.b }) : device.setOutput(percent);
    },
    onEvent: event => {
      if (instance !== engine) return;
      const state = event.snapshot;
      if (recorder.active) {
        recorder.sample(state, {}, event.type === 'edge');
        if (event.type === 'edge') recorder.event('cutoff', { count: state.edgeCount, cycleSeconds: state.lastCycleSeconds, power: state.outputPercent, outputA: state.outputPercentA, outputB: state.outputPercentB, recoverySeconds: state.recoverySeconds, recoveryBaseSeconds: state.recoveryBaseSeconds, adaptiveMultiplier: state.adaptiveMultiplier, pressure: state.pressure });
        if (event.type === 'adaptive') recorder.event('adaptive-recovery', { multiplier: state.adaptiveMultiplier, shortStreak: state.shortPhaseStreak, stableStreak: state.stablePhaseStreak });
      }
      persistRecovery();
      const changed = state.phase !== lastPhase;
      if (changed || event.type === 'edge') {
        epoch += 1;
        lastPhase = state.phase;
        if (changed) log('Session: ' + state.phase + (state.reason ? ' — ' + state.reason : ''));
        requestHostSync();
      }
      if (event.type === 'edge') {
        const prior = simulation ? simulationBest : best;
        if (state.edgeCount > prior) {
          newRecord = true;
          if (simulation) simulationBest = state.edgeCount;
          else { keepBest(state.edgeCount); queueBestSave(best); }
        }
        log((simulation ? 'Test' : 'Pressure') + ' cutoff registered. Count ' + state.edgeCount + ' · cycle ' + (Number.isFinite(state.lastCycleSeconds) ? state.lastCycleSeconds.toFixed(1) + 's' : '—') + ' · recovery ' + (Number(state.recoverySeconds) || 0).toFixed(1) + 's.');
      }
      if (state.phase === 'fault') {
        connectionError = state.reason;
        hardwareArmed = false;
        hardwareGeneration += 1;
      }
    },
  });
  return instance;
}

function updatePressure(pressure, at = Date.now()) {
  if (!engine || simulation) return;
  const filtered = pressureFilter.push(pressure);
  engine.updatePressure(filtered, at);
  if (capture && at >= capture.startedAt && at > capture.lastAt) {
    capture.samples.push(filtered); capture.lastAt = at;
  }
  recorder.sample(engine.snapshot(), { rawPressureKpa: pressure, filteredPressureKpa: filtered });
}

function deviceStatus(name, status) {
  deviceStates = { ...deviceStates, [name]: { ...deviceStates[name], connected: Boolean(status.connected), state: status.state, status: status.message } };
  if (status.message) log(name + ': ' + status.message);
  if (status.connected) { reconnectAttempts.set(name, 0); const timer = reconnectTimers.get(name); if (timer) clearTimeout(timer); reconnectTimers.delete(name); }
  if (!simulation && (status.state === 'error' || status.state === 'disconnected')) {
    if (name === 'civet' && capture) cancelCapture('Sensor disconnected during calibration.');
    if (ACTIVE.has(engine?.phase)) {
      engine.fault(status.message || name + ' disconnected.');
      persistRecovery();
      void stopPhysical().catch(error => { connectionError = safeError(error); render(); });
    }
    if (hardwareArmed) { hardwareArmed = false; hardwareGeneration += 1; }
    scheduleReconnect(name);
  }
  render();
}
function scheduleReconnect(name) {
  if (!drivers?.[name]?.reconnect || reconnectTimers.has(name) || simulation || document.hidden) return;
  const attempt = (reconnectAttempts.get(name) || 0) + 1;
  if (attempt > 5) { log(name + ': automatic reconnect paused after 5 attempts. Use Connect if needed.'); return; }
  reconnectAttempts.set(name, attempt);
  const timer = setTimeout(async () => {
    reconnectTimers.delete(name);
    try {
      log(name + ': reconnect attempt ' + attempt + '.');
      await drivers[name].reconnect();
      connectionError = 'Connection restored. Check devices, then press Resume.';
      render();
    } catch (error) {
      log(name + ': reconnect attempt failed — ' + safeError(error));
      scheduleReconnect(name);
    }
  }, Math.min(8000, 800 * 2 ** (attempt - 1)));
  reconnectTimers.set(name, timer);
}

async function stopPhysical() {
  if (!drivers) return;
  const results = await Promise.allSettled(['lush', 'opossum', 'vacuglide'].filter(name => drivers[name] && (drivers[name].connected || deviceStates[name]?.state === 'error')).map(name => drivers[name].stop()));
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) throw new Error('Stop could not be confirmed on a device. Use its physical stop, then reconnect.');
}

async function stopSession(reason = '') {
  operationGeneration += 1;
  hardwareGeneration += 1;
  hardwareArmed = false;
  cancelCapture('Capture cancelled.');
  if (engine) engine.stop();
  ui.releaseValves();
  if (reason) log(reason);
  finalizeSessionData(reason);
  clearRecovery();
  requestHostSync();
  render();
  await stopPhysical();
}

function requireReady() {
  if (document.hidden) throw new Error('Open the control page before starting.');
  if (!calibration.complete) throw new Error('Complete Civet calibration in Device setup first.');
  if (!engine.snapshot().sensorFresh) throw new Error('Fresh Civet pressure readings are required.');
  if (!simulation && (!drivers.civet.connected || !currentDriver()?.connected)) throw new Error('Connect Civet and the selected output device first.');
  if (remote && !remote.owned) throw new Error('End the previous guest link in Debugging before starting a new session.');
  if (engine.config.mode === 'guest' && !remote?.owned) throw new Error('Create a guest link in Debugging first.');
}

function cancelCapture(message) {
  if (!capture) return;
  const task = capture; capture = null; clearTimeout(task.timer); task.reject(new Error(message));
}

function captureReading(stage) {
  requireInactive();
  if (!['relaxed', 'partial', 'full'].includes(stage)) throw new Error('Unknown calibration step.');
  if (!calibration.zeroed) throw new Error('Zero the unloaded, deflated sensor first.');
  if (!simulation && !drivers.civet.connected) throw new Error('Connect Civet first.');
  if (!engine.snapshot().sensorFresh) throw new Error('Wait for fresh sensor readings first.');
  if (capture) throw new Error('A reading is already being captured.');
  calibration.complete = false; calibration.step = stage;
  const duration = Math.max(300, Math.min(3000, Number(calibration.autoSampleMs) || 1000));
  calibration.status = 'Automatic capture: hold ' + stage + ' steady for ' + (duration / 1000).toFixed(duration % 1000 ? 1 : 0) + ' seconds.';
  return new Promise((resolve, reject) => {
    const task = { stage, startedAt: Date.now(), lastAt: 0, samples: [], resolve, reject, timer: null };
    task.timer = setTimeout(() => {
      if (capture !== task) return;
      capture = null;
      if (task.samples.length < 15) { calibration.status = 'Not enough fresh samples. Check the connection and try again.'; reject(new Error(calibration.status)); return; }
      const mean = task.samples.reduce((sum, value) => sum + value, 0) / task.samples.length;
      const std = Math.sqrt(task.samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / task.samples.length);
      const range = Math.max(...task.samples) - Math.min(...task.samples);
      if (range > Math.max(1, Math.abs(mean) * 0.1)) { calibration.status = 'Readings moved too much. Hold steadier and retake this capture.'; reject(new Error(calibration.status)); return; }
      calibration.values[stage] = { mean, std, range, samples: task.samples.length };
      calibration.status = stage[0].toUpperCase() + stage.slice(1) + ' captured: ' + mean.toFixed(1) + ' kPa. ' + (Object.keys(calibration.values).length === 3 ? 'Select Use calibration to check the ranges.' : 'Continue with the next reading.');
      resolve();
    }, Math.max(300, Math.min(3000, Number(calibration.autoSampleMs) || 1000)));
    capture = task;
  });
}

function captureCurrent(stage) {
  requireInactive();
  if (!['zero','relaxed','partial','full'].includes(stage)) throw new Error('Unknown calibration point.');
  const value = engine.snapshot().pressure;
  if (!Number.isFinite(value)) throw new Error('Wait for a live Civet reading first.');
  calibration.values[stage] = { mean: Math.round(value * 100) / 100, std: 0, range: 0, samples: 1 };
  if (stage === 'zero') calibration.zeroed = true;
  calibration.complete = false;
  calibration.status = stage + ' set to ' + value.toFixed(2) + ' kPa. Edit it if needed, or capture another point.';
  persistProfile(false);
}
function setCalibrationValue(stage, value) {
  requireInactive();
  if (!['zero','relaxed','partial','full'].includes(stage)) throw new Error('Unknown calibration point.');
  const n = Number(value);
  if (!Number.isFinite(n) || n < -327.6 || n > 327.6) throw new Error('Enter a valid pressure reading.');
  calibration.values[stage] = { mean: Math.round(n * 100) / 100, std: 0, range: 0, samples: 1 };
  if (stage === 'zero') calibration.zeroed = true;
  calibration.complete = false;
  persistProfile(false);
}
function finishCalibration() {
  requireInactive();
  const relaxed = calibration.values.relaxed, partial = calibration.values.partial, full = calibration.values.full;
  if (!relaxed || !partial || !full) throw new Error('Set relaxed, half-clenched and fully clenched readings first.');
  const r = calibrationNumber(relaxed), p = calibrationNumber(partial), f = calibrationNumber(full);
  const rs = Number(relaxed.std) || 0, ps = Number(partial.std) || 0, fs = Number(full.std) || 0;
  if (p - r < Math.max(0.2, 3 * rs) || f - p < Math.max(0.2, 2 * ps + 2 * fs)) {
    calibration.status = 'The readings overlap or are too noisy. Adjust or recapture the affected values.';
    throw new Error(calibration.status);
  }
  const threshold = Math.round(p * 10) / 10;
  const resetThreshold = Math.round((r + Math.max(0.1, 2 * rs)) * 10) / 10;
  if (resetThreshold >= threshold - 0.1) throw new Error('The relaxed and half-clenched readings need a clearer gap.');
  engine.configure({ threshold, resetThreshold });
  calibration.complete = true; calibration.step = 'complete';
  calibration.status = 'Calibration saved. The cutoff starts at your half-clenched reading and remains editable during play.';
  persistProfile();
  log('Calibration accepted and saved.');
  ui.message('Calibration saved. Open Play to begin.');
}

async function setSimulation(enabled) {
  requireDev();
  if (remote) throw new Error('End the current guest link before switching simulation.');
  if (simulation === enabled) return;
  await stopSession('Switching test mode.');
  const disconnects = await Promise.allSettled(Object.values(drivers).map(device => device.disconnect()));
  if (disconnects.some(result => result.status === 'rejected')) throw new Error('A physical disconnect or stop was not confirmed. Check the device, then try again.');
  simulation = enabled; simulatedSensor = true; simulatedPressure = 21; simulationBest = 0; newRecord = false;
  guestPreview = false; previewOverlay = null; previewEndsAt = null; hardwareArmed = false;
  engine = makeEngine(enabled); lastPhase = 'idle'; epoch += 1;
  calibration = enabled ? { ...emptyCalibration(), zeroed: true, complete: true, step: 'complete', status: 'Simulation fixture. No live calibration or output is used.', values: { zero: { mean: 0, std: 0 }, relaxed: { mean: 21, std: 0 }, partial: { mean: 22.9, std: 0 }, full: { mean: 24, std: 0 } } } : normalizeCalibration(loadProfile()?.calibration) || emptyCalibration();
  connectionError = '';
  if (enabled) {
    engine.configure({ threshold: 22.9, resetThreshold: 21.6 });
    engine.updatePressure(simulatedPressure);
  } else {
    const profile = loadProfile();
    if (profile?.settings) { try { engine.configure(profile.settings); } catch {} }
  }
  log(enabled ? 'Isolated simulation enabled. Hardware disconnected.' : 'Simulation disabled. Saved live calibration restored.');
}

function testOverlay(record = false) {
  requireSimulation();
  const current = engine.snapshot();
  const count = record ? Math.max(best, simulationBest, current.edgeCount) + 1 : Math.max(1, current.edgeCount);
  guestPreview = true;
  const previewRecovery = Number(current.recoverySeconds ?? current.recoveryMinSeconds ?? 20);
  previewEndsAt = Date.now() + previewRecovery * 1000;
  previewOverlay = { edgeCount: count, best: record ? count : Math.max(simulationBest, count), newRecord: record, remainingCooldown: previewRecovery };
}

async function hardwarePulse() {
  requireDev(); requireInactive();
  if (simulation || !hardwareArmed) throw new Error('Enable real-device test controls first.');
  const device = currentDriver();
  if (!device?.connected) throw new Error('Connect the output device first.');
  const generation = ++hardwareGeneration;
  log('Deliberate low-output hardware test started.');
  try {
    if (engine.config.toy === 'opossum') await device.setLevels({ a: 20, b: 20 });
    else await device.setOutput(20);
    if (generation !== hardwareGeneration || document.hidden) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  } finally {
    await device.stop();
    hardwareArmed = false;
    log('Hardware test stop requested.');
  }
}

function queueBestSave(count) {
  if (!backend.ownerToken || simulation) return;
  pendingBestSave = Math.max(pendingBestSave || 0, score(count));
  void flushBestSave();
}
async function flushBestSave() {
  if (bestSaveBusy || pendingBestSave === null || !backend.ownerToken || simulation) return;
  bestSaveBusy = true;
  const count = pendingBestSave; pendingBestSave = null;
  try { const result = await backend.call('best-save', { count, simulation: false }); keepBest(result.best); }
  catch (error) { log(error.status === 409 ? 'Record sync deferred while a test session is active.' : 'Record saved on this device; server sync unavailable.'); }
  finally { bestSaveBusy = false; if (pendingBestSave !== null) void flushBestSave(); }
}

async function unlock(password) {
  if (remote?.owned) {
    remote = { ...remote, owned: false };
    engine.pause('Developer access is being renewed. End the existing link before creating another.');
    void stopPhysical().catch(error => { connectionError = safeError(error); });
  }
  const result = await backend.unlock(password);
  const status = await backend.call('owner-status');
  keepBest(Math.max(score(result.best), score(status.best)));
  if (status.profile && typeof status.profile === 'object') {
    const local = loadProfile();
    if (!local || Number(status.profile.savedAt || 0) > Number(local.savedAt || 0)) {
      const incoming = status.profile;
      const cal = normalizeCalibration(incoming.calibration);
      if (cal) calibration = cal;
      if (incoming.settings) { try { engine.configure(incoming.settings); } catch {} }
      saveProfile(incoming);
      log('Saved profile restored from cloud backup.');
    }
  }
  remote = status.activeSessionId
    ? { ...(remote?.sessionId === status.activeSessionId ? remote : {}), sessionId: status.activeSessionId, url: remote?.sessionId === status.activeSessionId ? remote.url : '', owned: false }
    : null;
  if (!simulation && best > score(status.best)) queueBestSave(best);
  log('Debugging unlocked.');
}

async function endRemote() {
  requireDev();
  const stopping = stopSession('Ending the guest link.').then(() => null, error => error);
  await backend.call('session-end', remote?.sessionId ? { sessionId: remote.sessionId } : {});
  remote = null; guestConnected = false; hadGuest = false; lastCommandSeq = 0; remoteFaulted = false;
  log('Guest link ended and invalidated.');
  const stopError = await stopping;
  if (stopError) throw stopError;
}

async function createRemote() {
  requireDev(); requireInactive();
  if (remote) await endRemote();
  engine.configure({ mode: 'guest' }); engine.setGuestOutput({ ...zeroGuestOutput(engine.config.toy), pattern: 'steady' });
  const result = await backend.call('session-create', { toy: engine.config.toy, simulation });
  remote = { sessionId: result.sessionId, code: result.code, url: location.origin + '/' + result.code, owned: true };
  epoch += 1; lastCommandSeq = 0; lastHostSync = Date.now(); guestConnected = false; hadGuest = false; remoteFaulted = false;
  log((simulation ? 'Test' : 'Guest') + ' link created.');
  requestHostSync();
}

function requestHostSync() {
  hostSyncDue = true;
  if (remote?.owned && backend.ownerToken && !hostSyncBusy) queueMicrotask(() => { void syncHost(); });
}

function remoteFault(message) {
  const first = !remoteFaulted;
  if (first) { log(message); remoteFaulted = true; }
  guestConnected = false;
  if (ACTIVE.has(engine.phase)) engine.fault(message);
  connectionError = message;
  if (first) void stopPhysical().catch(error => { connectionError = safeError(error); });
}

async function syncHost() {
  if (!remote?.owned || !backend.ownerToken || hostSyncBusy || !alive) return;
  const sessionId = remote.sessionId;
  hostSyncBusy = true; hostSyncDue = false;
  const state = engine.snapshot();
  const sentEpoch = epoch;
  const serverState = { ...state, newRecord, epoch: sentEpoch, cooldownEndsAt: state.cooldownEndsAt === null ? null : state.cooldownEndsAt + backend.clockOffset };
  try {
    const result = await backend.call('host-sync', { sessionId, state: serverState });
    if (!remote?.owned || remote.sessionId !== sessionId) return;
    lastHostSync = Date.now();
    const wasConnected = hadGuest;
    guestConnected = Boolean(result.guestConnected);
    if (guestConnected) hadGuest = true;
    if (!simulation) keepBest(result.best);
    if (wasConnected && !guestConnected) { remoteFault('Guest connection was lost. Resume explicitly after reconnection.'); return; }
    if (remoteFaulted || sentEpoch !== epoch) return;
    const sequence = Number(result.commandSeq) || 0;
    if (sequence <= lastCommandSeq) return;
    lastCommandSeq = sequence;
    const command = result.command;
    if (!command || command.epoch !== epoch || !Number.isFinite(command.at) || Math.abs(result.serverNow - command.at) > 3000) return;
    const zero = commandIsZero(command, engine.config.toy);
    if ((!zero && engine.phase !== 'running') || !guestConnected) return;
    if (zero && engine.phase !== 'running') engine.setGuestOutput(zeroGuestOutput(engine.config.toy));
    else {
      const levels = commandLevels(command);
      engine.setGuestOutput({ percent: command.percent, ...(engine.config.toy === 'opossum' ? { percentA: levels.a, percentB: levels.b } : {}), pattern: command.pattern, ...(command.cooldownSeconds !== undefined ? { cooldownSeconds: command.cooldownSeconds } : { recoveryMinSeconds: command.recoveryMinSeconds, recoveryMaxSeconds: command.recoveryMaxSeconds }) });
    }
  } catch (error) {
    if (!remote || remote.sessionId !== sessionId) return;
    remoteFault('Guest connection interrupted. Output paused; check the connection before resuming.');
    if (error.status === 409) { remote = null; log('The guest link ended or was replaced.'); }
    if (error.status === 401) { backend.ownerToken = null; log('Unlock Debugging again to restore session access.'); }
  } finally {
    hostSyncBusy = false;
    render();
    if (hostSyncDue && remote?.owned && backend.ownerToken) setTimeout(() => { void syncHost(); }, 0);
  }
}

function guestStorageKey() { return 'ctmp.guest.v2.' + (match?.[1]?.toUpperCase() || 'invalid'); }
function loadGuest() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(guestStorageKey()) || 'null');
    if (saved && /^[a-f0-9]{32}$/.test(saved.clientId)) return saved;
  } catch {}
  return { clientId: randomClient(), clientSeq: 0 };
}
function saveGuest() {
  if (!guest) return;
  try { sessionStorage.setItem(guestStorageKey(), JSON.stringify({ clientId: guest.clientId, clientSeq: guest.clientSeq, sessionId: guest.sessionId, token: backend.guestToken })); } catch {}
}

function applyGuestState(result) {
  const previous = guestState;
  const previousBest = guestBest;
  const state = result.state || {};
  guestState = { ...state };
  simulation = Boolean(state.simulation);
  guestBest = simulation ? Math.max(guestBest, score(state.edgeCount)) : score(result.best);
  if (typeof state.newRecord === 'boolean') guestNewRecord = state.newRecord;
  else if (previous.edgeCount > 0 && score(state.edgeCount) > previousBest && score(state.edgeCount) > score(previous.edgeCount)) guestNewRecord = true;
  if (state.edgeCount < previous.edgeCount) guestNewRecord = false;
  guest.clientSeq = Math.max(guest.clientSeq || 0, Number.isSafeInteger(result.clientSeq) ? result.clientSeq : 0);
  lastGuestPoll = Date.now();
  guestConnected = Boolean(result.hostOnline);
  guestNetwork = result.hostOnline ? 'connected' : 'offline';
  connectionError = result.hostOnline ? '' : 'Host connection unavailable. Controls are paused.';
  const epochChanged = state.epoch !== previous.epoch;
  const reportedDesired = desiredFromState(state);
  if (epochChanged || !result.hostOnline) {
    clearTimeout(guestCommandTimer); guestPending = null;
    guestDesired = reportedDesired; guestDesiredUntil = 0;
  }
  const desiredReached = Object.keys(reportedDesired).every(key => reportedDesired[key] === guestDesired[key]);
  if (!guestPending && !guestCommandBusy && (desiredReached || Date.now() >= guestDesiredUntil)) {
    guestDesired = reportedDesired; guestDesiredUntil = 0;
  }
  saveGuest();
}

async function startGuest() {
  if (!match) { guestNetwork = 'offline'; connectionError = 'This link is not recognised. Ask the host for a new session link.'; render(); return; }
  guest = loadGuest();
  try {
    if (/^[a-f0-9]{64}$/.test(guest.token || '') && /^[a-f0-9-]{36}$/.test(guest.sessionId || '')) {
      backend.guestToken = guest.token;
      applyGuestState(await backend.call('guest-poll', { sessionId: guest.sessionId }, 'guest'));
    } else {
      const result = await backend.join(match[1].toUpperCase(), guest.clientId);
      guest.sessionId = result.sessionId;
      applyGuestState(result);
    }
    saveGuest();
  } catch (error) {
    guestConnected = false; guestNetwork = 'offline'; connectionError = safeError(error);
    if ([401, 404].includes(error.status)) { backend.guestToken = null; guest.token = null; saveGuest(); }
  }
  render();
}

async function pollGuest() {
  if (!guest?.sessionId || !backend.guestToken || guestPollBusy || !alive) return;
  guestPollBusy = true;
  try { applyGuestState(await backend.call('guest-poll', { sessionId: guest.sessionId }, 'guest')); }
  catch (error) {
    guestConnected = false; guestNetwork = 'offline'; connectionError = safeError(error);
    guestPending = null; clearTimeout(guestCommandTimer);
    if ([401, 404].includes(error.status)) { backend.guestToken = null; saveGuest(); }
  } finally { guestPollBusy = false; render(); }
}

function queueGuestCommand(values) {
  if (!guest?.sessionId || !backend.guestToken || !guestConnected || Date.now() - lastGuestPoll > 5000) throw new Error('Wait for the host connection before changing output.');
  const next = { ...guestDesired, ...values };
  if (guestState.toy === 'vacuglide') next.pattern = 'steady';
  if (guestState.toy === 'opossum') {
    if (values.percent !== undefined && values.percentA === undefined && values.percentB === undefined) { next.percentA = values.percent; next.percentB = 0; }
    for (const key of ['percentA', 'percentB']) next[key] = Math.max(0, Math.min(100, Math.round(Number(next[key] ?? 0))));
    if (!Number.isFinite(next.percentA) || !Number.isFinite(next.percentB)) throw new Error('Invalid Opossum channel levels.');
    next.percent = Math.max(next.percentA, next.percentB);
  } else {
    delete next.percentA; delete next.percentB;
    next.percent = Math.max(0, Math.min(100, Math.round(Number(next.percent))));
  }
  next.recoveryMinSeconds = Math.max(1, Math.min(300, Math.round(Number(next.recoveryMinSeconds))));
  next.recoveryMaxSeconds = Math.max(1, Math.min(300, Math.round(Number(next.recoveryMaxSeconds))));
  if (next.recoveryMaxSeconds < next.recoveryMinSeconds) throw new Error('Maximum recovery must be at least the minimum.');
  const allowedPatterns = guestState.toy === 'opossum' ? ['steady','pulse','wave','alternating','offset-wave'] : ['steady','pulse','wave'];
  if (!Number.isFinite(next.percent) || !Number.isFinite(next.recoveryMinSeconds) || !Number.isFinite(next.recoveryMaxSeconds) || !allowedPatterns.includes(next.pattern)) throw new Error('Invalid guest controls.');
  const zero = commandIsZero(next, guestState.toy);
  if (!zero && guestState.phase !== 'running') throw new Error('Controls are paused during cooldown or a host interruption.');
  guestDesired = next;
  guestDesiredUntil = Date.now() + 3500;
  guest.clientSeq = Math.max(0, guest.clientSeq || 0) + 1;
  guestPending = { ...next, epoch: guestState.epoch, clientSeq: guest.clientSeq };
  saveGuest();
  clearTimeout(guestCommandTimer);
  if (zero) void flushGuestCommand();
  else guestCommandTimer = setTimeout(() => { void flushGuestCommand(); }, 150);
}

async function flushGuestCommand() {
  if (guestCommandBusy || !guestPending || !backend.guestToken) return;
  const command = guestPending; guestPending = null;
  if (command.epoch !== guestState.epoch || (!commandIsZero(command, guestState.toy) && guestState.phase !== 'running')) return;
  guestCommandBusy = true;
  try { await backend.call('guest-command', { sessionId: guest.sessionId, command }, 'guest'); }
  catch (error) {
    if (error.status !== 409) {
      guestConnected = false; guestNetwork = 'offline'; connectionError = safeError(error);
      guestPending = null;
    }
    void pollGuest();
  } finally {
    guestCommandBusy = false;
    if (guestPending) void flushGuestCommand();
    render();
  }
}

async function requestWake() {
  if (guestPage || document.hidden || wakeSentinel || wakeBusy || !alive) return;
  if (!navigator.wakeLock?.request) { wakeStatus = 'unsupported'; render(); return; }
  wakeBusy = true;
  try {
    const sentinel = await navigator.wakeLock.request('screen');
    if (document.hidden) { await sentinel.release(); return; }
    wakeSentinel = sentinel; wakeStatus = 'held'; wakeWarning = false;
    sentinel.addEventListener('release', () => { if (wakeSentinel === sentinel) { wakeSentinel = null; wakeStatus = 'released'; render(); } });
  } catch {
    wakeStatus = 'released';
    if (!wakeWarning) { log('Screen keep-awake was not granted. Keep the page visible and check battery settings.'); wakeWarning = true; }
  } finally { wakeBusy = false; render(); }
}

async function handleAction(name, payload = {}) {
  if (guestPage) {
    if (name === 'guest-output') { queueGuestCommand(payload); return; }
    return;
  }
  if (name === 'stop') { await stopSession('Stopped manually.'); render(); return; }
  if (name === 'valve') {
    if (payload.open) {
      if (simulation || engine.config.toy !== 'vacuglide' || !drivers.vacuglide.connected) throw new Error('Connect VacuGlide before using its valve controls.');
      await drivers.vacuglide.setValve(payload.kind, true);
    } else if (drivers.vacuglide.connected) await drivers.vacuglide.setValve(payload.kind, false);
    return;
  }
  if (['configure', 'adjust-cutoff'].includes(name)) {
    if (name === 'configure') {
      const next = {};
      for (const key of ['startPercent','rampSeconds','maxPercentA','maxPercentB','recoveryMinSeconds','recoveryMaxSeconds','shortPhaseSeconds','shortPhaseCount','stablePhaseSeconds','stablePhaseCount','adaptiveMaxMultiplier','patternSpeedSeconds','phaseOffset','patternMinA','patternMinB']) if (payload[key] !== undefined) next[key] = Number(payload[key]);
      for (const key of ['adaptiveEnabled']) if (payload[key] !== undefined) next[key] = Boolean(payload[key]);
      if (payload.opossumPattern !== undefined) next.opossumPattern = payload.opossumPattern;
      if (next.rampSeconds !== undefined && next.rampSeconds < 1) throw new Error('Ramp time must be at least 1 second.');
      engine.configure(next); persistProfile();
    } else { engine.adjustCutoff(Number(payload.delta)); persistProfile(); }
    render(); return;
  }
  if (name === 'simulate-pressure') { requireSimulation(); simulatedPressure = Math.max(0, Math.min(60, Number(payload.pressure))); if (!Number.isFinite(simulatedPressure)) throw new Error('Invalid simulated pressure.'); simulatedSensor = true; engine.updatePressure(simulatedPressure); render(); return; }
  if (name === 'dismiss-overlay') { guestPreview = false; previewOverlay = null; previewEndsAt = null; render(); return; }
  if (busy) throw new Error('Wait for the current setup action to finish. Stop remains available.');
  busy = true; const generation = operationGeneration;
  try {
    switch (name) {
      case 'connect-civet':
        if (simulation) throw new Error('Disable simulation before connecting hardware.');
        await drivers.civet.connect(); connectionError = ''; break;
      case 'connect-output':
        if (simulation) throw new Error('Disable simulation before connecting hardware.');
        if (engine.config.toy === 'vacuglide') await drivers.vacuglide.connect(payload.token);
        else await currentDriver().connect();
        connectionError = ''; break;
      case 'disconnect-output': await stopSession('Output device disconnected by host.'); await currentDriver().disconnect(); break;
      case 'zero-civet':
        requireInactive();
        if (simulation) { requireDev(); simulatedSensor = true; simulatedPressure = 0; engine.updatePressure(0); }
        else await drivers.civet.zero();
        calibration = { ...emptyCalibration(), zeroed: true, step: 'relaxed', status: simulation ? 'Simulated zero complete. Set test pressure in Debugging, then capture each calibration level.' : 'Zeroed. Fit and inflate comfortably, then capture relaxed pressure.' }; break;
      case 'calibrate': await captureReading(payload.stage); persistProfile(false); break;
      case 'capture-calibration-now': captureCurrent(payload.stage); break;
      case 'calibration-value': setCalibrationValue(payload.stage, payload.value); break;
      case 'calibration-mode': requireInactive(); calibration.mode = payload.mode === 'automatic' ? 'automatic' : 'manual'; persistProfile(false); break;
      case 'calibration-sample-ms': requireInactive(); calibration.autoSampleMs = Math.max(300, Math.min(3000, Number(payload.value) || 1000)); persistProfile(false); break;
      case 'reset-calibration': requireInactive(); calibration = emptyCalibration(); persistProfile(); break;
      case 'finish-calibration': finishCalibration(); break;
      case 'select-toy':
        requireInactive(); if (!TOYS.has(payload.toy)) throw new Error('Unknown output device.');
        if (remote) await endRemote();
        await stopPhysical(); hardwareArmed = false; hardwareGeneration += 1;
        engine.configure({ toy: payload.toy }); connectionError = ''; break;
      case 'select-mode':
        requireInactive(); if (!['solo', 'guest'].includes(payload.mode)) throw new Error('Unknown session mode.');
        if (remote && payload.mode !== engine.config.mode) await endRemote();
        engine.configure({ mode: payload.mode }); break;
      case 'start':
        requireReady(); hardwareArmed = false; hardwareGeneration += 1; connectionError = ''; remoteFaulted = false; newRecord = false;
        recorder.start({ toy: engine.config.toy, mode: engine.config.mode, calibration: profilePayload().calibration, settings: engine.config });
        engine.setGuestOutput(zeroGuestOutput(engine.config.toy)); engine.start(); armNavigationGuard(); persistRecovery(); requestHostSync(); break;
      case 'pause': engine.pause(); persistRecovery(); await stopPhysical(); requestHostSync(); break;
      case 'resume':
        requireReady(); if (remote?.owned && hadGuest && !guestConnected) throw new Error('Wait for the guest to reconnect before resuming.');
        remoteFaulted = false; connectionError = ''; engine.setGuestOutput(zeroGuestOutput(engine.config.toy)); engine.resume(); armNavigationGuard(); persistRecovery(); recorder.event('resume'); requestHostSync(); break;
      case 'unlock-dev': await unlock(payload.password); break;
      case 'lock-dev':
        requireDev(); if (remote) await endRemote(); if (simulation) await setSimulation(false);
        hardwareArmed = false; hardwareGeneration += 1; await backend.lock(); log('Debugging locked.'); break;
      case 'create-link': await createRemote(); break;
      case 'end-link': await endRemote(); break;
      case 'copy-link':
        requireDev(); if (!remote?.url || payload.url !== remote.url) throw new Error('No current link to copy.');
        try { await navigator.clipboard.writeText(remote.url); ui.message('Link copied.'); } catch { ui.message('Select the link field and copy it manually.'); } break;
      case 'simulation': await setSimulation(Boolean(payload.enabled)); break;
      case 'simulate-edge': {
        requireSimulation(); if (['cooldown', 'settling'].includes(engine.phase)) throw new Error('Allow the current cooldown/reset to complete first.');
        simulatedSensor = true; simulatedPressure = Math.min(21, engine.config.resetThreshold - 0.2); engine.updatePressure(simulatedPressure);
        if (!ACTIVE.has(engine.phase)) { if (['fault', 'paused'].includes(engine.phase)) engine.resume(); else engine.start(); }
        simulatedPressure = engine.config.threshold + 0.4; engine.updatePressure(simulatedPressure);
        const testEngine = engine;
        setTimeout(() => { if (simulation && engine === testEngine) simulatedPressure = engine.config.resetThreshold - 0.3; }, 300);
        break;
      }
      case 'simulate-record': testOverlay(true); break;
      case 'preview-guest': testOverlay(false); break;
      case 'simulate-disconnect':
        requireSimulation(); if (payload.device === 'civet') simulatedSensor = false;
        engine.fault('Simulated ' + payload.device + ' disconnect. Resume explicitly after checking the test state.');
        if (payload.device === 'guest') guestConnected = false; break;
      case 'run-tests': requireDev(); testResults = runDiagnostics(); log('Self-checks completed: ' + testResults.filter(test => test.passed).length + '/' + testResults.length + ' passed.'); break;
      case 'clear-log': requireDev(); logs = []; break;
      case 'export-data': downloadSessionData(payload.format === 'json' ? 'json' : 'csv'); break;
      case 'hardware-arm':
        requireDev(); requireInactive(); if (simulation) throw new Error('Hardware tests are disabled in simulation.');
        hardwareArmed = Boolean(payload.enabled); if (!hardwareArmed) { hardwareGeneration += 1; await stopPhysical(); } break;
      case 'hardware-pulse': await hardwarePulse(); break;
      default: throw new Error('This control is not available.');
    }
    if (generation !== operationGeneration && ['connect-output', 'connect-civet'].includes(name)) await stopPhysical();
  } catch (error) {
    if (name === 'calibrate') calibration.status = safeError(error);
    log(safeError(error));
    if (error.status === 401 && name !== 'unlock-dev') { backend.ownerToken = null; if (remote?.owned) remoteFault('Unlock Debugging again before restoring guest access.'); }
    throw error;
  } finally { busy = false; render(); void requestWake(); }
}

function render() {
  if (!ui) return;
  if (guestPage) {
    const state = { ...guestState };
    if (state.phase === 'cooldown' && Number.isFinite(state.cooldownEndsAt)) state.remainingCooldown = Math.max(0, (state.cooldownEndsAt - (Date.now() + backend.clockOffset)) / 1000);
    if (!guestConnected || Date.now() - lastGuestPoll > 5000) { state.phase = 'paused'; state.outputPercent = 0; state.outputPercentA = 0; state.outputPercentB = 0; state.reason = connectionError || 'Host connection unavailable'; }
    ui.render({ screen: 'guest', engine: state, toy: state.toy || 'lush', mode: 'guest', best: guestBest, newRecord: guestNewRecord, simulation, guestConnected: guestConnected && Date.now() - lastGuestPoll <= 5000, networkStatus: guestNetwork, connectionError, busy: false, devices: {} });
    return;
  }
  if (!engine) return;
  if (previewOverlay && previewEndsAt) previewOverlay = { ...previewOverlay, remainingCooldown: Math.max(0, (previewEndsAt - Date.now()) / 1000) };
  ui.render({ screen: 'host', engine: engine.snapshot(), toy: engine.config.toy, mode: engine.config.mode, devices: deviceStates, best: simulation ? simulationBest : best, newRecord, devUnlocked: Boolean(backend.ownerToken), simulation, calibration, link: remote, guestConnected, networkStatus: remote?.owned ? lastHostSync && Date.now() - lastHostSync < 5000 ? 'connected' : 'offline' : 'idle', logs, testResults, hardwareArmed, busy, connectionError, wakeStatus, guestPreview, previewOverlay, dataRuntimeMs: recorder.runtimeMs, hasSessionData: recorder.startedAt !== null || Boolean(lastSessionData) });
}

function backgroundStop() {
  if (guestPage || !engine) return;
  // The isolated simulator owns no physical connections. Let its guest-link
  // test keep running when switching browser tabs; live hardware never uses
  // this exception. Browser suspension can still trip the sensor watchdog.
  if (simulation) return;
  operationGeneration += 1; hardwareGeneration += 1; hardwareArmed = false;
  cancelCapture('Capture cancelled because the page is no longer visible.');
  if (ACTIVE.has(engine.phase)) engine.pause('Control page hidden. Return and resume explicitly.');
  ui.releaseValves();
  void stopPhysical().catch(error => { connectionError = safeError(error); });
  requestHostSync();
}

if (hostPage) {
  engine = makeEngine(false);
  if (storedProfile?.settings) {
    try { engine.configure(storedProfile.settings); } catch (error) { log('Saved settings could not be fully restored: ' + safeError(error)); }
  }
  if (calibration.complete) {
    const p = calibrationNumber(calibration.values.partial), r = calibrationNumber(calibration.values.relaxed);
    if (Number.isFinite(p) && Number.isFinite(r)) {
      try { engine.configure({ threshold: storedProfile?.settings?.threshold ?? Math.round(p * 10) / 10, resetThreshold: storedProfile?.settings?.resetThreshold ?? Math.round((r + 0.1) * 10) / 10 }); } catch {}
    }
  }
  if (recoveryCandidate?.engine) {
    try {
      engine.restore(recoveryCandidate.engine);
      connectionError = 'Previous session restored in paused mode. Reconnect devices, check settings, then press Resume.';
      best = Math.max(best, score(recoveryCandidate.engine.edgeCount));
      if (recoveryCandidate.recorder) recorder.restore(recoveryCandidate.recorder);
      log('Previous session restored in paused mode.');
    } catch (error) { clearRecovery(); recoveryCandidate = null; log('Saved session recovery was invalid and was discarded.'); }
  }
  drivers = {
    civet: new CivetDevice({ onPressure: updatePressure, onStatus: status => deviceStatus('civet', status) }),
    lush: new LushDevice({ onStatus: status => deviceStatus('lush', status) }),
    opossum: new OpossumDevice({ onStatus: status => deviceStatus('opossum', status) }),
    vacuglide: new VacuGlideDevice({ onStatus: status => deviceStatus('vacuglide', status) }),
  };
  void requestWake();
  document.addEventListener('pointerup', () => { void requestWake(); }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) backgroundStop();
    else {
      void requestWake();
      for (const name of ['civet','lush','opossum']) if (!drivers[name].connected && deviceStates[name]?.state === 'disconnected') scheduleReconnect(name);
      render();
    }
  });
  window.addEventListener('popstate', () => {
    if (navigationGuard && !['idle','stopped'].includes(engine.phase)) {
      history.pushState({ ctmpSessionGuard: true }, '', location.href);
      if (ACTIVE.has(engine.phase)) { engine.pause('Back navigation intercepted. Session paused; confirm before resuming.'); void stopPhysical().catch(()=>{}); persistRecovery(); }
      ui.message('Session kept open and paused. Press Resume when ready.');
      render();
    } else navigationGuard = false;
  });
  window.addEventListener('pagehide', () => { persistRecovery(); backgroundStop(); });
  window.addEventListener('beforeunload', () => { persistRecovery(); backgroundStop(); });
} else {
  void startGuest();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void pollGuest(); });
}

setInterval(() => {
  if (!alive) return;
  if (hostPage) {
    if (simulation && simulatedSensor) {
      engine.updatePressure(simulatedPressure);
      if (capture) { capture.samples.push(simulatedPressure); capture.lastAt = Date.now(); }
    }
    engine.tick();
    if (recorder.active) recorder.sample(engine.snapshot());
    if (remote?.owned && Date.now() - lastHostSync > 5000) remoteFault('Guest service heartbeat was lost. Resume explicitly after reconnection.');
  }
  render();
}, 100);
setInterval(() => { if (hostPage) void syncHost(); else void pollGuest(); }, 750);
window.addEventListener('offline', () => {
  connectionError = 'Network connection lost.';
  if (hostPage && remote?.owned) remoteFault('Network connection lost. Guest control paused.');
  else if (hostPage && engine.config.toy === 'vacuglide' && !simulation && ACTIVE.has(engine.phase)) {
    engine.fault('Network connection lost. Reconnect before explicitly resuming.');
    void stopPhysical().catch(error => { connectionError = safeError(error); });
  }
  if (guestPage) { guestConnected = false; guestNetwork = 'offline'; guestPending = null; }
  render();
});
window.addEventListener('online', () => { if (hostPage) { requestHostSync(); } else void pollGuest(); });
render();
