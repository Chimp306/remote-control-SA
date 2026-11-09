/**
 * Data-driven output shapes. Each sample(elapsedMs) returns channel levels in
 * 0..1. Opossum patterns keep A and B apart. Add a pattern by appending an
 * object; Random and the include checkboxes pick up the id automatically.
 */

const clamp01 = (value) => Math.max(0, Math.min(1, value));

function frac(elapsed, period) {
  return ((elapsed % period) + period) % period / period;
}

/** Same shape as the previous chase: a bump on A, then the same bump on B. */
export function bump(t, center, width) {
  const x = ((t % 1) + 1) % 1;
  return Math.max(0, 1 - Math.abs(x - center) / width);
}

function sine(t, phase = 0) {
  const x = ((t + phase) % 1 + 1) % 1;
  return (1 - Math.cos(2 * Math.PI * x)) / 2;
}

function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function pair(a, b) {
  return { a: clamp01(a), b: clamp01(b) };
}

export const OPOSSUM_PATTERNS = [
  {
    id: 'chase',
    label: 'Chase',
    sample(elapsed) {
      const t = frac(elapsed, 4000);
      return pair(bump(t, 0.25, 0.28), bump(t, 0.75, 0.28));
    },
  },
  {
    id: 'alternate',
    label: 'Alternate',
    sample(elapsed) {
      const t = frac(elapsed, 4000);
      return pair(sine(t, 0), sine(t, 0.5));
    },
  },
  {
    id: 'ping-pong',
    label: 'Ping-pong',
    sample(elapsed) {
      const wave = sine(frac(elapsed, 3600), 0);
      return pair(wave, 1 - wave);
    },
  },
  {
    id: 'seesaw',
    label: 'Seesaw',
    sample(elapsed) {
      const t = frac(elapsed, 5000);
      const up = t < 0.5 ? t * 2 : (1 - t) * 2;
      return pair(up, 1 - up);
    },
  },
  {
    id: 'relay',
    label: 'Relay',
    sample(elapsed) {
      const t = frac(elapsed, 4000);
      const a = t < 0.42 ? 1 : t < 0.55 ? 1 - (t - 0.42) / 0.13 : 0;
      const b = t < 0.45 ? 0 : t < 0.58 ? (t - 0.45) / 0.13 : 1;
      return pair(a, b);
    },
  },
  {
    id: 'echo',
    label: 'Echo',
    sample(elapsed) {
      const t = frac(elapsed, 3200);
      return pair(bump(t, 0.18, 0.12), bump(t, 0.46, 0.12));
    },
  },
  {
    id: 'heartbeat-drone',
    label: 'Heartbeat & drone',
    sample(elapsed) {
      const t = frac(elapsed, 2800);
      const beat = Math.max(bump(t, 0.16, 0.07), bump(t, 0.30, 0.09));
      const drone = 0.22 + 0.08 * sine(frac(elapsed, 9000), 0.2);
      return pair(beat, drone);
    },
  },
  {
    id: 'gallop',
    label: 'Gallop',
    sample(elapsed) {
      const t = frac(elapsed, 1800);
      const hits = (shift) => Math.max(
        bump(t, 0.12 + shift, 0.06),
        bump(t, 0.24 + shift, 0.06),
        bump(t, 0.40 + shift, 0.08),
      );
      return pair(hits(0), hits(0.42));
    },
  },
  {
    id: 'off-beat',
    label: 'Off-beat',
    sample(elapsed) {
      const t = frac(elapsed, 2000);
      const on = t < 0.18 || (t > 0.5 && t < 0.68) ? 1 : 0.08;
      const off = (t > 0.25 && t < 0.43) || t > 0.75 ? 1 : 0.08;
      return pair(on, off);
    },
  },
  {
    id: 'polyrhythm',
    label: 'Polyrhythm',
    sample(elapsed) {
      return pair(sine(frac(elapsed, 2400), 0), sine(frac(elapsed, 4000), 0.15));
    },
  },
  {
    id: 'drift',
    label: 'Drift',
    sample(elapsed) {
      const s = elapsed / 1000;
      const a = 0.5 + 0.28 * Math.sin(s * 0.37) + 0.16 * Math.sin(s * 0.91 + 0.6);
      const b = 0.48 + 0.26 * Math.sin(s * 0.23 + 2) + 0.18 * Math.sin(s * 0.67);
      return pair(a, b);
    },
  },
  {
    id: 'tide',
    label: 'Tide',
    sample(elapsed) {
      return pair(sine(frac(elapsed, 12000), 0), sine(frac(elapsed, 12000), 0.35));
    },
  },
  {
    id: 'staircase',
    label: 'Staircase',
    sample(elapsed) {
      const seq = [0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25];
      const t = frac(elapsed, 6400);
      const i = Math.min(seq.length - 1, Math.floor(t * seq.length));
      return pair(seq[i], seq[(i + 2) % seq.length]);
    },
  },
  {
    id: 'climb',
    label: 'Climb',
    sample(elapsed) {
      const t = frac(elapsed, 5000);
      const rise = t < 0.8 ? t / 0.8 : 1 - (t - 0.8) / 0.2;
      const lag = frac(elapsed + 700, 5000);
      const riseB = lag < 0.8 ? lag / 0.8 : 1 - (lag - 0.8) / 0.2;
      return pair(rise, riseB * 0.82);
    },
  },
  {
    id: 'surge',
    label: 'Surge',
    sample(elapsed) {
      const t = frac(elapsed, 4500);
      const a = t < 0.62 ? t / 0.62 * 0.55 : t < 0.8 ? 0.55 + (t - 0.62) / 0.18 * 0.45 : 1 - (t - 0.8) / 0.2;
      const b = t < 0.72 ? t / 0.72 * 0.35 : t < 0.9 ? 0.35 + (t - 0.72) / 0.18 * 0.65 : 1 - (t - 0.9) / 0.1;
      return pair(a, b);
    },
  },
  {
    id: 'breathing',
    label: 'Breathing',
    sample(elapsed) {
      const a = sine(frac(elapsed, 8000), 0);
      const b = 0.15 + 0.7 * sine(frac(elapsed, 8000), 0.22);
      return pair(a, b);
    },
  },
  {
    id: 'flutter',
    label: 'Flutter',
    sample(elapsed) {
      const a = 0.45 + 0.4 * Math.sin(elapsed / 70);
      const b = 0.3 + 0.25 * Math.sin(elapsed / 160 + 1);
      return pair(a, b);
    },
  },
  {
    id: 'rain',
    label: 'Rain',
    sample(elapsed) {
      const bucket = Math.floor(elapsed / 180);
      const drop = (seed) => {
        const h = hash(bucket * 13 + seed);
        return h > 0.78 ? 0.25 + (h - 0.78) * 3.2 : 0.05;
      };
      return pair(drop(2), drop(80));
    },
  },
  {
    id: 'ripple',
    label: 'Ripple',
    sample(elapsed) {
      const t = frac(elapsed, 3600);
      const ring = (center) => {
        const d = Math.abs(t - center);
        return d < 0.22 ? (1 - d / 0.22) * Math.exp(-d * 6) : 0;
      };
      return pair(ring(0.2) + 0.5 * ring(0.55), ring(0.38) + 0.5 * ring(0.72));
    },
  },
  {
    id: 'buzz-thump',
    label: 'Buzz & thump',
    sample(elapsed) {
      const buzz = 0.62 + 0.28 * Math.sin(elapsed / 45);
      const t = frac(elapsed, 2400);
      const thump = Math.max(bump(t, 0.12, 0.07), bump(t, 0.7, 0.08));
      return pair(buzz, thump);
    },
  },
  {
    id: 'static',
    label: 'Static',
    sample() {
      return pair(0.82, 0.46);
    },
  },
  {
    id: 'mixed-tease',
    label: 'Mixed tease',
    sample(elapsed) {
      const slow = sine(frac(elapsed, 7000), 0);
      const fastA = 0.55 + 0.4 * Math.sin(elapsed / 90);
      const fastB = 0.2 + 0.35 * Math.sin(elapsed / 150 + 1.3);
      return pair(slow * 0.7 + fastA * 0.3, (1 - slow) * 0.45 + fastB);
    },
  },
];

