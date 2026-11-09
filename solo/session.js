/**
 * Play/rest state. No timers and no hardware: the page calls tick() from the
 * worker clock and notePressure() the moment a Civet sample arrives.
 * `now` is always supplied by the caller so tests can step the clock.
 */

import { patternById, patternMoves, patternsFor } from './patterns.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function formatClock(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

function randomSeconds(min, max, random) {
  const lo = clamp(Math.round(Math.min(min, max)), 1, 600);
  const hi = clamp(Math.round(Math.max(min, max)), lo, 600);
  return lo + Math.floor(random() * (hi - lo + 1));
}

export function createSession(random = Math.random) {
  const cfg = {
    toy: 'opossum',
    civet: true,
    cutoff: 20.42,
    restMin: 10,
    restMax: 30,
    mode: 'random',
    include: null,
    power: 72,
  };
  const live = {
    running: false,
    phase: 'idle',
    edges: 0,
    elapsed: 0,
    anchor: 0,
    restUntil: 0,
    patternTime: 0,
    patternAnchor: 0,
    pressure: null,
    armed: true,
    fault: '',
    activeId: null,
    channels: { a: 0, b: 0 },
    expectPulse: false,
    tripped: false,
  };

  function pool() {
    const all = patternsFor(cfg.toy).map((pattern) => pattern.id);
    if (!Array.isArray(cfg.include)) return all;
    const chosen = all.filter((id) => cfg.include.includes(id));
    return chosen.length ? chosen : all;
  }

  function pickFrom(list, exclude) {
    const options = exclude ? list.filter((id) => id !== exclude) : list;
    const choices = options.length ? options : list;
    const index = Math.min(choices.length - 1, Math.floor(random() * choices.length));
    return choices[index];
  }

  function pick(exclude) {
    return pickFrom(pool(), exclude);
  }

  function pickMoving(exclude) {
    const moving = pool().filter((id) => patternMoves(cfg.toy, id));
    return pickFrom(moving.length ? moving : pool(), exclude);
  }

  function freeze(now) {
    if (live.running) {
      live.elapsed += Math.max(0, now - live.anchor);
      live.anchor = now;
    }
    if (live.phase === 'playing') {
      live.patternTime += Math.max(0, now - live.patternAnchor);
      live.patternAnchor = now;
    }
  }

  function levelsAt(elapsed) {
    if (live.phase !== 'playing') return { a: 0, b: 0 };
    if (cfg.toy === 'vacuglide') return { a: clamp(cfg.power, 0, 100), b: 0 };
    const pattern = patternById(cfg.toy, live.activeId);
    const sample = pattern.sample(elapsed);
    const power = clamp(cfg.power, 0, 100);
    if (cfg.toy === 'lush') return { a: clamp(sample.a * power, 0, 100), b: 0 };
    return {
      a: clamp(sample.a * power, 0, 100),
      b: clamp(sample.b * power, 0, 100),
    };
  }

  function duration(now) {
    if (!live.running) return live.elapsed;
    return live.elapsed + Math.max(0, now - live.anchor);
  }

  function patternElapsed(now) {
    if (live.phase !== 'playing') return live.patternTime;
    return live.patternTime + Math.max(0, now - live.patternAnchor);
  }

  function publish(now) {
    const resting = live.phase === 'resting';
    const pattern = patternById(cfg.toy, live.activeId || patternsFor(cfg.toy)[0].id);
    return {
      running: live.running,
      phase: live.phase,
      edges: live.edges,
      durationMs: duration(now),
      restRemainingMs: resting ? Math.max(0, live.restUntil - now) : 0,
      pressure: live.pressure,
      armed: live.armed,
      fault: live.fault,
      tripped: live.tripped,
      activePatternId: live.activeId,
      activePatternLabel: pattern.label,
      mode: cfg.mode,
      channels: { ...live.channels },
      expectPulse: live.expectPulse,
      toy: cfg.toy,
    };
  }

  function trip(now) {
    freeze(now);
    live.edges += 1;
    live.armed = false;
    live.phase = 'resting';
    live.channels = { a: 0, b: 0 };
    live.expectPulse = false;
    live.tripped = true;
    const seconds = randomSeconds(cfg.restMin, cfg.restMax, random);
    live.restUntil = now + seconds * 1000;
    if (cfg.mode === 'random') {
      live.activeId = pick(live.activeId);
      live.patternTime = 0;
      live.patternAnchor = now;
    }
  }

  return {
    configure(patch = {}, now = live.anchor) {
      Object.assign(cfg, patch);
      if (patch.include) cfg.include = patch.include.slice();
      if (cfg.toy === 'vacuglide') {
        live.activeId = null;
        return;
      }
      if (patch.mode && patch.mode !== 'random') {
        live.activeId = patch.mode;
        live.patternTime = 0;
        live.patternAnchor = now;
      }
      if (cfg.mode === 'random' && live.activeId && !pool().includes(live.activeId)) {
        live.activeId = pick(live.activeId);
        live.patternTime = 0;
        live.patternAnchor = now;
      }
    },

    start(now) {
      if (live.running) return publish(now);
      live.fault = '';
      live.tripped = false;
      live.running = true;
      live.phase = 'playing';
      live.anchor = now;
      live.patternAnchor = now;
      live.expectPulse = false;
      if (cfg.toy !== 'vacuglide') {
        if (cfg.mode === 'random') live.activeId = pickMoving(live.activeId);
        else live.activeId = cfg.mode;
      }
      const cutoff = Number(cfg.cutoff);
      live.armed = !(cfg.civet && Number.isFinite(cutoff) && Number.isFinite(live.pressure) && live.pressure >= cutoff);
      live.channels = levelsAt(0);
      return publish(now);
    },

    stop(now) {
      freeze(now);
      live.running = false;
      live.phase = 'idle';
      live.restUntil = 0;
      live.channels = { a: 0, b: 0 };
      live.expectPulse = false;
      live.tripped = false;
      return publish(now);
    },

    resetTimer() {
      if (live.running) return;
      live.elapsed = 0;
    },

    notePressure(kpa, now) {
      live.tripped = false;
      if (!Number.isFinite(kpa)) return publish(now);
      live.pressure = kpa;
      const cutoff = Number(cfg.cutoff);
      const canTrip = cfg.civet && Number.isFinite(cutoff);
      const wasArmed = live.armed;
      if (!canTrip || kpa < cutoff) live.armed = true;
      if (canTrip && live.phase === 'playing' && wasArmed && kpa >= cutoff) trip(now);
      return publish(now);
    },

    tick(now, gap = 0) {
      live.tripped = false;
      if (!live.running) return publish(now);
      if (live.phase === 'resting' && now >= live.restUntil) {
        live.phase = 'playing';
        live.patternAnchor = now;
        live.expectPulse = false;
      }
      if (live.phase === 'playing') {
        const levels = levelsAt(patternElapsed(now));
        const pulsing = cfg.toy === 'opossum' && (levels.a > 0 || levels.b > 0);
        if (pulsing && live.expectPulse && gap > 500) {
          freeze(now);
          live.running = false;
          live.phase = 'idle';
          live.channels = { a: 0, b: 0 };
          live.expectPulse = false;
          live.fault = 'Opossum pulse gap exceeded 500 ms. Output cut.';
          return publish(now);
        }
        live.channels = levels;
        live.expectPulse = pulsing;
      } else {
        live.channels = { a: 0, b: 0 };
        live.expectPulse = false;
      }
      return publish(now);
    },
  };
}
