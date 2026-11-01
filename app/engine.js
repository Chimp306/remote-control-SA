/**
 * Host-owned session state. This module never discovers or controls hardware by
 * itself: the host supplies onOutput and calls tick regularly (about 100 ms).
 * Percentages here are display percentages; each driver independently enforces
 * its physical cap. Pressure thresholds are user calibration, not medical limits.
 */
export const SENSOR_FRESH_MS = 1000;
export const ENGINE_DEFAULTS = Object.freeze({
  toy: 'lush', mode: 'solo', startPercent: 10, rampSeconds: 60,
  maxPercentA: 100, maxPercentB: 100,
  cooldownSeconds: 20, threshold: 22.9, resetThreshold: 21.6,
});

const ACTIVE = new Set(['running', 'cooldown', 'settling']);
const PATTERNS = new Set(['steady', 'pulse', 'wave']);
const finite = (value, name) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be a finite number.`);
  return value;
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const tenth = value => Math.round((value + Number.EPSILON) * 10) / 10;
const pressureLevel = (value, name) => {
  finite(value, name);
  if (value < -327.6 || value > 327.6) throw new RangeError(`${name} is outside the sensor's numeric range.`);
  return tenth(value);
};

export class SessionEngine {
  constructor({ now = () => Date.now(), onOutput = () => {}, onEvent = () => {}, simulation = false } = {}) {
    this.now = now;
    this.onOutput = onOutput;
    this.onEvent = onEvent;
    this.simulation = Boolean(simulation);
    this.config = { ...ENGINE_DEFAULTS };
    this.phase = 'idle';
    this.pressure = null;
    this.pressureAt = null;
    this.edgeCount = 0;
    this.outputPercent = 0;
    this.outputPercentA = 0;
    this.outputPercentB = 0;
    this.guestPercent = 0;
    this.guestPercentA = 0;
    this.guestPercentB = 0;
    this.pattern = 'steady';
    this.cooldownEndsAt = null;
    this.reason = '';
    this._cycleStartedAt = null;
    this._pausedCooldownMs = 0;
    this._pausedPhase = null;
    this._armed = false;
    this._generation = 0;
    this._lastTickAt = null;
  }

  configure(values = {}) {
    const next = { ...this.config };
    if (values.toy !== undefined) {
      if (!['lush', 'opossum', 'vacuglide'].includes(values.toy)) throw new TypeError('Unsupported device.');
      next.toy = values.toy;
    }
    if (values.mode !== undefined) {
      if (!['solo', 'guest'].includes(values.mode)) throw new TypeError('Unsupported session mode.');
      next.mode = values.mode;
    }
    if (ACTIVE.has(this.phase) && (next.toy !== this.config.toy || next.mode !== this.config.mode)) {
      throw new Error('Pause or stop before changing device or session mode.');
    }
    if (values.startPercent !== undefined) next.startPercent = clamp(finite(values.startPercent, 'Start percentage'), 0, 100);
    if (values.maxPercentA !== undefined) next.maxPercentA = clamp(finite(values.maxPercentA, 'Channel A maximum'), 0, 100);
    if (values.maxPercentB !== undefined) next.maxPercentB = clamp(finite(values.maxPercentB, 'Channel B maximum'), 0, 100);
    if (values.rampSeconds !== undefined) next.rampSeconds = clamp(finite(values.rampSeconds, 'Ramp duration'), 0, 3600);
    if (values.cooldownSeconds !== undefined) next.cooldownSeconds = clamp(finite(values.cooldownSeconds, 'Cooldown duration'), 10, 30);
    if (values.threshold !== undefined) next.threshold = pressureLevel(values.threshold, 'Cutoff');
    if (values.resetThreshold !== undefined) next.resetThreshold = pressureLevel(values.resetThreshold, 'Reset threshold');
    if (next.resetThreshold >= next.threshold) throw new RangeError('Reset threshold must be below the cutoff.');
    if (next.toy !== this.config.toy) {
      // Changing devices never carries a second-channel request into a newly
      // selected toy. Dual-channel output requires an explicit Opossum command.
      this.guestPercentA = this.guestPercent;
      this.guestPercentB = 0;
    }
    this.config = next;
    if (next.toy === 'vacuglide') this.pattern = 'steady';
    // Editing the duration never shortens an already-running cooldown.
    this.tick();
    this._emit('state');
    return this.snapshot();
  }

