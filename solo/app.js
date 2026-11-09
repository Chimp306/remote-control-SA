import { createRadio } from './ble.js?v=20261109-1';
import { openKeepAlive } from './keep-alive.js?v=20261109-1';
import { patternsFor } from './patterns.js?v=20261109-1';
import { cutoffFrom, describeOutput, formatKpa, gaugeScale } from './protocol.js?v=20261109-1';
import { createSession, formatClock } from './session.js?v=20261109-1';
import { createVacuGlide } from './vacuglide.js?v=20261109-1';

const KEY = 'solo.v1';
const TOKEN_KEY = 'solo.vg-token';
const DEMO = { zero: 19.62, baseline: 20.05, half: 20.28, full: 20.55 };
const NAMES = { lush: 'Lush Mini', opossum: 'Opossum', vacuglide: 'Vacuglide' };
const ARC = 216.8;

const $ = (id) => document.getElementById(id);
const settings = loadSettings();
const session = createSession();
const charts = { a: [], b: [] };
const sim = { lush: true, opossum: true, vacuglide: true, civet: true };
const linkState = {
  lush: { state: 'disconnected', message: 'Not connected' },
  opossum: { state: 'disconnected', message: 'Not connected' },
  vacuglide: { state: 'disconnected', message: 'Not connected' },
  civet: { state: 'disconnected', message: 'Not connected' },
};

let screen = location.hash === '#setup' ? 'setup' : 'play';
let latest = null;
let testPressure = 20.18;
let lastCommand = '';
let sentKey = '';
let closeKeepAlive = null;
let clock = null;
let clockFallback = 0;
let runningView = null;

if (new URLSearchParams(location.search).has('test')) settings.testMode = true;

const radio = createRadio({
  onPressure: (kpa, at) => {
    latest = { kpa, at };
    applyView(session.notePressure(kpa, at), true);
  },
  onStatus: (kind, state, message) => {
    linkState[kind] = { state, message };
    paintLinks();
  },
  onLost: (kind) => {
    if (settings.testMode || kind !== settings.toy) return;
    const view = session.stop(Date.now());
    cutHardware();
    stopClock();
    notice(`${NAMES[kind]} disconnected. Output cut.`);
    applyView(view, true);
  },
});

const vac = createVacuGlide({
  onStatus: (detail) => {
    linkState.vacuglide = { state: detail.state, message: detail.message };
    paintLinks();
  },
  onCommand: (text) => { lastCommand = text; paintCommand(); },
});

function defaultSettings() {
  return {
    toy: 'opossum',
    civet: true,
    restMin: 10,
    restMax: 30,
    calibration: { zero: null, baseline: null, half: null, full: null },
    cutoffManual: null,
    testMode: false,
    opossum: { mode: 'random', power: 72, ceiling: 40, include: null },
    lush: { mode: 'random', power: 60, ceiling: 65, include: null },
    vacuglide: { power: 40, ceiling: 35, remember: false },
  };
}

function loadSettings() {
  const base = defaultSettings();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!saved || typeof saved !== 'object') return base;
    return {
      ...base,
      ...saved,
      calibration: { ...base.calibration, ...(saved.calibration || {}) },
      opossum: { ...base.opossum, ...(saved.opossum || {}) },
      lush: { ...base.lush, ...(saved.lush || {}) },
      vacuglide: { ...base.vacuglide, ...(saved.vacuglide || {}) },
    };
  } catch {
    return base;
  }
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

function profile() {
  return settings[settings.toy];
}

function readings() {
  const saved = settings.calibration;
  const empty = ['zero', 'baseline', 'half', 'full'].every((key) => saved[key] == null);
  return settings.testMode && empty ? DEMO : saved;
}

function cutoff() {
  if (Number.isFinite(settings.cutoffManual)) return settings.cutoffManual;
  return cutoffFrom(readings().half, readings().full);
}

function includedIds() {
  const all = patternsFor(settings.toy).map((pattern) => pattern.id);
  const stored = profile().include;
  if (!stored) return all;
  const chosen = all.filter((id) => stored[id] !== false);
  return chosen.length ? chosen : all;
}

