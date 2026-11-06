/**
 * Solo Civet + Opossum player. Reuses the existing engine and device
 * adapters, including their power caps and recovery limits. No guest,
 * remote-link or extra-device UI.
 */
import { SessionEngine } from './engine.js?v=20261106-v22';
import { CivetDevice, OpossumDevice } from './devices.js?v=20261106-v22';
import { BUILD } from './config.js?v=20261106-v22';

const PATTERNS = ['synchronized', 'alternating', 'offset-wave', 'pulse'];
const ACTIVE = new Set(['running', 'cooldown', 'settling']);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const randomPattern = () => PATTERNS[Math.floor(Math.random() * PATTERNS.length)];
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
let playShellReady = false;

const engine = new SessionEngine({
  onOutput(percent, levels) {
    const stopped = levels.a === 0 && levels.b === 0;
    if (stopped) return opossum.connected || opossumHint.toLowerCase().includes('error') ? opossum.stop() : undefined;
    if (document.hidden) return Promise.reject(new Error('Keep this page visible before resuming.'));
    if (!opossum.connected) return Promise.reject(new Error('Opossum is disconnected.'));
    return opossum.setLevels({ a: levels.a, b: levels.b });
  },
  onEvent(event) {
    const state = event.snapshot;
    if (event.type === 'edge' && state.edgeCount !== lastEdgeCount) {
      lastEdgeCount = state.edgeCount;
      try { engine.configure({ opossumPattern: randomPattern() }); } catch { /* keep current pattern */ }
    }
    if (view === 'play') updatePlay();
  },
});

const civet = new CivetDevice({
  onPressure(kpa, at) { engine.updatePressure(kpa, at); if (view === 'setup') updateSetupReadings(); else updatePlay(); },
  onStatus(status) { civetHint = status.message || (status.connected ? 'Connected' : 'Disconnected'); if (ACTIVE.has(engine.phase) && (status.state === 'error' || status.state === 'disconnected')) handleDeviceLoss('Civet'); refresh(); },
});

const opossum = new OpossumDevice({
  onStatus(status) { opossumHint = status.message || (status.connected ? 'Connected' : 'Disconnected'); if (ACTIVE.has(engine.phase) && (status.state === 'error' || status.state === 'disconnected')) handleDeviceLoss('Opossum'); refresh(); },
});

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
});

