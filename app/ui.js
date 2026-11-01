const template = `
<div class="app-shell" id="app-shell">
  <header class="app-header">
    <div class="brand"><span class="brand-mark" aria-hidden="true">C</span><div><div class="brand-name">CTMP</div><div class="brand-sub" id="brand-sub">PRIVATE CONTROL</div></div></div>
    <div class="header-tools"><span class="wake-chip" id="wake-status">Keep awake</span><button class="quiet-button" id="debug-button" type="button">Debugging</button></div>
  </header>

  <main id="host-view">
    <div class="view-heading host-intro"><div><p class="eyebrow">YOUR SESSION. YOUR SETTINGS.</p><h1>Control, in the moment.</h1><p>Live feedback. A little more precision.</p></div><span class="busy-indicator" id="busy-indicator" hidden>Working…</span></div>
    <div class="status-row" aria-label="Connection status"><span class="status-chip" id="civet-chip">Civet disconnected</span><span class="status-chip" id="output-chip">Lush disconnected</span><span class="status-chip" id="guest-chip" hidden>Guest offline</span></div>
    <div class="network-alert" id="connection-alert" role="status" hidden></div>
    <div class="simulation-banner" id="simulation-banner" hidden>SIMULATION — HARDWARE DISCONNECTED<small>Test events and scores stay separate from your live session.</small></div>
    <nav class="main-tabs" aria-label="Control sections"><button class="tab-button" id="tab-play" data-tab="play" aria-selected="true" type="button">Play</button><button class="tab-button" id="tab-setup" data-tab="setup" aria-selected="false" type="button">Device setup</button><button class="tab-button" id="tab-debug" data-tab="debug" aria-selected="false" type="button" hidden>Debugging</button></nav>

    <section id="pane-play" aria-label="Play controls">
      <div class="play-grid">
        <section class="panel live-panel"><div class="panel-title"><span class="live-label"><i class="live-dot" id="pressure-live-dot"></i>Live pressure</span><span class="eyebrow" style="margin:0">CIVET 1.0</span></div>
          <div class="pressure-values"><div><div class="pressure-number"><span id="live-pressure">—</span><span class="unit">kPa</span></div><span class="muted" style="font-size:.66rem" id="pressure-caption">Connect Civet to see readings</span></div><div><div class="cutoff-caption">Cutoff threshold</div><div class="cutoff-value"><span id="cutoff-value">—</span> <small>kPa</small></div><div class="cutoff-adjust"><button class="adjust-button" id="cutoff-down" aria-label="Lower cutoff by 0.1 kilopascal" type="button">− 0.1</button><button class="adjust-button" id="cutoff-up" aria-label="Raise cutoff by 0.1 kilopascal" type="button">+ 0.1</button></div></div></div>
          <div class="chart-wrap"><canvas id="pressure-chart" role="img" aria-label="Recent live pressure with cutoff and reset thresholds"></canvas></div><div class="chart-legend"><span class="legend-key">Pressure</span><span class="legend-key cutoff">Cutoff</span><span class="legend-key reset">Reset <span id="reset-value">—</span> kPa</span></div>
        </section>
        <section class="panel score-panel"><div class="score-pair"><div><p class="eyebrow">SESSION EDGES</p><div class="score-value" id="edge-count">0</div><div class="score-caption">This session</div></div><div><p class="eyebrow">PERSONAL BEST</p><div class="best-value" id="best-score">0</div><div class="score-caption">All-time record</div><span class="record-pill" id="record-pill" hidden>New personal best</span></div></div>
          <div class="session-phase"><div class="phase-top"><span class="phase-name" id="phase-name">Ready when you are</span><span class="phase-clock" id="phase-clock">—</span></div><div class="progress-track"><div class="progress-fill" id="phase-progress"></div></div><p class="phase-detail" id="phase-detail">Connect your devices and calibrate to begin.</p></div>
        </section>
        <section class="panel settings-panel span-full"><div class="panel-title"><h2>Session settings</h2><span class="eyebrow" id="mode-label" style="margin:0">SOLO</span></div>
          <div class="segmented" aria-label="Session mode"><button type="button" id="mode-solo" aria-pressed="true">Solo ramp</button><button type="button" id="mode-guest" aria-pressed="false">Guest control</button></div>
          <div id="solo-settings" style="margin-top:22px"><div class="settings-cols"><div class="control-row"><label class="control-title" for="start-percent"><span id="start-power-label">Starting power</span><output id="start-percent-value">10%</output></label><input id="start-percent" type="range" min="0" max="100" step="1" value="10"><div class="slider-endpoints"><span>0%</span><span>100%</span></div></div><div class="control-row"><label class="field-label" for="ramp-seconds">Ramp time</label><div class="input-line"><input id="ramp-seconds" type="number" min="1" max="3600" step="1" value="60" inputmode="numeric"><span class="muted" style="font-size:.75rem">seconds</span></div><p class="control-note">A new ramp begins after every cooldown.</p></div></div>
            <div id="opossum-solo-settings" hidden><hr class="inset-divider"><div class="dual-channel-grid"><div class="channel-card"><label class="control-title" for="max-percent-a"><span>Channel A maximum</span><output id="max-percent-a-value">100%</output></label><input id="max-percent-a" type="range" min="0" max="100" step="1" value="100"><div class="slider-endpoints"><span>Off</span><span>100%</span></div></div><div class="channel-card"><label class="control-title" for="max-percent-b"><span>Channel B maximum</span><output id="max-percent-b-value">100%</output></label><input id="max-percent-b" type="range" min="0" max="100" step="1" value="100"><div class="slider-endpoints"><span>Off</span><span>100%</span></div></div></div><p class="control-note">Starting power is a fraction of each channel maximum. Both channels share the ramp and cutoff; set either maximum to zero to keep that channel off.</p></div>
            <hr class="inset-divider"><div class="control-row"><label class="control-title" for="solo-cooldown"><span>Cooldown</span><output id="solo-cooldown-value">20 sec</output></label><input id="solo-cooldown" type="range" min="10" max="30" step="1" value="20"><div class="slider-endpoints"><span>10 sec</span><span>30 sec</span></div></div></div>
          <div id="guest-host-settings" style="margin-top:18px" hidden><div class="callout"><div class="callout-title" id="guest-host-status">Waiting for your guest</div><p>The guest sets speed, patterns and cooldown. Automatic pressure cutoff stays active. Create a session link in Debugging.</p></div><div class="control-row" style="margin-top:18px;margin-bottom:0"><div class="control-title"><span>Guest selected power</span><output id="host-guest-power">0%</output></div><p class="control-note" id="host-guest-pattern">Steady · 20-second cooldown</p></div></div>
          <p class="control-note" style="margin-top:19px" id="power-cap-note">Displayed 100% is capped at 65% of Lush output.</p>
        </section>
        <section class="panel span-full" id="pump-panel" hidden><div class="panel-title"><h2>Stroke adjustment</h2><span class="eyebrow" style="margin:0">HOST ONLY</span></div><div class="pump-controls"><button class="button button-secondary pump-button" id="stroke-minus" type="button">Hold · Stroke −</button><button class="button button-secondary pump-button" id="stroke-plus" type="button">Hold · Stroke +</button></div><p class="control-note">Hold to open the selected valve; releasing closes it. The physical maximum-stroke adjustment remains on the machine.</p></section>
      </div>
    </section>

    <section id="pane-setup" aria-label="Device setup" hidden><div class="setup-grid"><div class="stack"><section class="panel"><div class="panel-title"><h2>Choose your device</h2></div><div class="select-pair device-choices"><button class="choice-button" id="toy-lush" aria-pressed="true" type="button"><strong>Lovense Lush</strong><small>Bluetooth · capped at 65%</small></button><button class="choice-button" id="toy-opossum" aria-pressed="false" type="button"><strong>Opossum</strong><small>Two channels · 40% each</small></button><button class="choice-button" id="toy-vacuglide" aria-pressed="false" type="button"><strong>VacuGlide V2</strong><small>Wi-Fi · capped at 35%</small></button></div><div id="opossum-setup-note" class="callout" style="margin-top:18px" hidden><div class="callout-title">Two independent channels</div><p>A and B can run together. Set their maxima in Solo, or let your guest adjust each channel. Displayed 100% is capped at 40% of native output on each channel.</p></div></section>
        <section class="panel"><div class="panel-title"><h2>Connections</h2></div><div class="device-list"><div class="device-row"><div class="device-icon" aria-hidden="true">≈</div><div class="device-info"><strong>Civet 1.0</strong><small id="civet-detail">Pressure sensor · not connected</small></div><button class="button button-small button-secondary" id="connect-civet" type="button">Connect</button></div><hr class="inset-divider" style="margin:0"><div class="device-row"><div class="device-icon" aria-hidden="true">○</div><div class="device-info"><strong id="output-device-name">Lovense Lush</strong><small id="output-detail">Output device · not connected</small></div><button class="button button-small button-secondary" id="connect-output" type="button">Connect</button></div></div><div id="vg-token-field" style="margin-top:18px" hidden><label for="vg-token" class="field-label">VacuGlide device token</label><input id="vg-token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Enter device token privately"><p class="control-note">Put the V2 in online mode. The token is not shown to your guest.</p></div><button class="quiet-button" id="disconnect-output" type="button" style="margin-top:17px" hidden>Disconnect output device</button></section>
        <div class="callout"><div class="callout-title">Fresh setup, every session</div><p>Calibration and cutoff settings are not saved. Only your personal-best count is retained.</p></div></div>
        <section class="panel"><div class="panel-title"><h2>Calibrate Civet</h2><span class="eyebrow" style="margin:0">GUIDED SETUP</span></div><p class="calibration-intro">Zero while deflated and unloaded, then fit and inflate comfortably following the device instructions. Capture three distinct readings.</p><div class="step-list">
          <div class="calibration-step" id="cal-step-zero"><span class="step-number">1</span><div class="step-copy"><strong>Zero the sensor</strong><small>Deflated and unloaded first.</small></div><button class="button button-small" id="zero-civet" type="button">Zero</button></div>
          <div class="calibration-step" id="cal-step-relaxed"><span class="step-number">2</span><div class="step-copy"><strong>Relaxed baseline</strong><small>After fitting, remain relaxed.</small></div><button class="button button-small" id="capture-relaxed" type="button">Capture</button></div>
          <div class="calibration-step" id="cal-step-partial"><span class="step-number">3</span><div class="step-copy"><strong>Partial contraction</strong><small>A comfortable, moderate contraction.</small></div><button class="button button-small" id="capture-partial" type="button">Capture</button></div>
          <div class="calibration-step" id="cal-step-full"><span class="step-number">4</span><div class="step-copy"><strong>Stronger contraction</strong><small>Strong but comfortable.</small></div><button class="button button-small" id="capture-full" type="button">Capture</button></div>
        </div><p class="calibration-message" id="calibration-status">Connect Civet to begin. No automatic inflation is performed.</p><div class="calibration-values" id="calibration-values" hidden></div><div class="calibration-footer"><button class="quiet-button" id="reset-calibration" type="button">Start again</button><button class="button button-primary" id="finish-calibration" type="button">Use calibration</button></div></section>
      </div></section>

    <section id="pane-debug" aria-label="Developer tools" hidden><div class="debug-toolbar"><div><span class="debug-label">Developer tools</span><p class="panel-subtitle">Diagnostics, simulations and session access.</p></div><button class="quiet-button" id="lock-dev" type="button">Lock</button></div><div class="grid-two">
      <section class="panel"><div class="panel-title"><h2>Session access</h2></div><p class="panel-subtitle">Generate a short private link. It remains available until you end this session.</p><div class="link-box" id="link-box" hidden><input id="session-link" type="text" readonly aria-label="Guest session link"><button class="button button-small" id="copy-link" type="button">Copy</button></div><div class="button-row" style="margin-top:17px"><button class="button button-secondary" id="create-link" type="button">Create link</button><button class="button button-danger" id="end-link" type="button" hidden>End session link</button></div><p class="link-status" id="link-status">No active guest link</p></section>
      <section class="panel"><div class="panel-title"><h2>Simulation</h2><span class="eyebrow" style="margin:0">NO HARDWARE OUTPUT</span></div><label class="toggle-label"><input type="checkbox" id="simulation-toggle">Enable isolated test session</label><p class="control-note">Disconnects physical output before simulating. Test counts never update your saved record.</p><div id="simulation-controls" hidden><hr class="inset-divider"><label class="control-title" for="sim-pressure"><span>Simulated pressure</span><output id="sim-pressure-value">0.0 kPa</output></label><input id="sim-pressure" type="range" min="0" max="60" step="0.1" value="0"><div class="test-grid"><button class="button button-small" id="simulate-edge" type="button">Trigger an edge</button><button class="button button-small" id="simulate-record" type="button">Preview new record</button><button class="button button-small" id="preview-guest" type="button">Preview guest screen</button><button class="button button-small" id="sim-sensor-disconnect" type="button">Sensor disconnect</button><button class="button button-small" id="sim-output-disconnect" type="button">Output disconnect</button><button class="button button-small" id="sim-guest-disconnect" type="button">Guest disconnect</button></div></div></section>
      <section class="panel"><div class="panel-title"><h2>Self-checks</h2><button class="button button-small button-secondary" id="run-tests" type="button">Run checks</button></div><p class="panel-subtitle">Exercise limits, cutoff/reset, cooldown, restart behaviour and score isolation without physical output.</p><ul class="test-results" id="test-results" aria-live="polite"><li>No checks run yet.</li></ul></section>
      <section class="panel hardware-zone"><div class="panel-title"><h2>Hardware diagnostics</h2><span class="eyebrow" style="margin:0;color:var(--red)">REAL OUTPUT</span></div><p class="hardware-note">Separate from simulation. A pulse briefly drives the connected device at low output. Stop is always available.</p><label class="toggle-label"><input type="checkbox" id="hardware-arm">Enable real-device test controls</label><div class="button-row hardware-actions"><button class="button button-small" id="hardware-pulse" type="button" disabled>Low-output test pulse</button><button class="button button-small button-danger" id="hardware-stop" type="button"><span class="stop-square"></span>Stop output</button></div><p class="control-note" id="hardware-status">Not armed</p></section>
      <section class="panel span-full"><div class="panel-title"><h2>Event log</h2><button class="quiet-button" id="clear-log" type="button">Clear</button></div><ul class="debug-log" id="event-log" aria-label="Diagnostic events"><li>No events yet.</li></ul></section>
    </div></section>
  </main>

  <main id="guest-view" hidden><div class="simulation-banner" id="guest-simulation-banner" hidden>TEST SESSION — SIMULATED OUTPUT<small>No physical device is controlled. Test scores do not change the saved record.</small></div><div class="guest-hero"><span class="guest-device-pill" id="guest-device-name">LOVENSE LUSH</span><h1>You’re in control.</h1><p id="guest-connection-copy">Connecting to the session…</p></div><div class="network-alert" id="guest-alert" role="status" hidden></div><div class="guest-scoreboard"><div><p class="eyebrow">SESSION EDGES</p><div class="score-value" id="guest-edge-count">0</div></div><div><p class="eyebrow">PERSONAL BEST</p><div class="best-value" id="guest-best-score">0</div><span class="record-pill" id="guest-record-pill" hidden>New record</span></div></div>
    <section class="panel"><div class="panel-title"><h2 id="guest-speed-label">Vibration speed</h2><span class="eyebrow" id="guest-phase-label" style="margin:0">READY</span></div><div id="guest-single-output"><div class="guest-power-value"><span id="guest-power-value">0</span><small>%</small></div><label class="field-label" for="guest-speed">Set output level</label><input type="range" id="guest-speed" min="0" max="100" step="1" value="0"><div class="slider-endpoints"><span>Off</span><span>Maximum</span></div></div><div id="guest-dual-output" class="dual-channel-grid" hidden><div class="channel-card"><label class="field-label" for="guest-speed-a">Channel A</label><div class="channel-value"><span id="guest-power-a-value">0</span><small>%</small></div><input type="range" id="guest-speed-a" min="0" max="100" step="1" value="0"><div class="slider-endpoints"><span>Off</span><span>100%</span></div></div><div class="channel-card"><label class="field-label" for="guest-speed-b">Channel B</label><div class="channel-value"><span id="guest-power-b-value">0</span><small>%</small></div><input type="range" id="guest-speed-b" min="0" max="100" step="1" value="0"><div class="slider-endpoints"><span>Off</span><span>100%</span></div></div></div><p class="control-note" id="guest-power-note">The host’s output limit applies to every setting.</p><div id="guest-patterns"><hr class="inset-divider"><label class="field-label">Pattern</label><div class="pattern-grid"><button class="pattern-button" id="pattern-steady" data-pattern="steady" type="button" aria-pressed="true"><span aria-hidden="true">━━</span>Steady</button><button class="pattern-button" id="pattern-pulse" data-pattern="pulse" type="button" aria-pressed="false"><span aria-hidden="true">▂ ▆ ▂</span>Pulse</button><button class="pattern-button" id="pattern-wave" data-pattern="wave" type="button" aria-pressed="false"><span aria-hidden="true">∿∿</span>Wave</button></div></div><hr class="inset-divider"><label class="control-title" for="guest-cooldown"><span>Cooldown after cutoff</span><output id="guest-cooldown-value">20 sec</output></label><input type="range" id="guest-cooldown" min="10" max="30" step="1" value="20"><div class="slider-endpoints"><span>10 sec</span><span>30 sec</span></div><p class="control-note">Changes apply to the next cutoff.</p></section>
    <p class="guest-footer"><strong>Automatic pressure cutoff is active.</strong><br>When it activates, you’ll see the count and a cooldown timer.</p>
  </main>

  <footer class="bottom-bar"><div class="bottom-inner"><div class="bottom-status"><strong id="bottom-title">Session not started</strong><span id="bottom-copy">Your controls stay here.</span></div><div class="bottom-actions" id="host-bottom-actions"><button class="button button-primary" id="session-start" type="button">Start session</button><button class="button" id="session-pause" type="button" hidden>Pause</button><button class="button button-primary" id="session-resume" type="button" hidden>Resume</button><button class="button button-danger stop-button" id="session-stop" type="button"><span class="stop-square"></span>Stop</button></div><div class="bottom-actions" id="guest-bottom-actions" hidden><button class="button button-danger" id="guest-stop" type="button"><span class="stop-square"></span><span id="guest-stop-label">Stop output</span></button></div></div></footer>
</div>

<div class="modal-backdrop" id="unlock-modal" role="dialog" aria-modal="true" aria-labelledby="unlock-title" hidden><form class="modal" id="unlock-form"><p class="eyebrow">PRIVATE ACCESS</p><h2 id="unlock-title">Debugging</h2><p>Enter your developer password to open session access and test tools.</p><label class="field-label" for="dev-password">Password</label><input id="dev-password" type="password" autocomplete="current-password" required><div class="button-row"><button class="button" id="unlock-cancel" type="button">Cancel</button><button class="button button-primary" id="unlock-submit" type="submit">Unlock</button></div></form></div>

<div class="cooldown-backdrop" id="cooldown-overlay" role="dialog" aria-modal="true" aria-labelledby="cooldown-title" hidden><section class="cooldown-content"><div class="event-symbol" aria-hidden="true">✦</div><p class="eyebrow" id="overlay-eyebrow">AUTOMATIC CUTOFF ACTIVATED</p><h2 id="cooldown-title">Nice timing.</h2><p class="cooldown-copy" id="cooldown-copy">The pressure threshold was reached. Output is paused for the cooldown.</p><div class="record-celebration" id="overlay-record" hidden>✦ New personal best — record updated</div><div class="overlay-scores"><div><div class="score-value" id="overlay-count">0</div><div class="score-caption">Session edges</div></div><div><div class="best-value" id="overlay-best">0</div><div class="score-caption">Personal best</div></div></div><div class="cooldown-timer"><span id="overlay-seconds">20</span><small id="overlay-seconds-unit">sec</small></div><div class="cooldown-timer-label" id="overlay-timer-label">Until cooldown is complete</div><div class="progress-track"><div class="progress-fill" id="overlay-progress"></div></div><p class="cooldown-footnote" id="overlay-footnote">Your selected settings resume after the timer finishes and pressure has settled.</p><div class="button-row" style="justify-content:center;margin-top:20px"><button class="button button-small button-danger" id="overlay-stop" type="button"><span class="stop-square"></span><span id="overlay-stop-label">Stop output</span></button></div><div class="preview-tag" id="overlay-preview" hidden>SIMULATION PREVIEW · no live output<br><button class="button button-small" id="close-preview" type="button">Back to Debugging</button></div></section></div>
<div class="toast" id="toast" role="status" hidden></div>`;