function syncSession(now = Date.now()) {
  const active = profile();
  session.configure({
    toy: settings.toy,
    civet: settings.civet,
    cutoff: cutoff(),
    restMin: settings.restMin,
    restMax: settings.restMax,
    mode: settings.toy === 'vacuglide' ? 'static' : (active.mode || 'random'),
    include: includedIds(),
    power: active.power,
  }, now);
}

function notice(text) {
  const node = $('notice');
  node.hidden = !text;
  node.textContent = text || '';
}

function connected(kind) {
  if (!settings.testMode) {
    if (kind === 'vacuglide') return vac.connected;
    return radio.connected(kind);
  }
  return sim[kind] !== false;
}

function statusOf(kind) {
  if (kind === 'civet' && !settings.civet) return { state: 'off', message: 'Off' };
  if (settings.testMode) {
    return connected(kind)
      ? { state: 'connected', message: 'Connected' }
      : { state: 'disconnected', message: 'Disconnected' };
  }
  return linkState[kind] || { state: 'disconnected', message: 'Not connected' };
}

function paintDot(dot, state) {
  dot.className = `dot${state === 'connected' ? ' on' : state === 'connecting' || state === 'reconnecting' ? ' wait' : state === 'error' ? ' bad' : ''}`;
}

function paintLinks() {
  const toy = statusOf(settings.toy);
  const civet = statusOf('civet');
  $('toy-name').textContent = NAMES[settings.toy];
  $('toy-state').textContent = toy.message;
  paintDot($('toy-dot'), toy.state);
  $('toy-link').textContent = connected(settings.toy) ? 'Disc.' : 'Conn.';
  $('civet-state').textContent = civet.message;
  paintDot($('civet-dot'), civet.state);
  $('civet-link').textContent = !settings.civet ? '—' : connected('civet') ? 'Disc.' : 'Conn.';
  $('setup-toy-name').textContent = NAMES[settings.toy];
  $('setup-toy-state').textContent = toy.message;
  paintDot($('setup-toy-dot'), toy.state);
  $('setup-civet-state').textContent = civet.message;
  paintDot($('setup-civet-dot'), civet.state);
  const vg = statusOf('vacuglide');
  $('vg-state').textContent = vg.message;
  paintDot($('vg-dot'), vg.state);
  for (const id of ['lush', 'opossum', 'vacuglide']) {
    $(`pick-${id}`).classList.toggle('is-on', settings.toy === id);
    $(`pick-${id}`).setAttribute('aria-checked', settings.toy === id ? 'true' : 'false');
  }
  $('civet-switch').setAttribute('aria-checked', settings.civet ? 'true' : 'false');
  $('test-switch').setAttribute('aria-checked', settings.testMode ? 'true' : 'false');
  $('test-badge').hidden = !settings.testMode;
  $('vg-card').hidden = settings.toy !== 'vacuglide';
  $('toy-setup').hidden = false;
  $('pattern-field').hidden = settings.toy === 'vacuglide';
  $('pattern-wrap').hidden = settings.toy === 'vacuglide';
  $('stroke-row').hidden = settings.toy !== 'vacuglide';
  $('power-label').textContent = settings.toy === 'vacuglide' ? 'Max speed' : 'Max power';
  $('setup-power-label').textContent = settings.toy === 'vacuglide' ? 'Default max speed' : 'Default max power';
  $('chart-b-wrap').hidden = settings.toy !== 'opossum';
  $('chart-a-label').textContent = settings.toy === 'opossum' ? 'Channel A' : settings.toy === 'lush' ? 'Level' : 'Speed';
  $('civet-block').hidden = !settings.civet;
  $('test-pressure-wrap').hidden = !settings.testMode || !settings.civet;
  $('pattern-title').textContent = NAMES[settings.toy].toUpperCase();
}

function paintSlider(input, value) {
  const shown = Math.max(0, Math.min(100, Number(value) || 0));
  input.style.background = `linear-gradient(90deg, #8dce8a, #e6b15a, #ff7a3c ${shown}%, #3a3942 ${shown}%)`;
}