function handleDeviceLoss(name) {
  error = `${name} disconnected. Output was stopped.`;
  try { engine.fault(`${name} disconnected.`); } catch { /* already faulted */ }
  opossum.stop().catch(() => {});
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

function canPlay() {
  return civet.connected && opossum.connected && fresh();
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
  if (state.phase === 'paused') return 'Paused';
  if (state.phase === 'fault') return state.reason || 'Stopped by a fault';
  if (state.phase === 'stopped') return 'Stopped';
  return 'Ready';
}

function formatKpa(value) {
  return Number.isFinite(value) ? value.toFixed(1) : '—';
}

function setupHTML() {
  const civetOn = civet.connected;
  const toyOn = opossum.connected;
  return `
    <div class="shell" data-view="setup">
      <div class="brand"><h1>CTMP</h1><small>Solo player</small></div>
      <section class="panel">
        <div class="status-row">
          <div class="status-copy"><b><span class="dot ${civetOn ? 'on' : ''}"></span>Civet</b><span>${escapeHtml(civetHint)}</span></div>
          <button class="button" type="button" data-act="connect-civet">${civetOn ? 'Reconnect' : 'Connect'}</button>
        </div>
        <div class="status-row">
          <div class="status-copy"><b><span class="dot ${toyOn ? 'on' : ''}"></span>Opossum</b><span>${escapeHtml(opossumHint)}</span></div>
          <button class="button" type="button" data-act="connect-opossum">${toyOn ? 'Reconnect' : 'Connect'}</button>
        </div>
        <div class="reading"><span>Live pressure</span><b id="setup-pressure">${formatKpa(engine.snapshot().pressure)} kPa</b></div>
        <div class="stack">
          <button class="button button-ghost" type="button" data-act="zero" ${civetOn ? '' : 'disabled'}>Zero Civet</button>
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
      <button class="button button-primary" type="button" data-act="play" ${canPlay() ? '' : 'disabled'}>Play</button>
      <p class="note">Connect both devices, then press Play. During play you will only see cutoff adjusters, the edge count, recovery times and Stop. Maximum power stays at the existing Opossum safety cap.</p>
      <p class="fineprint">Build ${escapeHtml(BUILD)}</p>
    </div>`;
}

function playHTML() {
  const state = engine.snapshot();
  const paused = state.phase === 'paused' || state.phase === 'fault';
  return `
    <div class="shell" data-view="play">
      <div class="play-top">
        <span>Edges</span>
        <div class="edges" id="edge-count">${state.edgeCount}</div>
        <div class="phase" id="phase-label">${escapeHtml(phaseCopy(state))}</div>
      </div>
      <section class="panel">
        <div class="metrics">
          <div class="metric"><span>Pressure</span><b id="live-pressure">${formatKpa(state.pressure)}</b></div>
          <div class="metric"><span>Cutoff</span><b id="cutoff-value">${formatKpa(state.threshold)}</b></div>
        </div>
        <div class="adjust">
          <button class="button" type="button" data-act="cutoff-down" aria-label="Lower cutoff by 0.1 kilopascal">− 0.1</button>
          <button class="button" type="button" data-act="cutoff-up" aria-label="Raise cutoff by 0.1 kilopascal">+ 0.1</button>
        </div>
      </section>
      <section class="panel recovery">
        <p class="note" id="recovery-now">Next recovery will be a random time between these limits. Current recovery ${Number(state.recoverySeconds || recoveryMin).toFixed(1)}s.</p>
        <div class="recovery-line">
          <div class="field"><label for="play-min">Min seconds</label><input id="play-min" type="number" min="1" max="300" inputmode="numeric" value="${recoveryMin}"></div>
          <div class="recovery-and">to</div>
          <div class="field"><label for="play-max">Max seconds</label><input id="play-max" type="number" min="1" max="300" inputmode="numeric" value="${recoveryMax}"></div>
        </div>
      </section>
      ${error ? `<p class="error" id="play-error">${escapeHtml(error)}</p>` : '<p class="error" id="play-error" hidden></p>'}
      <div class="stack">
        ${paused ? '<button class="button button-primary" type="button" data-act="resume">Resume</button>' : ''}
        <button class="button button-danger" type="button" data-act="stop">Stop</button>
      </div>
    </div>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function render() {
  playShellReady = view === 'play';
  app.innerHTML = view === 'play' ? playHTML() : setupHTML();
}

function updateSetupReadings() {
  const node = document.getElementById('setup-pressure');
  if (node) node.textContent = `${formatKpa(engine.snapshot().pressure)} kPa`;
}

function updatePlay() {
  if (view !== 'play') return;
  if (!document.querySelector('[data-view="play"]')) { render(); return; }
  const state = engine.snapshot();
  const edges = document.getElementById('edge-count');
  const phase = document.getElementById('phase-label');
  const pressure = document.getElementById('live-pressure');
  const cutoff = document.getElementById('cutoff-value');
  const recovery = document.getElementById('recovery-now');
  const playError = document.getElementById('play-error');
  if (edges) edges.textContent = String(state.edgeCount);
  if (phase) phase.textContent = phaseCopy(state);
  if (pressure) pressure.textContent = formatKpa(state.pressure);
  if (cutoff) cutoff.textContent = formatKpa(state.threshold);
  if (recovery) recovery.textContent = `Next recovery will be a random time between these limits. Current recovery ${Number(state.recoverySeconds || recoveryMin).toFixed(1)}s.`;
  if (playError) {
    if (error) { playError.hidden = false; playError.textContent = error; }
    else playError.hidden = true;
  }
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

async function onPlay() {
  error = '';
  message = '';
  readRecoveryFrom('setup-min', 'setup-max');
  if (!civet.connected || !opossum.connected) { error = 'Connect Civet and Opossum first.'; render(); return; }
  if (!fresh()) { error = 'Wait for a live Civet reading first.'; render(); return; }
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
      opossumPattern: randomPattern(),
    });
    const state = engine.start();
    if (state.phase === 'fault') { error = state.reason || 'Could not start.'; render(); return; }
    lastEdgeCount = 0;
    view = 'play';
    startTicker();
    await requestWake();
    render();
  } catch (err) {
    error = err.message || String(err);
    render();
  }
}

async function onStop() {
  stopTicker();
  try { engine.stop(); } catch { /* already idle */ }
  try { await opossum.stop(); } catch { /* best effort */ }
  await releaseWake();
  view = 'setup';
  message = 'Stopped.';
  error = '';
  render();
}

async function onResume() {
  error = '';
  try {
    if (!civet.connected || !opossum.connected) throw new Error('Reconnect Civet and Opossum first.');
    if (!fresh()) throw new Error('Wait for a live Civet reading first.');
    const state = engine.resume();
    if (state.phase === 'fault') throw new Error(state.reason || 'Could not resume.');
    startTicker();
    await requestWake();
    render();
  } catch (err) {
    error = err.message || String(err);
    render();
  }
}

app.addEventListener('click', event => {
  const button = event.target.closest('[data-act]');
  if (!button || button.disabled) return;
  const act = button.dataset.act;
  if (act === 'connect-civet') {
    error = '';
    civet.connect().then(() => { message = 'Civet connected.'; refresh(); }).catch(err => { error = err.message || String(err); refresh(); });
  } else if (act === 'connect-opossum') {
    error = '';
    opossum.connect().then(() => { message = 'Opossum connected.'; refresh(); }).catch(err => { error = err.message || String(err); refresh(); });
  } else if (act === 'zero') {
    civet.zero().then(() => { message = 'Civet zeroed.'; refresh(); }).catch(err => { error = err.message || String(err); refresh(); });
  } else if (act === 'play') onPlay();
  else if (act === 'stop') onStop();
  else if (act === 'resume') onResume();
  else if (act === 'cutoff-down') { engine.adjustCutoff(-0.1); updatePlay(); }
  else if (act === 'cutoff-up') { engine.adjustCutoff(0.1); updatePlay(); }
});

app.addEventListener('change', event => {
  if (event.target.id === 'setup-min' || event.target.id === 'setup-max') readRecoveryFrom('setup-min', 'setup-max');
  if (event.target.id === 'play-min' || event.target.id === 'play-max') readRecoveryFrom('play-min', 'play-max');
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && ACTIVE.has(engine.phase)) {
    engine.pause('Page hidden. Output stopped until you resume.');
    opossum.stop().catch(() => {});
    releaseWake();
    error = 'Page was hidden, so output paused.';
    if (view === 'play') render();
  }
});

render();