  updatePressure(kpa, at = this.now()) {
    const clock = this.now();
    // Do not let delayed or future-dated packets refresh the sensor watchdog.
    if (!Number.isFinite(at) || at > clock || (this.pressureAt !== null && at < this.pressureAt)) return this.snapshot();
    if (typeof kpa !== 'number' || !Number.isFinite(kpa) || kpa < -327.68 || kpa > 327.67) {
      if (ACTIVE.has(this.phase)) this.fault('Invalid pressure reading.');
      return this.snapshot();
    }
    const gap = this.pressureAt !== null && at - this.pressureAt > SENSOR_FRESH_MS;
    this.pressure = kpa;
    this.pressureAt = at;
    // A newly arriving packet must not disguise a long interruption, including
    // the first callback delivered after a suspended browser tab resumes.
    if (gap && ACTIVE.has(this.phase)) this.fault('Pressure stream was interrupted. Resume explicitly after checking the connection.');
    this.tick(clock);
    this._emit('state');
    return this.snapshot();
  }

  start() {
    if (ACTIVE.has(this.phase)) return this.snapshot();
    this._generation += 1;
    this.edgeCount = 0;
    this._armed = false;
    this._pausedPhase = null;
    this._pausedCooldownMs = 0;
    this.cooldownEndsAt = null;
    this._lastTickAt = this.now();
    this.reason = '';
    this.phase = 'settling';
    this._output(0, true);
    if (this.phase === 'fault') return this.snapshot();
    if (!this._fresh(this.now())) return this.fault('Fresh pressure data is required before starting.');
    this._settle(this.now());
    this._emit('state');
    return this.snapshot();
  }

  pause(reason = 'Paused by host.') {
    if (!ACTIVE.has(this.phase)) return this.snapshot();
    this._generation += 1;
    this._pausedPhase = this.phase;
    this._pausedCooldownMs = this.phase === 'cooldown' ? Math.max(0, this.cooldownEndsAt - this.now()) : 0;
    this.phase = 'paused';
    this.reason = String(reason);
    this._armed = false;
    this._output(0, true);
    this._emit('state');
    return this.snapshot();
  }

  resume() {
    // Fault recovery is deliberately an explicit host action; sensor recovery
    // or guest commands never take this path automatically.
    if (!['paused', 'fault'].includes(this.phase)) return this.snapshot();
    if (!this._fresh(this.now())) return this.fault('Fresh pressure data is required before resuming.');
    if (this.pressure >= this.config.resetThreshold) {
      if (this.phase === 'fault') {
        this.reason = 'Wait for pressure below the reset level, then resume explicitly.';
        this._emit('state');
        return this.snapshot();
      }
    }
    const wasFault = this.phase === 'fault';
    this._generation += 1;
    this._lastTickAt = this.now();
    this._armed = false;
    this.reason = '';
    this.phase = 'settling';
    this._output(0, true);
    if (this.phase === 'fault') return this.snapshot();
    if (!wasFault && this._pausedPhase === 'cooldown' && this._pausedCooldownMs > 0) {
      this.phase = 'cooldown';
      this.cooldownEndsAt = this.now() + this._pausedCooldownMs;
    } else {
      this.cooldownEndsAt = null;
      this._settle(this.now());
    }
    this._pausedPhase = null;
    this._pausedCooldownMs = 0;
    this._emit('state');
    return this.snapshot();
  }

  stop() {
    this._generation += 1;
    this.phase = 'stopped';
    this.reason = 'Stopped by host.';
    this._armed = false;
    this.cooldownEndsAt = null;
    this._pausedPhase = null;
    this._pausedCooldownMs = 0;
    this._output(0, true);
    this._emit('state');
    return this.snapshot();
  }