function paintPatterns() {
  const grid = $('pattern-grid');
  const select = $('setup-pattern');
  grid.replaceChildren();
  select.replaceChildren();
  if (settings.toy === 'vacuglide') return;
  const mode = profile().mode || 'random';
  const include = profile().include || {};
  const random = document.createElement('div');
  random.className = `chip${mode === 'random' ? ' is-on' : ''}`;
  random.style.gridColumn = '1 / -1';
  const randomButton = document.createElement('button');
  randomButton.type = 'button';
  randomButton.textContent = 'Random';
  randomButton.addEventListener('click', () => setMode('random'));
  random.append(randomButton);
  grid.append(random);
  const randomOption = document.createElement('option');
  randomOption.value = 'random';
  randomOption.textContent = 'Random';
  select.append(randomOption);
  for (const pattern of patternsFor(settings.toy)) {
    const chip = document.createElement('div');
    chip.className = `chip${mode === pattern.id ? ' is-on' : ''}`;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = include[pattern.id] !== false;
    box.ariaLabel = `Include ${pattern.label} in Random`;
    box.addEventListener('click', (event) => event.stopPropagation());
    box.addEventListener('change', () => toggleInclude(pattern.id, box));
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = pattern.label;
    button.addEventListener('click', () => setMode(pattern.id));
    chip.append(box, button);
    grid.append(chip);
    const option = document.createElement('option');
    option.value = pattern.id;
    option.textContent = pattern.label;
    select.append(option);
  }
  select.value = mode;
}

function paintCalibration() {
  const current = readings();
  for (const key of ['zero', 'baseline', 'half', 'full']) {
    const card = document.querySelector(`[data-cal="${key}"]`);
    const value = current[key];
    card.querySelector('strong').textContent = formatKpa(value);
    const input = card.querySelector('input');
    if (document.activeElement !== input) input.value = Number.isFinite(value) ? formatKpa(value) : '';
  }
  const cut = cutoff();
  $('calc-cutoff').textContent = formatKpa(cut);
  if (document.activeElement !== $('cutoff-edit')) {
    $('cutoff-edit').value = Number.isFinite(cut) ? formatKpa(cut) : '';
  }
}

function paintSetupControls() {
  const active = profile();
  if (document.activeElement !== $('setup-power')) $('setup-power').value = String(active.power);
  if (document.activeElement !== $('setup-ceiling')) $('setup-ceiling').value = String(active.ceiling);
  if (document.activeElement !== $('power-slider')) $('power-slider').value = String(active.power);
  $('power-read').textContent = `${Math.round(active.power)}%`;
  paintSlider($('power-slider'), active.power);
  paintSlider($('setup-power'), active.power);
  paintSlider($('setup-ceiling'), active.ceiling);
  const ceiling = Math.round(active.ceiling);
  if (settings.toy === 'opossum') {
    $('ceiling-label').textContent = `Hardware ceiling · ${ceiling}% of 0–200`;
    $('ceiling-hint').textContent = `100% on the play slider is ${Math.round(ceiling * 2)} on the device's 0–200 scale.`;
  } else if (settings.toy === 'lush') {
    $('ceiling-label').textContent = `Hardware ceiling · ${ceiling}% of 0–20`;
    $('ceiling-hint').textContent = `100% on the play slider sends Vibrate:${Math.round(ceiling * 20 / 100)};`;
  } else {
    $('ceiling-label').textContent = `Speed ceiling · ${ceiling}% of device speed`;
    $('ceiling-hint').textContent = '100% on the play slider is this percent of the VacuGlide speed range. Stroke − and + are on Play.';
  }
  $('rest-min').value = String(settings.restMin);
  $('rest-max').value = String(settings.restMax);
  $('vg-remember').checked = settings.vacuglide.remember;
  if (document.activeElement !== $('vg-token') && settings.vacuglide.remember) {
    try { $('vg-token').value = localStorage.getItem(TOKEN_KEY) || ''; } catch { /* ignore */ }
  }
}

