import { createRadio } from './ble.js?v=20261109-3';
import { openKeepAlive } from './keep-alive.js?v=20261109-3';
import { patternMoves, patternsFor } from './patterns.js?v=20261109-3';
import { cutoffFrom, describeOutput, formatKpa, gaugeScale } from './protocol.js?v=20261109-3';
import { createSession, formatClock } from './session.js?v=20261109-3';
import { createVacuGlide } from './vacuglide.js?v=20261109-3';

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
let lastTickAt = 0;
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
  $('chart-b-wrap').hidden = settings.toy === 'lush';
  $('chart-a-label').textContent = settings.toy === 'opossum' ? 'Channel A' : settings.toy === 'lush' ? 'Level' : 'Stroke';
  $('chart-b-label').textContent = settings.toy === 'vacuglide' ? 'Speed' : 'Channel B';
  $('change-toy-name').textContent = NAMES[settings.toy];
  $('civet-block').hidden = !settings.civet;
  $('test-pressure-wrap').hidden = !settings.testMode || !settings.civet;
  $('pattern-title').textContent = NAMES[settings.toy].toUpperCase();
}

function paintSlider(input, value) {
  const shown = Math.max(0, Math.min(100, Number(value) || 0));
  input.style.background = `linear-gradient(90deg, #8dce8a, #e6b15a, #ff7a3c ${shown}%, #3a3942 ${shown}%)`;
}

function includeMap() {
  const include = { ...(profile().include || {}) };
  for (const pattern of patternsFor(settings.toy)) {
    if (include[pattern.id] == null) include[pattern.id] = true;
  }
  return include;
}

function includeCount() {
  const patterns = patternsFor(settings.toy);
  const include = profile().include || {};
  const selected = patterns.filter((pattern) => include[pattern.id] !== false).length;
  return { selected, total: patterns.length };
}

function paintPatterns() {
  const playSelect = $('play-pattern');
  const setupSelect = $('setup-pattern');
  const list = $('include-list');
  playSelect.replaceChildren();
  setupSelect.replaceChildren();
  list.replaceChildren();
  if (settings.toy === 'vacuglide') {
    $('include-open').textContent = 'Random includes';
    return;
  }
  const mode = profile().mode || 'random';
  const include = includeMap();
  const addOption = (parent, value, label) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    parent.append(option);
  };
  addOption(playSelect, 'random', 'Random');
  addOption(setupSelect, 'random', 'Random');
  for (const pattern of patternsFor(settings.toy)) {
    addOption(playSelect, pattern.id, pattern.label);
    addOption(setupSelect, pattern.id, pattern.label);
    const row = document.createElement('label');
    row.className = 'include-row';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = include[pattern.id] !== false;
    box.addEventListener('change', () => setIncluded(pattern.id, box.checked));
    const name = document.createElement('span');
    name.textContent = pattern.label;
    row.append(box, name);
    list.append(row);
  }
  playSelect.value = mode;
  setupSelect.value = mode;
  const count = includeCount();
  const summary = `Random includes (${count.selected} of ${count.total})`;
  $('include-open').textContent = summary;
  $('include-count').textContent = `${count.selected} of ${count.total} ticked`;
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

function strokeWave(elapsedMs, speed) {
  if (!(speed > 0)) return 0;
  const period = Math.max(360, 2200 - speed * 16);
  const t = ((elapsedMs % period) + period) % period / period;
  return (t < 0.5 ? t * 2 : (1 - t) * 2) * 100;
}

function visualChannels(view) {
  if (settings.toy !== 'vacuglide') return { a: view.channels.a, b: view.channels.b };
  const speed = view.phase === 'playing' ? view.channels.a : 0;
  return { a: strokeWave(view.durationMs, speed), b: speed };
}