  fault(reason = 'Session interrupted. Check devices before resuming.') {
    if (this.phase === 'fault') return this.snapshot();
    this._generation += 1;
    this.phase = 'fault';
    this.reason = String(reason);
    this._armed = false;
    this.cooldownEndsAt = null;
    this._pausedPhase = null;
    this._pausedCooldownMs = 0;
    this._output(0, true);
    this._emit('state');
    return this.snapshot();
  }

  tick(at = this.now()) {
    finite(at, 'Time');
    if (!ACTIVE.has(this.phase)) return this.snapshot(at);
    if (this._lastTickAt !== null && at < this._lastTickAt) return this.fault('Clock changed. Resume explicitly after checking the session.');
    this._lastTickAt = at;
    if (!this._fresh(at)) return this.fault('Pressure data is stale. Check the Civet connection.');
    if (this.phase === 'running') {
      if (this._armed && this.pressure >= this.config.threshold) {
        this.edgeCount += 1;
        this._armed = false;
        this.phase = 'cooldown';
        this.reason = '';
        this.cooldownEndsAt = at + this.config.cooldownSeconds * 1000;
        this._output(0, true);
        this._emit('edge', at);
        this._emit('state', at);
      } else {
        this._output(this._requestedOutput(at));
      }
    } else if (this.phase === 'cooldown' && at >= this.cooldownEndsAt) {
      this.phase = 'settling';
      this._settle(at);
      this._emit('state', at);
    } else if (this.phase === 'settling') {
      this._settle(at);
    }
    return this.snapshot(at);
  }

  adjustCutoff(delta) {
    return this.setCutoff(this.config.threshold + finite(delta, 'Cutoff adjustment'));
  }

  setCutoff(value) {
    const threshold = pressureLevel(value, 'Cutoff');
    this.config.threshold = threshold;
    // Keep the calibrated reset level unless it would meet/cross the new cutoff.
    if (this.config.resetThreshold >= threshold) this.config.resetThreshold = tenth(threshold - 0.1);
    this.tick(); // A lower cutoff is effective immediately, not at the next UI tick.
    this._emit('state');
    return this.snapshot();
  }

  setGuestOutput({ percent, percentA, percentB, pattern, cooldownSeconds } = {}) {
    // Validate atomically so a malformed command does not partly alter a session.
    let nextPercent = percent === undefined ? this.guestPercent : clamp(finite(percent, 'Guest percentage'), 0, 100);
    const hasChannels = percentA !== undefined || percentB !== undefined;
    let nextA = this.guestPercentA, nextB = this.guestPercentB;
    if (this.config.toy === 'opossum') {
      if (hasChannels) {
        if (percentA !== undefined) nextA = clamp(finite(percentA, 'Channel A percentage'), 0, 100);
        if (percentB !== undefined) nextB = clamp(finite(percentB, 'Channel B percentage'), 0, 100);
      } else if (percent !== undefined) {
        // Older scalar controllers can never unexpectedly enable channel B.
        nextA = nextPercent;
        nextB = 0;
      }
      nextPercent = Math.max(nextA, nextB);
    } else {
      if (hasChannels) throw new TypeError('Separate channels are supported only for Opossum.');
      nextA = nextPercent;
      nextB = 0;
    }
    const nextPattern = pattern === undefined ? this.pattern : pattern;
    if (!PATTERNS.has(nextPattern)) throw new TypeError('Unsupported pattern.');
    const nextCooldown = cooldownSeconds === undefined ? this.config.cooldownSeconds : clamp(finite(cooldownSeconds, 'Cooldown duration'), 10, 30);
    this.guestPercent = nextPercent;
    this.guestPercentA = nextA;
    this.guestPercentB = nextB;
    this.pattern = this.config.toy === 'vacuglide' ? 'steady' : nextPattern;
    this.config.cooldownSeconds = nextCooldown;
    this.tick();
    this._emit('state');
    return this.snapshot();
  }

