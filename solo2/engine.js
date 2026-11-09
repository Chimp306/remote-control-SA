import {choosePattern, patternsFor, samplePattern} from './patterns.js';

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const active = (state) => ['running', 'resting', 'waiting'].includes(state);
const number = (value, fallback) => Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : fallback;

/** Pure state machine. No DOM, hardware, storage or timers. Timestamps are milliseconds. */
export class SessionEngine {
  constructor({random = Math.random, now = () => Date.now()} = {}) {
    this.random = random;
    this.now = now;
    this.config = {toy: 'opossum', civetEnabled: true, cutoff: 20.5, restMin: 10, restMax: 30, maxPower: 50, pattern: 'random', includes: null};
    this.state = 'idle';
    this.reason = '';
    this.edges = 0;
    this.startedAt = null;
    this.elapsedMs = 0;
    this.restUntil = 0;
    this.restTotalMs = 0;
    this.patternId = null;
    this.patternStartedAt = 0;
    this.lastPressure = null;
    this.lastPressureAt = null;
    this.lastTickAt = null;
    this.output = {a: 0, b: 0};
  }

  configure(patch = {}, now = this.now()) {
    this.checkHealth(now);
    const previous = this.config;
    const next = {...previous, ...patch};
    next.toy = ['opossum', 'lush', 'vacuglide'].includes(next.toy) ? next.toy : 'opossum';
    next.civetEnabled = Boolean(next.civetEnabled);
    next.cutoff = number(next.cutoff, previous.cutoff);
    next.restMin = clamp(Math.round(number(next.restMin, previous.restMin)), 1, 3600);
    next.restMax = clamp(Math.round(number(next.restMax, previous.restMax)), 1, 3600);
    if (next.restMin > next.restMax) [next.restMin, next.restMax] = [next.restMax, next.restMin];
    next.maxPower = clamp(number(next.maxPower, 0), 0, 100);
    next.includes = Array.isArray(next.includes) ? [...next.includes] : null;
    this.config = next;
    // Device/sensor changes cannot carry a running session into a different setup.
    if (active(this.state) && (previous.toy !== next.toy || previous.civetEnabled !== next.civetEnabled)) {
      return this.stop('Setup changed. Press Start when ready.', now);
    }
    if (next.toy !== 'vacuglide') {
      const valid = patternsFor(next.toy).map(p => p.id);
      if (next.pattern !== 'random' && !valid.includes(next.pattern)) {
        if (active(this.state)) return this.fault('Choose a valid pattern.', now);
        this.patternId = null;
      } else if (next.pattern !== 'random') {
        if (this.patternId !== next.pattern) this.patternStartedAt = now;
        this.patternId = next.pattern;
      } else if (active(this.state) && (!this.patternId || (next.includes && !next.includes.includes(this.patternId)))) {
        this.patternId = choosePattern(next.toy, next.includes, this.patternId, this.random);
        this.patternStartedAt = now;
        if (!this.patternId) return this.fault('Select at least one pattern for Random.', now);
      }
    } else this.patternId = 'steady';
    if (this.state === 'running' && this.config.civetEnabled && this.lastPressure >= this.config.cutoff) this.trip(now);
    this.updateOutput(now);
    return this.snapshot(now);
  }

  start(now = this.now()) {
    if (active(this.state)) return this.snapshot(now);
    this.reason = '';
    if (this.config.civetEnabled && (this.lastPressureAt === null || now - this.lastPressureAt > 1500)) {
      return this.fault('Waiting for a fresh Civet reading. Check the sensor, then Start.', now);
    }
    this.patternId = this.config.toy === 'vacuglide' ? 'steady' : this.config.pattern === 'random'
      ? choosePattern(this.config.toy, this.config.includes, this.patternId, this.random)
      : patternsFor(this.config.toy).find(p => p.id === this.config.pattern)?.id;
    if (!this.patternId) return this.fault('Select at least one valid pattern.', now);
    this.edges = 0;
    this.elapsedMs = 0;
    this.startedAt = now;
    this.patternStartedAt = now;
    this.restUntil = 0;
    this.restTotalMs = 0;
    this.lastTickAt = now;
    this.state = this.config.civetEnabled && this.lastPressure >= this.config.cutoff ? 'waiting' : 'running';
    if (this.state === 'waiting') this.reason = 'Release below the cutoff to begin.';
    this.updateOutput(now);
    return this.snapshot(now);
  }