function showScreen(next) {
  screen = next;
  $('play-screen').hidden = next !== 'play';
  $('setup-screen').hidden = next !== 'setup';
  $('screen-toggle').textContent = next === 'play' ? 'PLAY' : 'SETUP';
  $('footer').textContent = next === 'play' ? 'CONCEPT D · HYBRID' : 'CONCEPT D · HYBRID · SETUP';
  const url = new URL(location.href);
  url.hash = next === 'setup' ? 'setup' : '';
  history.replaceState(null, '', url);
}

function drawChart(canvas, values) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 140;
  const height = canvas.clientHeight || 54;
  canvas.width = Math.max(1, Math.floor(width * dpr));
  canvas.height = Math.max(1, Math.floor(height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (values.length < 2) return;
  ctx.beginPath();
  ctx.strokeStyle = '#f0a06a';
  ctx.lineWidth = 2 * dpr;
  ctx.lineJoin = 'round';
  values.forEach((value, index) => {
    const x = (index / (values.length - 1)) * canvas.width;
    const y = canvas.height - (Math.max(0, Math.min(100, value)) / 100) * (canvas.height - 6 * dpr) - 3 * dpr;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function pushCharts(view) {
  charts.a.push(view.channels.a);
  charts.b.push(view.channels.b);
  if (charts.a.length > 48) charts.a.shift();
  if (charts.b.length > 48) charts.b.shift();
  $('chart-a-value').textContent = `${Math.round(view.channels.a)}%`;
  $('chart-b-value').textContent = `${Math.round(view.channels.b)}%`;
  drawChart($('chart-a'), charts.a);
  drawChart($('chart-b'), charts.b);
}

function paintLive(view) {
  runningView = view;
  $('app').dataset.phase = view.phase;
  $('app').dataset.edges = String(view.edges);
  $('duration').textContent = formatClock(view.durationMs);
  $('edges').textContent = String(view.edges);
  $('duration-reset').hidden = view.running;
  const pressure = settings.testMode && settings.civet ? testPressure : view.pressure;
  $('gauge-value').textContent = formatKpa(pressure);
  const cut = cutoff();
  const scale = gaugeScale([pressure, cut, readings().zero, readings().baseline, readings().half, readings().full]);
  const span = Math.max(0.01, scale.hi - scale.lo);
  const fraction = Number.isFinite(pressure) ? Math.max(0, Math.min(1, (pressure - scale.lo) / span)) : 0;
  $('gauge-arc').style.strokeDasharray = `${(fraction * ARC).toFixed(2)} 289`;
  $('cutoff-read').textContent = formatKpa(cut);
  $('scale-lo').textContent = formatKpa(scale.lo);
  $('scale-hi').textContent = formatKpa(scale.hi);
  const slider = $('cutoff-slider');
  slider.min = String(scale.lo);
  slider.max = String(scale.hi);
  if (document.activeElement !== slider && Number.isFinite(cut)) slider.value = String(cut);
  paintSlider(slider, Number.isFinite(cut) ? ((cut - scale.lo) / span) * 100 : 0);
  $('resting').hidden = view.phase !== 'resting';
  $('rest-count').textContent = formatClock(view.restRemainingMs);
  if (view.fault) notice(view.fault);
  const active = settings.toy === 'vacuglide' ? '' : (view.mode === 'random' && view.activePatternLabel ? `Now · ${view.activePatternLabel}` : '');
  $('pattern-now').textContent = active;
  paintCommand();
}

function paintCommand() {
  const node = $('command');
  node.hidden = !settings.testMode || !lastCommand;
  node.textContent = lastCommand ? `Would send · ${lastCommand}` : '';
}

function setMode(mode) {
  profile().mode = mode;
  save();
  syncSession();
  paintPatterns();
  if (runningView?.running) applyView(session.tick(Date.now(), 0), true);
}

function toggleInclude(id, box) {
  const all = patternsFor(settings.toy).map((pattern) => pattern.id);
  const include = { ...(profile().include || {}) };
  for (const patternId of all) if (include[patternId] == null) include[patternId] = true;
  include[id] = box.checked;
  if (!all.some((patternId) => include[patternId] !== false)) {
    include[id] = true;
    box.checked = true;
    notice('Random needs at least one pattern.');
  } else if ($('notice').textContent === 'Random needs at least one pattern.') notice('');
  profile().include = include;
  save();
  syncSession();
}

function setCutoff(value, manual) {
  const next = Math.round(value * 10) / 10;
  if (!Number.isFinite(next)) return;
  settings.cutoffManual = manual ? Math.max(-50, Math.min(80, next)) : null;
  save();
  syncSession();
  paintCalibration();
  if (runningView) paintLive(runningView);
}

function rememberToken() {
  settings.vacuglide.remember = $('vg-remember').checked;
  save();
  try {
    if (settings.vacuglide.remember) localStorage.setItem(TOKEN_KEY, $('vg-token').value.trim());
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
}

async function connectKind(kind) {
  if (settings.testMode) {
    sim[kind] = true;
    paintLinks();
    return;
  }
  notice('');
  if (kind === 'vacuglide') {
    await vac.connect($('vg-token').value);
    rememberToken();
    return;
  }
  await radio.connect(kind);
}

async function disconnectKind(kind) {
  if (settings.testMode) {
    sim[kind] = false;
    if (kind === settings.toy && runningView?.running) {
      const view = session.stop(Date.now());
      stopClock();
      applyView(view, true);
    }
    paintLinks();
    return;
  }
  if (kind === 'vacuglide') await vac.disconnect();
  else await radio.disconnect(kind);
  if (kind === settings.toy) sentKey = '';
}

async function reconnectKind(kind) {
  if (settings.testMode) return connectKind(kind);
  notice('');
  if (kind === 'vacuglide') return connectKind(kind);
  try { await radio.reconnect(kind); }
  catch (error) {
    if (/Press Connect/.test(error.message)) return radio.connect(kind);
    throw error;
  }
}

function ensureClock() {
  if (clock || clockFallback) return;
  try {
    clock = new Worker(new URL('./clock.worker.js', import.meta.url));
    clock.onmessage = (event) => onTick(event.data.now, event.data.gap);
  } catch {
    clock = null;
  }
}

function startClock() {
  ensureClock();
  if (clock) clock.postMessage('start');
  else {
    let last = 0;
    clockFallback = window.setInterval(() => {
      const now = Date.now();
      const gap = last ? now - last : 0;
      last = now;
      onTick(now, gap);
    }, 100);
  }
}

function stopClock() {
  if (clock) clock.postMessage('stop');
  if (clockFallback) clearInterval(clockFallback);
  clockFallback = 0;
  if (closeKeepAlive) {
    closeKeepAlive();
    closeKeepAlive = null;
  }
}

async function cutHardware() {
  sentKey = '';
  const ceiling = profile().ceiling;
  if (settings.testMode) {
    lastCommand = describeOutput(settings.toy, { a: 0, b: 0 }, ceiling);
    paintCommand();
    return;
  }
  try {
    if (settings.toy === 'opossum' && radio.connected('opossum')) await radio.stopOpossum(ceiling);
    if (settings.toy === 'lush' && radio.connected('lush')) await radio.stopLush(ceiling);
    if (settings.toy === 'vacuglide' && vac.connected) await vac.stop();
  } catch (error) {
    notice(error.message || 'Stop was not confirmed.');
  }
}

async function pushHardware(view, force) {
  const ceiling = profile().ceiling;
  const key = `${settings.toy}|${view.channels.a.toFixed(2)}|${view.channels.b.toFixed(2)}|${view.expectPulse}`;
  const pulse = settings.toy === 'opossum' && view.expectPulse && view.phase === 'playing';
  if (!force && !pulse && key === sentKey) return;
  sentKey = key;
  lastCommand = describeOutput(settings.toy, view.channels, ceiling);
  if (settings.testMode) {
    paintCommand();
    return;
  }
  if (settings.toy === 'opossum') {
    if (view.channels.a === 0 && view.channels.b === 0) await radio.stopOpossum(ceiling);
    else await radio.writeOpossum(view.channels.a, view.channels.b, ceiling);
  } else if (settings.toy === 'lush') {
    if (view.channels.a === 0) await radio.stopLush(ceiling);
    else await radio.writeLush(view.channels.a, ceiling);
  } else if (vac.connected) {
    await vac.setSpeed(view.channels.a, ceiling);
  }
  paintCommand();
}

function applyView(view, force = false) {
  paintLive(view);
  pushCharts(view);
  if (view.tripped) force = true;
  pushHardware(view, force).catch((error) => {
    session.stop(Date.now());
    stopClock();
    notice(error.message || 'Output stopped because a command failed.');
  });
  if (view.fault) {
    stopClock();
    cutHardware();
  }
}

function onTick(now, gap) {
  if (settings.testMode && settings.civet) session.notePressure(testPressure, now);
  const view = session.tick(now, gap);
  applyView(view, false);
}

async function startSession() {
  if (!connected(settings.toy)) {
    notice(`Connect ${NAMES[settings.toy]} first.`);
    return;
  }
  notice('');
  syncSession();
  if (settings.testMode && settings.civet) session.notePressure(testPressure, Date.now());
  const view = session.start(Date.now());
  sentKey = '';
  try { closeKeepAlive = openKeepAlive(); } catch { closeKeepAlive = null; }
  startClock();
  applyView(view, true);
}

function stopSession() {
  const view = session.stop(Date.now());
  stopClock();
  applyView(view, true);
  cutHardware();
}

function seedDemo() {
  const empty = ['zero', 'baseline', 'half', 'full'].every((name) => settings.calibration[name] == null);
  if (empty) settings.calibration = { ...DEMO };
}

function capture(key) {
  if (!latest || Date.now() - latest.at > 2000) {
    if (settings.testMode && settings.civet) latest = { kpa: testPressure, at: Date.now() };
    else {
      notice('No fresh Civet reading. Connect the sensor and try again.');
      return;
    }
  }
  seedDemo();
  settings.calibration[key] = Math.round(latest.kpa * 100) / 100;
  if (key === 'half' || key === 'full') settings.cutoffManual = null;
  save();
  notice('');
  syncSession();
  paintCalibration();
  if (runningView) paintLive(runningView);
}

function typedReading(key, raw) {
  const value = Number(String(raw).trim());
  if (!Number.isFinite(value) || value < -327.6 || value > 327.6) {
    notice('Enter a kPa number.');
    return;
  }
  seedDemo();
  settings.calibration[key] = Math.round(value * 100) / 100;
  if (key === 'half' || key === 'full') settings.cutoffManual = null;
  save();
  notice('');
  syncSession();
  paintCalibration();
}

function guard(fn) {
  return (...args) => {
    Promise.resolve(fn(...args)).catch((error) => notice(error.message || 'Something went wrong.'));
  };
}

function bind() {
  $('screen-toggle').addEventListener('click', () => showScreen(screen === 'play' ? 'setup' : 'play'));
  $('continue-play').addEventListener('click', () => showScreen('play'));
  $('start').addEventListener('click', guard(startSession));
  $('stop').addEventListener('click', guard(stopSession));
  $('duration-reset').addEventListener('click', () => {
    session.resetTimer();
    if (runningView) paintLive({ ...runningView, durationMs: 0, running: false });
  });
  $('toy-link').addEventListener('click', guard(() => (connected(settings.toy) ? disconnectKind(settings.toy) : connectKind(settings.toy))));
  $('civet-link').addEventListener('click', guard(() => {
    if (!settings.civet) return;
    return connected('civet') ? disconnectKind('civet') : connectKind('civet');
  }));
  $('toy-disconnect').addEventListener('click', guard(() => disconnectKind(settings.toy)));
  $('toy-reconnect').addEventListener('click', guard(() => reconnectKind(settings.toy)));
  $('civet-disconnect').addEventListener('click', guard(() => disconnectKind('civet')));
  $('civet-reconnect').addEventListener('click', guard(() => reconnectKind('civet')));
  $('vg-connect').addEventListener('click', guard(() => connectKind('vacuglide')));
  $('vg-disconnect').addEventListener('click', guard(() => disconnectKind('vacuglide')));
  $('vg-remember').addEventListener('change', rememberToken);
  $('vg-token').addEventListener('change', rememberToken);
  for (const id of ['lush', 'opossum', 'vacuglide']) {
    $(`pick-${id}`).addEventListener('click', () => {
      if (runningView?.running) stopSession();
      settings.toy = id;
      charts.a = [];
      charts.b = [];
      save();
      syncSession();
      paintPatterns();
      paintSetupControls();
      paintLinks();
    });
  }
  $('civet-switch').addEventListener('click', () => {
    settings.civet = !settings.civet;
    save();
    syncSession();
    paintLinks();
    paintCalibration();
  });
  $('test-switch').addEventListener('click', () => {
    settings.testMode = !settings.testMode;
    save();
    if (runningView?.running) stopSession();
    paintLinks();
    paintCalibration();
    if (settings.testMode && settings.civet) {
      session.notePressure(testPressure, Date.now());
      paintLive(session.tick(Date.now(), 0));
    }
  });
  $('setup-pattern').addEventListener('change', () => setMode($('setup-pattern').value));
  const onPower = (value) => {
    profile().power = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    save();
    syncSession();
    paintSetupControls();
  };
  $('power-slider').addEventListener('input', () => onPower($('power-slider').value));
  $('setup-power').addEventListener('input', () => onPower($('setup-power').value));
  $('setup-ceiling').addEventListener('input', () => {
    profile().ceiling = Math.max(5, Math.min(100, Math.round(Number($('setup-ceiling').value) || 0)));
    save();
    paintSetupControls();
  });
  $('cut-minus').addEventListener('click', () => setCutoff((cutoff() || 20) - 0.1, true));
  $('cut-plus').addEventListener('click', () => setCutoff((cutoff() || 20) + 0.1, true));
  $('cutoff-slider').addEventListener('input', () => setCutoff(Number($('cutoff-slider').value), true));
  $('cutoff-edit').addEventListener('change', () => {
    const value = Number($('cutoff-edit').value);
    if (!Number.isFinite(value)) return;
    setCutoff(value, true);
  });
  $('rest-min').addEventListener('change', () => {
    settings.restMin = clampRest($('rest-min').value, 10);
    if (settings.restMin > settings.restMax) settings.restMax = settings.restMin;
    save();
    syncSession();
    paintSetupControls();
  });
  $('rest-max').addEventListener('change', () => {
    settings.restMax = clampRest($('rest-max').value, 30);
    if (settings.restMax < settings.restMin) settings.restMin = settings.restMax;
    save();
    syncSession();
    paintSetupControls();
  });
  $('test-pressure').addEventListener('input', () => {
    testPressure = Number($('test-pressure').value);
    $('test-pressure-read').textContent = formatKpa(testPressure);
    const view = session.notePressure(testPressure, Date.now());
    applyView(view, view.tripped);
  });
  $('stroke-minus').addEventListener('click', guard(() => nudge('minus')));
  $('stroke-plus').addEventListener('click', guard(() => nudge('plus')));
  for (const card of document.querySelectorAll('[data-cal]')) {
    const key = card.dataset.cal;
    card.querySelector('button').addEventListener('click', () => capture(key));
    card.querySelector('input').addEventListener('change', (event) => typedReading(key, event.target.value));
  }
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    const view = session.stop(Date.now());
    stopClock();
    cutHardware();
    paintLive(view);
  });
}

function clampRest(value, fallback) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(600, number));
}

async function nudge(direction) {
  if (settings.testMode) {
    lastCommand = `PUT /vacuglide/valve/stroke-${direction} open, then close`;
    paintCommand();
    return;
  }
  if (!vac.connected) {
    notice('Connect VacuGlide before changing the stroke.');
    return;
  }
  await vac.nudgeStroke(direction);
}

bind();
syncSession();
paintPatterns();
paintSetupControls();
paintCalibration();
paintLinks();
showScreen(screen);
if (settings.testMode && settings.civet) {
  session.notePressure(testPressure, Date.now());
}
paintLive(session.tick(Date.now(), 0));
$('test-pressure-read').textContent = formatKpa(testPressure);