export const LUSH_PATTERNS = [
  { id: 'steady', label: 'Steady', sample: () => pair(1, 0) },
  {
    id: 'pulse',
    label: 'Pulse',
    sample: (elapsed) => pair(frac(elapsed, 1600) < 0.45 ? 1 : 0, 0),
  },
  {
    id: 'wave',
    label: 'Wave',
    sample: (elapsed) => pair(sine(frac(elapsed, 4000), 0), 0),
  },
  {
    id: 'heartbeat',
    label: 'Heartbeat',
    sample(elapsed) {
      const t = frac(elapsed, 2600);
      return pair(Math.max(bump(t, 0.16, 0.07), bump(t, 0.3, 0.09)), 0);
    },
  },
  {
    id: 'ramp',
    label: 'Ramp',
    sample(elapsed) {
      const t = frac(elapsed, 5000);
      return pair(t < 0.82 ? t / 0.82 : 1 - (t - 0.82) / 0.18, 0);
    },
  },
  {
    id: 'flutter',
    label: 'Flutter',
    sample: (elapsed) => pair(0.5 + 0.4 * Math.sin(elapsed / 70), 0),
  },
  {
    id: 'stairs',
    label: 'Stairs',
    sample(elapsed) {
      const seq = [0.2, 0.4, 0.6, 0.85, 1, 0.7, 0.45];
      const t = frac(elapsed, 5600);
      return pair(seq[Math.min(seq.length - 1, Math.floor(t * seq.length))], 0);
    },
  },
  {
    id: 'breathe',
    label: 'Breathe',
    sample: (elapsed) => pair(sine(frac(elapsed, 8000), 0), 0),
  },
  {
    id: 'rain',
    label: 'Rain',
    sample(elapsed) {
      const h = hash(Math.floor(elapsed / 180) * 13 + 4);
      return pair(h > 0.75 ? 0.3 + (h - 0.75) * 2.6 : 0.06, 0);
    },
  },
  {
    id: 'tease',
    label: 'Tease',
    sample(elapsed) {
      const t = frac(elapsed, 6000);
      const level = t < 0.7 ? t / 0.7 * 0.9 : 0.9 - (t - 0.7) / 0.3 * 0.75;
      return pair(level, 0);
    },
  },
  {
    id: 'buzz',
    label: 'Buzz',
    sample: (elapsed) => pair(0.7 + 0.25 * Math.sin(elapsed / 40), 0),
  },
];

export function patternsFor(toy) {
  return toy === 'lush' ? LUSH_PATTERNS : OPOSSUM_PATTERNS;
}

export function patternById(toy, id) {
  return patternsFor(toy).find((pattern) => pattern.id === id) || patternsFor(toy)[0];
}

/** True when the level travels in the first moment of play, not only after a long hold. */
export function patternMoves(toy, id) {
  const pattern = patternById(toy, id);
  let minA = Infinity;
  let maxA = -Infinity;
  let minB = Infinity;
  let maxB = -Infinity;
  for (let elapsed = 0; elapsed <= 1500; elapsed += 50) {
    const sample = pattern.sample(elapsed);
    minA = Math.min(minA, sample.a);
    maxA = Math.max(maxA, sample.a);
    minB = Math.min(minB, sample.b);
    maxB = Math.max(maxB, sample.b);
  }
  const travel = toy === 'lush' ? maxA - minA : Math.max(maxA - minA, maxB - minB);
  return travel >= 0.25;
}