const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const fixed = (value, places = 1) => value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(places);
const connected = value => typeof value === 'boolean' ? value : Boolean(value?.connected);
const phaseNames = { idle: 'Ready when you are', running: 'Output active', cooldown: 'Cooldown', settling: 'Waiting for pressure', paused: 'Paused', stopped: 'Session stopped', fault: 'Connection paused' };

export class UI {
  constructor({ onAction } = {}) {
    this.onAction = onAction || (() => {});
    this.view = {};
    this.tab = 'play';
    this.samples = [];
    this.lastSampleAt = 0;
    this.lastLogKey = '';
    this.lastTestsKey = '';
    this.previewOpen = false;
    this.holdValves = new Set();
    this.root = document.getElementById('app');
    if (!this.root) throw new Error('The control panel container is missing.');
    this.root.innerHTML = template;
    this.nodes = Object.fromEntries([...this.root.querySelectorAll('[id]')].map(node => [node.id, node]));
    this.bindEvents();
  }

  node(id) { return this.nodes[id]; }
  text(id, text) { const n = this.node(id); if (n && n.textContent !== String(text)) n.textContent = String(text); }
  hide(id, hidden) { const n = this.node(id); if (n) n.hidden = Boolean(hidden); }
  disable(id, disabled) { const n = this.node(id); if (n) n.disabled = Boolean(disabled); }
  value(id, value) { const n = this.node(id); if (n && document.activeElement !== n && value !== undefined && value !== null && n.value !== String(value)) n.value = String(value); }
  action(name, payload = {}) {
    try {
      const result = this.onAction(name, payload);
      if (result?.catch) result.catch(error => this.message(error?.message || 'That action could not be completed.', true));
      return result;
    } catch (error) { this.message(error?.message || 'That action could not be completed.', true); }
  }