  stop(reason = '', now = this.now()) {
    this.freezeElapsed(now);
    this.state = 'idle';
    this.reason = reason;
    this.restUntil = 0;
    this.restTotalMs = 0;
    this.output = {a: 0, b: 0};
    return this.snapshot(now);
  }

  fault(reason = 'Output stopped. Check the connection, then Start.', now = this.now()) {
    this.freezeElapsed(now);
    this.state = 'fault';
    this.reason = reason;
    this.restUntil = 0;
    this.restTotalMs = 0;
    this.output = {a: 0, b: 0};
    return this.snapshot(now);
  }

  pressure(kpa, now = this.now(), sampledAt = now) {
    if (!Number.isFinite(kpa) || !Number.isFinite(sampledAt)) return this.snapshot(now);
    this.checkHealth(now);
    // Receipt time drives the session; capture time determines sensor freshness.
    // Queued notifications must not renew a sensor lease or roll values backward.
    if (sampledAt > now || now - sampledAt > 1500 || (this.lastPressureAt !== null && sampledAt < this.lastPressureAt)) return this.snapshot(now);
    this.lastPressure = kpa;
    this.lastPressureAt = sampledAt;
    if (this.config.civetEnabled && this.state === 'running' && kpa >= this.config.cutoff) this.trip(now);
    else if (this.state === 'waiting' && (!this.config.civetEnabled || kpa < this.config.cutoff)) {
      this.state = 'running';
      this.reason = '';
      this.patternStartedAt = now;
      this.lastTickAt = now;
    }
    this.updateOutput(now);
    return this.snapshot(now);
  }

  tick(now = this.now()) {
    this.checkHealth(now);
    if (active(this.state)) {
      if (this.state === 'resting' && now >= this.restUntil) {
        const held = this.config.civetEnabled && this.lastPressure >= this.config.cutoff;
        this.state = held ? 'waiting' : 'running';
        this.reason = held ? 'Rest complete. Release below the cutoff to resume.' : '';
        this.patternStartedAt = now;
      }
      this.lastTickAt = now;
    }
    this.updateOutput(now);
    return this.snapshot(now);
  }

  checkHealth(now) {
    if (!active(this.state)) return;
    if (this.config.civetEnabled && (this.lastPressureAt === null || now - this.lastPressureAt > 1500)) {
      this.fault('Civet readings stopped. Output is zero; reconnect the sensor and Start again.', now);
    } else if (this.config.toy === 'opossum' && this.state === 'running' && this.lastTickAt !== null && now - this.lastTickAt > 500) {
      this.fault('Control heartbeat exceeded 500 ms. Output stopped; press Start to retry.', now);
    }
  }

  trip(now) {
    this.edges += 1;
    this.state = 'resting';
    this.reason = '';
    const {restMin, restMax} = this.config;
    const random = clamp(number(this.random(), 0), 0, .999999999);
    this.restTotalMs = (restMin + Math.floor(random * (restMax - restMin + 1))) * 1000;
    this.restUntil = now + this.restTotalMs;
    this.output = {a: 0, b: 0};
    if (this.config.pattern === 'random' && this.config.toy !== 'vacuglide') {
      this.patternId = choosePattern(this.config.toy, this.config.includes, this.patternId, this.random);
      if (!this.patternId) this.fault('Select at least one pattern for Random.', now);
    }
  }

  updateOutput(now) {
    if (this.state !== 'running') { this.output = {a: 0, b: 0}; return; }
    const sample = samplePattern(this.config.toy, this.patternId, (now - this.patternStartedAt) / 1000);
    const power = this.config.maxPower / 100;
    this.output = {a: sample.a * power, b: sample.b * power};
  }

  freezeElapsed(now) {
    if (active(this.state) && this.startedAt !== null) this.elapsedMs = Math.max(0, now - this.startedAt);
    this.startedAt = null;
  }

  snapshot(now = this.now()) {
    return {
      state: this.state,
      elapsedMs: active(this.state) && this.startedAt !== null ? Math.max(0, now - this.startedAt) : this.elapsedMs,
      edges: this.edges,
      restRemainingMs: this.state === 'resting' ? Math.max(0, this.restUntil - now) : 0,
      restTotalMs: this.restTotalMs,
      patternId: this.patternId,
      output: {...this.output},
      pressure: this.lastPressure,
      reason: this.reason,
    };
  }
}