  snapshot(at = this.now()) {
    const remaining = this.phase === 'paused' ? this._pausedCooldownMs / 1000
      : this.cooldownEndsAt === null ? 0 : Math.max(0, (this.cooldownEndsAt - at) / 1000);
    return {
      ...this.config,
      phase: this.phase, pressure: this.pressure, pressureAt: this.pressureAt,
      sensorFresh: this._fresh(at), edgeCount: this.edgeCount, outputPercent: this.outputPercent,
      outputPercentA: this.outputPercentA, outputPercentB: this.outputPercentB,
      remainingCooldown: remaining, cooldownEndsAt: this.cooldownEndsAt,
      guestPercent: this.guestPercent, pattern: this.pattern, reason: this.reason,
      guestPercentA: this.guestPercentA, guestPercentB: this.guestPercentB,
      simulation: this.simulation,
    };
  }

  _fresh(at) {
    return this.pressure !== null && this.pressureAt !== null && at >= this.pressureAt && at - this.pressureAt <= SENSOR_FRESH_MS;
  }

  _settle(at) {
    const afterCooldown = this.cooldownEndsAt === null || this.pressureAt >= this.cooldownEndsAt;
    if (this._fresh(at) && afterCooldown && this.pressure < this.config.resetThreshold) {
      this.phase = 'running';
      this.reason = '';
      this.cooldownEndsAt = null;
      this._cycleStartedAt = at;
      this._armed = true;
      this._output(this._requestedOutput(at));
      this._emit('state', at);
    } else {
      this.reason = afterCooldown ? 'Waiting for pressure below the reset level.' : 'Waiting for a fresh pressure sample after cooldown.';
      this._output(0);
    }
  }

  _requestedOutput(at) {
    const elapsed = Math.max(0, at - this._cycleStartedAt);
    if (this.config.mode === 'solo') {
      const fraction = this.config.rampSeconds === 0 ? 1 : clamp(elapsed / (this.config.rampSeconds * 1000), 0, 1);
      const rampPercent = this.config.startPercent + (100 - this.config.startPercent) * fraction;
      if (this.config.toy === 'opossum') {
        return { a: this.config.maxPercentA * rampPercent / 100, b: this.config.maxPercentB * rampPercent / 100 };
      }
      return rampPercent;
    }
    let multiplier = 1;
    if (this.config.toy !== 'vacuglide' && this.pattern === 'pulse') multiplier = elapsed % 2000 < 1000 ? 1 : 0;
    else if (this.config.toy !== 'vacuglide' && this.pattern === 'wave') multiplier = (1 - Math.cos(2 * Math.PI * (elapsed % 4000) / 4000)) / 2;
    if (this.config.toy === 'opossum') return { a: this.guestPercentA * multiplier, b: this.guestPercentB * multiplier };
    return clamp(this.guestPercent, 0, 100) * multiplier;
  }

  _output(percentOrChannels, force = false) {
    const normalize = value => tenth(clamp(Number.isFinite(value) ? value : 0, 0, 100));
    const channels = typeof percentOrChannels === 'object' && percentOrChannels !== null ? percentOrChannels : { a: percentOrChannels, b: 0 };
    const a = normalize(channels.a);
    const b = this.config.toy === 'opossum' ? normalize(channels.b) : 0;
    const value = Math.max(a, b);
    if (!force && a === this.outputPercentA && b === this.outputPercentB) return;
    this.outputPercent = value;
    this.outputPercentA = a;
    this.outputPercentB = b;
    const generation = this._generation;
    const failed = error => {
      if (generation !== this._generation) return;
      if (this.phase === 'fault') {
        this.reason = 'Stop could not be confirmed. Use the physical device controls.';
        this._emit('state');
      } else {
        this.fault(`Device command failed: ${error?.message || 'unknown error'}`);
      }
    };
    try {
      const result = this.onOutput(value, { a, b });
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  _emit(type, at = this.now()) {
    // UI/telemetry failures must never prevent a stop or corrupt the state machine.
    try { this.onEvent({ type, snapshot: this.snapshot(at) }); } catch { /* observer only */ }
  }
}