  bindEvents() {
    const click = (id, action, payload = {}) => this.node(id).addEventListener('click', () => this.action(action, typeof payload === 'function' ? payload() : payload));
    this.root.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => this.changeTab(button.dataset.tab)));
    this.node('debug-button').addEventListener('click', () => {
      if (this.view.devUnlocked) this.changeTab('debug');
      else { this.hide('unlock-modal', false); this.node('app-shell').inert = true; this.node('dev-password').focus(); }
    });
    this.node('unlock-cancel').addEventListener('click', () => this.closeUnlock());
    this.node('unlock-form').addEventListener('submit', event => {
      event.preventDefault();
      const password = this.node('dev-password').value;
      this.node('dev-password').value = '';
      if (password) this.action('unlock-dev', { password });
    });
    this.node('unlock-modal').addEventListener('keydown', event => {
      if (event.key === 'Escape') this.closeUnlock();
      if (event.key === 'Tab') {
        const first = this.node('dev-password'), last = this.node('unlock-submit');
        if (event.shiftKey && document.activeElement === first) { last.focus(); event.preventDefault(); }
        else if (!event.shiftKey && document.activeElement === last) { first.focus(); event.preventDefault(); }
      }
    });
    click('toy-lush', 'select-toy', { toy: 'lush' }); click('toy-opossum', 'select-toy', { toy: 'opossum' }); click('toy-vacuglide', 'select-toy', { toy: 'vacuglide' });
    click('mode-solo', 'select-mode', { mode: 'solo' }); click('mode-guest', 'select-mode', { mode: 'guest' });
    click('connect-civet', 'connect-civet'); click('zero-civet', 'zero-civet');
    click('connect-output', 'connect-output', () => ({ token: this.node('vg-token').value.trim() }));
    click('disconnect-output', 'disconnect-output');
    ['relaxed', 'partial', 'full'].forEach(stage => click('capture-' + stage, 'calibrate', { stage }));
    click('reset-calibration', 'reset-calibration'); click('finish-calibration', 'finish-calibration');
    click('cutoff-down', 'adjust-cutoff', { delta: -0.1 }); click('cutoff-up', 'adjust-cutoff', { delta: 0.1 });
    click('session-start', 'start'); click('session-pause', 'pause'); click('session-resume', 'resume'); click('session-stop', 'stop'); click('hardware-stop', 'stop');
    click('guest-stop', 'guest-output', { percent: 0, percentA: 0, percentB: 0 }); click('overlay-stop', 'guest-output', { percent: 0, percentA: 0, percentB: 0 });
    this.node('start-percent').addEventListener('input', event => { this.text('start-percent-value', event.target.value + '%'); this.action('configure', { startPercent: Number(event.target.value) }); });
    for (const channel of ['a', 'b']) {
      this.node('max-percent-' + channel).addEventListener('input', event => { this.text('max-percent-' + channel + '-value', event.target.value + '%'); this.action('configure', { [channel === 'a' ? 'maxPercentA' : 'maxPercentB']: Number(event.target.value) }); });
      this.node('guest-speed-' + channel).addEventListener('input', event => { this.text('guest-power-' + channel + '-value', event.target.value); this.action('guest-output', { [channel === 'a' ? 'percentA' : 'percentB']: Number(event.target.value) }); });
    }
    this.node('ramp-seconds').addEventListener('change', event => this.action('configure', { rampSeconds: Number(event.target.value) }));
    this.node('solo-cooldown').addEventListener('input', event => { this.text('solo-cooldown-value', event.target.value + ' sec'); this.action('configure', { cooldownSeconds: Number(event.target.value) }); });
    this.node('guest-speed').addEventListener('input', event => { this.text('guest-power-value', event.target.value); this.action('guest-output', { percent: Number(event.target.value) }); });
    this.node('guest-cooldown').addEventListener('input', event => { this.text('guest-cooldown-value', event.target.value + ' sec'); this.action('guest-output', { cooldownSeconds: Number(event.target.value) }); });
    this.root.querySelectorAll('[data-pattern]').forEach(button => button.addEventListener('click', () => this.action('guest-output', { pattern: button.dataset.pattern })));
    click('lock-dev', 'lock-dev'); click('create-link', 'create-link'); click('end-link', 'end-link');
    click('copy-link', 'copy-link', () => ({ url: this.node('session-link').value }));
    this.node('simulation-toggle').addEventListener('change', event => this.action('simulation', { enabled: event.target.checked }));
    this.node('sim-pressure').addEventListener('input', event => { this.text('sim-pressure-value', Number(event.target.value).toFixed(1) + ' kPa'); this.action('simulate-pressure', { pressure: Number(event.target.value) }); });
    click('simulate-edge', 'simulate-edge'); click('simulate-record', 'simulate-record');
    click('sim-sensor-disconnect', 'simulate-disconnect', { device: 'civet' }); click('sim-output-disconnect', 'simulate-disconnect', { device: 'output' }); click('sim-guest-disconnect', 'simulate-disconnect', { device: 'guest' });
    this.node('preview-guest').addEventListener('click', () => { this.previewOpen = true; this.action('preview-guest'); this.render(this.view); });
    this.node('close-preview').addEventListener('click', () => { this.previewOpen = false; this.action('dismiss-overlay'); this.render(this.view); this.node('preview-guest').focus(); });
    click('run-tests', 'run-tests'); click('clear-log', 'clear-log');
    this.node('hardware-arm').addEventListener('change', event => this.action('hardware-arm', { enabled: event.target.checked }));
    click('hardware-pulse', 'hardware-pulse');
    ['minus', 'plus'].forEach(kind => this.bindValve('stroke-' + kind, kind));
    window.addEventListener('blur', () => this.releaseValves());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseValves(); });
  }

  bindValve(id, kind) {
    const button = this.node(id);
    const begin = event => {
      if (button.disabled || this.holdValves.has(kind)) return;
      event.preventDefault();
      this.holdValves.add(kind);
      if (event.pointerId !== undefined) { try { button.setPointerCapture(event.pointerId); } catch {} }
      this.action('valve', { kind, open: true });
    };
    const end = () => {
      if (!this.holdValves.delete(kind)) return;
      this.action('valve', { kind, open: false });
    };
    button.addEventListener('pointerdown', begin);
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(name => button.addEventListener(name, end));
    button.addEventListener('keydown', event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) begin(event); });
    button.addEventListener('keyup', event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); end(); } });
    button.addEventListener('blur', end);
    button.addEventListener('contextmenu', event => event.preventDefault());
  }

  releaseValves() {
    for (const kind of [...this.holdValves]) { this.holdValves.delete(kind); this.action('valve', { kind, open: false }); }
  }

  closeUnlock() {
    this.hide('unlock-modal', true); this.node('dev-password').value = ''; this.node('app-shell').inert = false; this.node('debug-button').focus();
  }

  changeTab(tab) {
    if (tab === 'debug' && !this.view.devUnlocked) return;
    this.releaseValves(); this.tab = tab; this.render(this.view);
  }

  message(text, error = false) {
    this.text('toast', text); this.node('toast').dataset.error = String(Boolean(error)); this.hide('toast', false);
    clearTimeout(this.toastTimer); this.toastTimer = setTimeout(() => this.hide('toast', true), error ? 9000 : 5500);
  }

  render(view = {}) {
    const previous = this.view;
    this.view = view;
    const engine = view.engine || {}, devices = view.devices || {};
    const guest = view.screen === 'guest', toy = view.toy || engine.toy || 'lush', vg = toy === 'vacuglide', opossum = toy === 'opossum';
    const mode = view.mode || engine.mode || 'solo', phase = engine.phase || 'idle';
    const simulation = Boolean(view.simulation), busy = Boolean(view.busy);
    const sensorConnected = simulation || connected(devices.civet), outputConnected = simulation || connected(devices[toy]);
    const best = number(view.best), count = number(engine.edgeCount);
    const record = Boolean(view.newRecord || engine.newRecord || count > best);
    const cooldown = phase === 'cooldown' || phase === 'settling';
    const active = ['running', 'cooldown', 'settling'].includes(phase);
    const resumed = phase === 'paused' || phase === 'fault';
    if (view.devUnlocked && !previous.devUnlocked) { this.closeUnlock(); this.tab = 'debug'; }
    if (!view.devUnlocked && this.tab === 'debug') this.tab = 'play';
    if (!simulation) this.previewOpen = false;
    this.node('app-shell').classList.toggle('guest-shell', guest);
    this.hide('host-view', guest); this.hide('guest-view', !guest); this.hide('debug-button', guest);
    this.hide('host-bottom-actions', guest); this.hide('guest-bottom-actions', !guest);
    this.text('brand-sub', guest ? 'PRIVATE SESSION' : 'PRIVATE CONTROL');
    this.hide('tab-debug', !view.devUnlocked); this.hide('busy-indicator', !busy);
    for (const tab of ['play', 'setup', 'debug']) { this.hide('pane-' + tab, this.tab !== tab); this.node('tab-' + tab).setAttribute('aria-selected', String(this.tab === tab)); }
    this.hide('simulation-banner', !simulation);
    this.hide('guest-simulation-banner', !simulation);
    const wake = typeof view.wakeStatus === 'string' ? view.wakeStatus : view.wakeStatus?.status;
    const wakeActive = wake === 'active' || wake === 'awake' || wake === 'held' || view.wakeStatus === true;
    this.node('wake-status').dataset.active = String(wakeActive);
    this.text('wake-status', wakeActive ? 'Screen awake' : wake === 'unsupported' ? 'Keep screen open' : 'Keep awake');
    this.node('civet-chip').dataset.connected = String(sensorConnected); this.text('civet-chip', simulation ? 'Civet simulated' : sensorConnected ? 'Civet connected' : 'Civet disconnected');
    this.node('output-chip').dataset.connected = String(outputConnected); this.text('output-chip', simulation ? 'Output simulated' : (vg ? 'VacuGlide' : opossum ? 'Opossum' : 'Lush') + (outputConnected ? ' connected' : ' disconnected'));
    this.node('guest-chip').dataset.connected = String(Boolean(view.guestConnected)); this.text('guest-chip', view.guestConnected ? 'Guest connected' : 'Guest offline'); this.hide('guest-chip', mode !== 'guest');
    const connectionError = view.connectionError || (phase === 'fault' ? engine.reason : '');
    this.text('connection-alert', connectionError || ''); this.hide('connection-alert', !connectionError);
    this.text('live-pressure', fixed(engine.pressure)); this.text('cutoff-value', fixed(engine.threshold)); this.text('reset-value', fixed(engine.resetThreshold));
    this.text('pressure-caption', simulation ? 'Simulated readings · no hardware output' : sensorConnected ? 'Live sensor readings' : 'Connect Civet to see readings');
    this.node('pressure-live-dot').style.background = sensorConnected ? 'var(--green)' : '#746b7a';
    this.disable('cutoff-down', busy || engine.threshold === undefined); this.disable('cutoff-up', busy || engine.threshold === undefined);
    this.text('edge-count', count); this.text('best-score', best); this.hide('record-pill', !record);
    this.text('phase-name', phaseNames[phase] || phase);
    const remaining = Math.max(0, Math.ceil(number(engine.remainingCooldown)));
    this.text('phase-clock', cooldown ? (phase === 'settling' ? 'Waiting' : remaining + ' sec') : opossum ? 'A ' + Math.round(number(engine.outputPercentA)) + '% · B ' + Math.round(number(engine.outputPercentB)) + '%' : Math.round(number(engine.outputPercent)) + '%');
    this.node('phase-progress').style.width = (cooldown ? Math.min(100, 100 * (1 - remaining / Math.max(1, number(engine.cooldownSeconds, 20)))) : Math.max(0, Math.min(100, number(engine.outputPercent)))) + '%';
    const descriptions = { idle: 'Connect your devices and calibrate to begin.', running: mode === 'solo' ? 'Ramping toward your selected device limit.' : 'Guest controls are active. Automatic cutoff has priority.', cooldown: 'Output paused. The next cycle starts after cooldown and pressure reset.', settling: 'Cooldown complete. Waiting for fresh pressure below the reset threshold.', paused: 'Output is paused. Resume when you are ready.', stopped: 'Output stopped. Start a new session when ready.', fault: engine.reason || 'Connection issue detected. Check devices before resuming.' };
    this.text('phase-detail', descriptions[phase] || engine.reason || '');
    this.text('bottom-title', phaseNames[phase] || phase); this.text('bottom-copy', cooldown ? 'Cutoff has priority.' : simulation ? 'Simulation only.' : 'Stop is always available.');
    this.hide('session-start', active || resumed); this.hide('session-pause', !active); this.hide('session-resume', !resumed);
    this.disable('session-start', busy || !sensorConnected || !outputConnected); this.disable('session-resume', busy || !sensorConnected || !outputConnected);
    this.text('mode-label', mode === 'guest' ? 'GUEST CONTROL' : 'SOLO'); this.hide('solo-settings', mode === 'guest'); this.hide('guest-host-settings', mode !== 'guest');
    this.node('mode-solo').setAttribute('aria-pressed', String(mode === 'solo')); this.node('mode-guest').setAttribute('aria-pressed', String(mode === 'guest'));
    this.disable('mode-solo', active); this.disable('mode-guest', active);
    this.text('host-guest-power', opossum ? 'A ' + Math.round(number(engine.guestPercentA ?? engine.guestPercent)) + '% · B ' + Math.round(number(engine.guestPercentB)) + '%' : Math.round(number(engine.guestPercent)) + '%'); this.text('host-guest-pattern', (engine.pattern || 'steady') + ' · ' + number(engine.cooldownSeconds, 20) + '-second cooldown');
    this.text('guest-host-status', view.guestConnected ? 'Your guest is connected' : 'Waiting for your guest');
    this.text('start-power-label', opossum ? 'Starting fraction of each maximum' : 'Starting power');
    this.hide('opossum-solo-settings', !opossum);
    this.value('max-percent-a', engine.maxPercentA ?? 100); this.text('max-percent-a-value', Math.round(number(engine.maxPercentA, 100)) + '%');
    this.value('max-percent-b', engine.maxPercentB ?? 100); this.text('max-percent-b-value', Math.round(number(engine.maxPercentB, 100)) + '%');
    this.disable('max-percent-a', busy); this.disable('max-percent-b', busy);
    this.value('start-percent', engine.startPercent ?? 10); this.text('start-percent-value', Math.round(number(engine.startPercent, 10)) + '%');
    this.value('ramp-seconds', engine.rampSeconds ?? 60); this.value('solo-cooldown', engine.cooldownSeconds ?? 20); this.text('solo-cooldown-value', number(engine.cooldownSeconds, 20) + ' sec');
    this.text('power-cap-note', vg ? 'Displayed 100% is capped at 35% of VacuGlide speed.' : opossum ? 'Displayed 100% on either Opossum channel is capped at 40% of its native output.' : 'Displayed 100% is capped at 65% of Lush output.');
    this.hide('pump-panel', !vg); this.disable('stroke-plus', !outputConnected || busy || simulation); this.disable('stroke-minus', !outputConnected || busy || simulation);
    this.node('toy-lush').setAttribute('aria-pressed', String(toy === 'lush')); this.node('toy-opossum').setAttribute('aria-pressed', String(opossum)); this.node('toy-vacuglide').setAttribute('aria-pressed', String(vg));
    this.disable('toy-lush', active); this.disable('toy-opossum', active); this.disable('toy-vacuglide', active);
    this.hide('opossum-setup-note', !opossum);
    this.text('output-device-name', vg ? 'VacuGlide V2' : opossum ? 'Opossum' : 'Lovense Lush'); this.hide('vg-token-field', !vg);
    const battery = devices.civet?.battery;
    this.text('civet-detail', simulation ? 'Simulated sensor' : sensorConnected ? 'Connected' + (battery !== undefined && battery !== null ? ' · ' + battery + '% battery' : '') : 'Pressure sensor · not connected');
    this.text('output-detail', simulation ? 'Simulated output' : outputConnected ? 'Connected · limit enforced' : (vg ? 'Online mode required' : 'Output device · not connected'));
    if (vg && connected(devices.vacuglide) && !connected(previous.devices?.vacuglide)) this.node('vg-token').value = '';
    this.text('connect-civet', sensorConnected && !simulation ? 'Connected' : 'Connect'); this.text('connect-output', outputConnected && !simulation ? 'Connected' : 'Connect');
    this.disable('connect-civet', busy || simulation || sensorConnected); this.disable('connect-output', busy || simulation || outputConnected);
    this.hide('disconnect-output', !outputConnected || simulation); this.disable('zero-civet', busy || !sensorConnected || active);
    this.renderCalibration(view.calibration || {}, { sensorConnected, busy, active });
    this.renderDeveloper(view, { busy, simulation, outputConnected });
    this.renderGuest(view, { engine, vg, opossum, phase, best, count, record, remaining, cooldown, busy });
    this.drawChart(engine, simulation);
  }

  renderCalibration(calibration, { sensorConnected, busy, active }) {
    const values = calibration.values || {};
    const labels = { relaxed: 'Relaxed', partial: 'Partial', full: 'Stronger' };
    this.text('calibration-status', calibration.status || (sensorConnected ? 'Zero the unloaded sensor, then capture your readings.' : 'Connect Civet to begin. No automatic inflation is performed.'));
    for (const stage of ['relaxed', 'partial', 'full']) {
      const exists = values[stage] !== undefined && values[stage] !== null;
      this.node('cal-step-' + stage).dataset.done = String(exists);
      this.text('capture-' + stage, calibration.step === stage && busy ? 'Reading…' : exists ? 'Retake' : 'Capture');
      this.disable('capture-' + stage, busy || !sensorConnected || active);
    }
    this.node('cal-step-zero').dataset.done = String(Boolean(calibration.zeroed || calibration.step === 'relaxed' || values.relaxed !== undefined));
    const entries = ['relaxed', 'partial', 'full'].filter(stage => values[stage] !== undefined).map(stage => labels[stage] + ': ' + fixed(typeof values[stage] === 'object' ? values[stage].mean : values[stage]) + ' kPa');
    this.text('calibration-values', entries.join(' · ')); this.hide('calibration-values', !entries.length);
    this.disable('finish-calibration', busy || active || entries.length < 3); this.disable('reset-calibration', active || busy);
    this.text('finish-calibration', calibration.complete ? 'Calibration ready' : 'Use calibration');
  }

  renderDeveloper(view, { busy, simulation, outputConnected }) {
    let link = view.link;
    if (link && typeof link === 'object') link = link.url || link.link || (link.code ? location.origin + '/' + link.code : '');
    const hasLink = Boolean(link || view.link?.sessionId || view.link?.session_id);
    this.hide('link-box', !link); this.hide('end-link', !hasLink); this.value('session-link', link || '');
    this.text('link-status', hasLink ? view.guestConnected ? 'Guest connected · one controller' : link ? 'Link active · waiting for guest' : 'An earlier session is still active. End it before creating another.' : 'No active guest link');
    this.text('create-link', simulation ? hasLink ? 'Create new test link' : 'Create test link' : hasLink ? 'Create new link' : 'Create link'); this.disable('create-link', busy || !view.devUnlocked);
    this.disable('end-link', busy || !view.devUnlocked); this.node('simulation-toggle').checked = simulation;
    this.disable('simulation-toggle', busy || hasLink); this.hide('simulation-controls', !simulation);
    this.value('sim-pressure', view.engine?.pressure ?? 0); this.text('sim-pressure-value', fixed(view.engine?.pressure ?? 0) + ' kPa');
    const armed = Boolean(view.hardwareArmed);
    this.node('hardware-arm').checked = armed; this.disable('hardware-arm', simulation || busy || !outputConnected);
    this.disable('hardware-pulse', !armed || simulation || busy || !outputConnected);
    this.text('hardware-pulse', view.toy === 'opossum' ? 'Test both channels · 20%' : 'Low-output test pulse');
    this.text('hardware-status', simulation ? 'Unavailable during simulation' : armed ? view.toy === 'opossum' ? 'Armed · both channels pulse together for one second' : 'Armed · low-output pulse available' : outputConnected ? 'Connected · not armed' : 'Connect an output device to test');
    const logs = Array.isArray(view.logs) ? view.logs.slice(-100) : [];
    const logKey = JSON.stringify(logs);
    if (logKey !== this.lastLogKey) {
      this.lastLogKey = logKey;
      const list = this.node('event-log'); list.replaceChildren();
      const rendered = logs.length ? logs : ['No events yet.'];
      rendered.forEach(entry => { const li = document.createElement('li'); li.textContent = typeof entry === 'string' ? entry : [entry.time || entry.at || '', entry.message || entry.type || JSON.stringify(entry)].filter(Boolean).join(' · '); list.append(li); });
      list.scrollTop = list.scrollHeight;
    }
    const tests = Array.isArray(view.testResults) ? view.testResults : [];
    const testsKey = JSON.stringify(tests);
    if (testsKey !== this.lastTestsKey) {
      this.lastTestsKey = testsKey;
      const list = this.node('test-results'); list.replaceChildren();
      const rendered = tests.length ? tests : ['No checks run yet.'];
      rendered.forEach(test => {
        const li = document.createElement('li');
        if (typeof test === 'string') li.textContent = test;
        else { const pass = test.pass ?? test.passed ?? test.ok; li.dataset.pass = String(Boolean(pass)); li.textContent = (pass ? '✓ ' : '× ') + (test.name || test.label || 'Check') + (test.message ? ' — ' + test.message : ''); }
        list.append(li);
      });
    }
  }

  renderGuest(view, state) {
    const { engine, vg, opossum, phase, best, count, record, remaining, cooldown, busy } = state;
    const guest = view.screen === 'guest';
    const fault = ['fault', 'paused', 'stopped', 'idle'].includes(phase);
    const connected = Boolean(view.guestConnected || view.networkStatus === 'connected' || view.networkStatus === 'online');
    this.text('guest-device-name', vg ? 'VACUGLIDE V2' : opossum ? 'OPOSSUM' : 'LOVENSE LUSH');
    this.text('guest-speed-label', vg ? 'Stroke speed' : opossum ? 'Dual-channel vibration' : 'Vibration speed');
    this.text('guest-connection-copy', connected ? 'Connected. Your settings update live.' : 'Waiting for the host connection…');
    this.text('guest-edge-count', count); this.text('guest-best-score', best); this.hide('guest-record-pill', !record);
    this.text('guest-phase-label', phase === 'running' ? 'LIVE' : phase.toUpperCase());
    this.hide('guest-single-output', opossum); this.hide('guest-dual-output', !opossum);
    this.value('guest-speed', engine.guestPercent ?? engine.outputPercent ?? 0); this.text('guest-power-value', Math.round(number(engine.guestPercent ?? engine.outputPercent)));
    this.value('guest-speed-a', engine.guestPercentA ?? engine.guestPercent ?? 0); this.text('guest-power-a-value', Math.round(number(engine.guestPercentA ?? engine.guestPercent)));
    this.value('guest-speed-b', engine.guestPercentB ?? 0); this.text('guest-power-b-value', Math.round(number(engine.guestPercentB)));
    this.text('guest-power-note', opossum ? 'Both channels can run together, with independent levels and one shared pattern. Each channel has its own host-enforced limit.' : 'The host’s output limit applies to every setting.');
    this.text('guest-stop-label', opossum ? 'Stop both channels' : 'Stop output'); this.text('overlay-stop-label', opossum ? 'Stop both channels' : 'Stop output');
    this.value('guest-cooldown', engine.cooldownSeconds ?? 20); this.text('guest-cooldown-value', number(engine.cooldownSeconds, 20) + ' sec');
    this.hide('guest-patterns', vg);
    const blocked = busy || cooldown || fault || !connected;
    this.disable('guest-speed', blocked); this.disable('guest-speed-a', blocked); this.disable('guest-speed-b', blocked); this.disable('guest-cooldown', blocked); this.disable('guest-stop', !connected || busy);
    for (const pattern of ['steady', 'pulse', 'wave']) { this.node('pattern-' + pattern).setAttribute('aria-pressed', String((engine.pattern || 'steady') === pattern)); this.disable('pattern-' + pattern, blocked); }
    const alert = view.connectionError || (fault ? engine.reason || (phase === 'idle' ? 'Waiting for the host to start the session.' : 'The host has paused or stopped output.') : !connected ? 'Connection interrupted. Controls will return when the session reconnects.' : '');
    this.text('guest-alert', alert); this.hide('guest-alert', !alert);
    const preview = Boolean(view.simulation && (this.previewOpen || view.guestPreview || view.previewOverlay));
    const showOverlay = (guest && cooldown) || preview;
    this.hide('cooldown-overlay', !showOverlay);
    if (this.node('unlock-modal').hidden) this.node('app-shell').inert = showOverlay;
    if (!showOverlay) return;
    const previewState = typeof view.previewOverlay === 'object' ? view.previewOverlay : {};
    const overlayCount = previewState.edgeCount ?? count;
    const overlayBest = previewState.best ?? best;
    const overlayRecord = previewState.newRecord ?? record;
    const overlayRemaining = previewState.remainingCooldown ?? remaining;
    const waiting = phase === 'settling' && !previewState.remainingCooldown;
    this.text('overlay-count', overlayCount); this.text('overlay-best', overlayBest); this.hide('overlay-record', !overlayRecord);
    this.text('overlay-record', preview ? '✦ New personal best — simulation only' : '✦ New personal best — record updated');
    const title = overlayRecord ? 'A new personal best.' : overlayCount > 0 && overlayCount % 10 === 0 ? 'Milestone reached.' : overlayCount > 0 && overlayCount === overlayBest ? 'Personal best matched.' : 'Nice timing.';
    this.text('cooldown-title', title);
    this.text('overlay-seconds', waiting ? 'Ready' : Math.max(0, Math.ceil(overlayRemaining))); this.hide('overlay-seconds-unit', waiting);
    this.text('overlay-timer-label', waiting ? 'Waiting for pressure to settle' : 'Until cooldown is complete');
    this.node('overlay-progress').style.width = Math.max(0, Math.min(100, 100 * (1 - overlayRemaining / Math.max(1, number(engine.cooldownSeconds, 20))))) + '%';
    this.hide('overlay-preview', !preview);
    this.hide('overlay-stop', !guest || preview); this.disable('overlay-stop', !connected || busy);
    this.text('overlay-footnote', preview ? 'Preview only. No real device is being driven and your saved record is unchanged.' : 'Your selected settings resume after the timer finishes and pressure has settled.');
  }

  drawChart(engine, simulation) {
    const now = Date.now();
    if (simulation !== this.previousSimulation) { this.samples = []; this.previousSimulation = simulation; }
    if (Number.isFinite(engine.pressure) && now - this.lastSampleAt > 95) { this.samples.push(engine.pressure); this.lastSampleAt = now; if (this.samples.length > 180) this.samples.shift(); }
    if (this.tab !== 'play' || this.view.screen === 'guest') return;
    const canvas = this.node('pressure-chart');
    let ctx;
    try { ctx = canvas.getContext('2d'); } catch { return; }
    if (!ctx) return;
    const width = canvas.clientWidth || 400, height = canvas.clientHeight || 154;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) { canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    const values = [...this.samples, engine.threshold, engine.resetThreshold].filter(Number.isFinite);
    let min = values.length ? Math.min(...values) - 0.6 : 0, max = values.length ? Math.max(...values) + 0.6 : 5;
    if (max - min < 2) { const mid = (max + min) / 2; min = mid - 1; max = mid + 1; }
    const left = 8, right = width - 8, top = 13, bottom = height - 15;
    const y = value => bottom - ((value - min) / (max - min)) * (bottom - top);
    for (let row = 0; row <= 3; row++) { const yy = top + row * (bottom - top) / 3; ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.strokeStyle = '#ffffff09'; ctx.lineWidth = 1; ctx.stroke(); }
    for (const [value, color] of [[engine.threshold, '#ef8b9170'], [engine.resetThreshold, '#9b739f75']]) {
      if (!Number.isFinite(value)) continue;
      ctx.beginPath(); ctx.setLineDash([4, 5]); ctx.moveTo(left, y(value)); ctx.lineTo(right, y(value)); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
    }
    if (!this.samples.length) { ctx.fillStyle = '#827889'; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.fillText('Waiting for pressure readings', width / 2, height / 2); return; }
    const points = this.samples.map((value, index) => [left + index / Math.max(179, this.samples.length - 1) * (right - left), y(value)]);
    const gradient = ctx.createLinearGradient(0, top, 0, bottom); gradient.addColorStop(0, '#e6c88324'); gradient.addColorStop(1, '#e6c88300');
    ctx.beginPath(); ctx.moveTo(points[0][0], bottom); points.forEach(([x, yy]) => ctx.lineTo(x, yy)); ctx.lineTo(points.at(-1)[0], bottom); ctx.closePath(); ctx.fillStyle = gradient; ctx.fill();
    ctx.beginPath(); points.forEach(([x, yy], index) => index ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy)); ctx.strokeStyle = '#e6c883'; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.stroke();
    const last = points.at(-1); ctx.beginPath(); ctx.arc(last[0], last[1], 3, 0, Math.PI * 2); ctx.fillStyle = '#e6c883'; ctx.fill();
  }
}