function drawChart(canvas, values) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const parent = canvas.parentElement?.getBoundingClientRect();
  const width = Math.max(120, Math.floor((parent?.width || 160) - 20));
  const height = 54;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (values.length < 2) return;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(16, max - min);
  const mid = (min + max) / 2;
  const lo = mid - span / 2;
  const hi = mid + span / 2;
  const mapY = (value) => {
    const t = (Math.max(lo, Math.min(hi, value)) - lo) / (hi - lo);
    return canvas.height - t * (canvas.height - 8 * dpr) - 4 * dpr;
  };
  ctx.beginPath();
  ctx.strokeStyle = '#f0a06a';
  ctx.lineWidth = 2.5 * dpr;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  values.forEach((value, index) => {
    const x = (index / (values.length - 1)) * canvas.width;
    const y = mapY(value);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  const last = values[values.length - 1];
  ctx.beginPath();
  ctx.fillStyle = '#ffd7bf';
  ctx.arc(canvas.width - 2 * dpr, mapY(last), 3.5 * dpr, 0, Math.PI * 2);
  ctx.fill();
}

function pushCharts(view) {
  const visual = visualChannels(view);
  charts.a.push(visual.a);
  charts.b.push(visual.b);
  if (charts.a.length > 48) charts.a.shift();
  if (charts.b.length > 48) charts.b.shift();
  $('chart-a-value').textContent = `${Math.round(visual.a)}%`;
  $('chart-b-value').textContent = `${Math.round(visual.b)}%`;
  const meter = (id, value) => { $(id).style.width = `${Math.max(0, Math.min(100, value))}%`; };
  meter('meter-a', visual.a);
  meter('meter-b', visual.b);
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

function writeInclude(include) {
  profile().include = include;
  save();
  syncSession();
  paintPatterns();
}

function setIncluded(id, checked) {
  const include = includeMap();
  include[id] = checked;
  writeInclude(include);
}

function setIncludeAll(checked) {
  const include = {};
  for (const pattern of patternsFor(settings.toy)) include[pattern.id] = checked;
  writeInclude(include);
}

function openIncludeSheet() {
  if (settings.toy === 'vacuglide') return;
  $('include-sheet').hidden = false;
  $('include-done').focus();
}

function closeIncludeSheet() {
  $('include-sheet').hidden = true;
  $('include-open').focus();
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
    clock.onerror = () => { clock = null; };
  } catch {
    clock = null;
  }
}

function startClock() {
  ensureClock();
  lastTickAt = Date.now();
  if (clock) clock.postMessage('start');
  if (clockFallback) clearInterval(clockFallback);
  // If the worker never delivers a tick, keep sampling here so the charts still move.
  clockFallback = window.setInterval(() => {
    if (!runningView?.running) return;
    if (Date.now() - lastTickAt < 180) return;
    onTick(Date.now(), 100);
  }, 100);
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
  lastTickAt = Date.now();
  if (settings.testMode && settings.civet) session.notePressure(testPressure, now);
  // A hidden-tab hitch must not zero the test charts. Real Opossum still faults above 500 ms.
  const timed = settings.testMode ? Math.min(gap, 200) : gap;
  const view = session.tick(now, timed);
  applyView(view, false);
}

async function startSession() {
  if (!connected(settings.toy)) {
    notice(`Connect ${NAMES[settings.toy]} first.`);
    return;
  }
  notice('');
  syncSession();
  if ((profile().power || 0) <= 0) {
    notice('Max power is 0%, so output stays at zero. Raise the slider.');
  }
  charts.a = [];
  charts.b = [];
  if (settings.testMode && settings.civet) session.notePressure(testPressure, Date.now());
  const view = session.start(Date.now());
  if ((profile().power || 0) > 0 && settings.toy !== 'vacuglide' && view.activePatternId && !patternMoves(settings.toy, view.activePatternId)) {
    notice('This pattern holds a constant level, so the line stays flat. Pick a moving one, or leave Random able to choose one.');
  }
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
  $('change-toy').addEventListener('click', () => {
    showScreen('setup');
    document.querySelector('.pick')?.scrollIntoView({ block: 'center' });
  });
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
      closeIncludeSheet();
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
  $('play-pattern').addEventListener('change', () => setMode($('play-pattern').value));
  $('include-open').addEventListener('click', openIncludeSheet);
  $('include-backdrop').addEventListener('click', closeIncludeSheet);
  $('include-done').addEventListener('click', closeIncludeSheet);
  $('include-all').addEventListener('click', () => setIncludeAll(true));
  $('include-none').addEventListener('click', () => setIncludeAll(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('include-sheet').hidden) closeIncludeSheet();
  });
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
