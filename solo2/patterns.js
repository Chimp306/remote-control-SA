/**
 * Pattern catalogue. Time is seconds; samples are normalized percentages.
 * Add one recipe to a catalogue and it appears in the picker and Random pool.
 * These are envelopes only: native device limits are applied by the adapter.
 */
const clamp = (n) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
const phase = (t, period, offset = 0) => ((t / period + offset) % 1 + 1) % 1;
const wave = (t, period, offset = 0) => (1 - Math.cos(phase(t, period, offset) * Math.PI * 2)) / 2;
const triangle = (t, period, offset = 0) => 1 - Math.abs(phase(t, period, offset) * 2 - 1);
const pulse = (t, period, duty = .35, offset = 0) => phase(t, period, offset) < duty ? 1 : 0;
const bump = (p, center, width) => Math.max(0, 1 - Math.abs(p - center) / width);
const hash = (n) => { const v = Math.sin(n * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };
const pair = (a, b = 0) => ({a: clamp(a) * 100, b: clamp(b) * 100});
const recipe = (id, name, description, sample) => Object.freeze({id, name, description, sample});
const beat = (p) => Math.max(bump(p, .16, .075), bump(p, .32, .09) * .8);
const ramp = (p) => p < .82 ? p / .82 : (1 - p) / .18;
const steps = [0.15, .35, .55, .8, 1, .8, .55, .35];

export const OPOSSUM_PATTERNS = Object.freeze([
  recipe('chase', 'Chase', 'A leads. B follows.', t => pair(bump(phase(t, 4), .25, .28), bump(phase(t, 4), .75, .28))),
  recipe('alternate', 'Alternate', 'Clean exchanges between channels.', t => pair(pulse(t, 4, .48), pulse(t, 4, .48, .5))),
  recipe('ping-pong', 'Ping-pong', 'Smooth, opposing waves.', t => pair(wave(t, 3.6), wave(t, 3.6, .5))),
  recipe('seesaw', 'Seesaw', 'One rises as the other falls.', t => pair(triangle(t, 5), triangle(t, 5, .5))),
  recipe('relay', 'Relay', 'Long holds with a soft handover.', t => {
    const p = phase(t, 4);
    return pair(p < .42 ? 1 : p < .57 ? (0.57 - p) / .15 : 0, p < .43 ? 0 : p < .58 ? (p - .43) / .15 : 1);
  }),
  recipe('echo', 'Echo', 'A clear pulse, then a softer reply.', t => pair(bump(phase(t, 3.2), .18, .12), .75 * bump(phase(t, 3.2), .46, .12))),
  recipe('heartbeat-drone', 'Heartbeat & drone', 'Double beats over a steady base.', t => pair(beat(phase(t, 2.8)), .22 + .08 * wave(t, 9, .2))),
  recipe('gallop', 'Gallop', 'Three quick beats, traded across channels.', t => {
    const hits = (p) => Math.max(bump(p, .1, .06), bump(p, .23, .06), bump(p, .4, .08));
    return pair(hits(phase(t, 1.8)), hits(phase(t, 1.8, .5)));
  }),
  recipe('off-beat', 'Off-beat', 'Syncopated pulses with space between.', t => pair(.08 + .92 * pulse(t, 1, .3), .08 + .92 * pulse(t, 1, .3, .5))),
  recipe('polyrhythm', 'Polyrhythm', 'Two rhythms, moving independently.', t => pair(wave(t, 2.4), wave(t, 4, .15))),
  recipe('drift', 'Drift', 'Unhurried, evolving levels.', t => pair(.5 + .28 * Math.sin(t * .37) + .16 * Math.sin(t * .91 + .6), .48 + .26 * Math.sin(t * .23 + 2) + .18 * Math.sin(t * .67))),
  recipe('tide', 'Tide', 'Slow waves with an offset return.', t => pair(wave(t, 12), wave(t, 12, .35))),
  recipe('staircase', 'Staircase', 'Measured steps up and down.', t => { const i = Math.floor(phase(t, 6.4) * 8); return pair(steps[i], steps[(i + 2) % 8]); }),
  recipe('climb', 'Climb', 'Gradual rises and short releases.', t => pair(ramp(phase(t, 5)), .82 * ramp(phase(t, 5, .14)))),
  recipe('surge', 'Surge', 'A slow build into a brief peak.', t => pair(Math.pow(wave(t, 4.5), 1.8), .9 * Math.pow(wave(t, 4.5, .15), 2.4))),
  recipe('breathing', 'Breathing', 'Broad, gentle changes.', t => pair(wave(t, 8), .15 + .7 * wave(t, 8, .22))),
  recipe('flutter', 'Flutter', 'Fast ripples at different rates.', t => pair(.45 + .4 * Math.sin(t * 14.2), .3 + .25 * Math.sin(t * 6.25 + 1))),
  recipe('rain', 'Rain', 'Scattered pulses, independently placed.', t => {
    const drop = (seed) => { const h = hash(Math.floor(t / .2) * 13 + seed); return h > .7 ? .25 + (h - .7) * 2.5 : .05; };
    return pair(drop(2), drop(80));
  }),
  recipe('ripple', 'Ripple', 'Small repeating waves that fade.', t => {
    const p = phase(t, 3.6), ring = (c) => Math.exp(-Math.abs(p - c) * 9) * bump(p, c, .22);
    return pair(ring(.2) + .5 * ring(.55), ring(.38) + .5 * ring(.72));
  }),
  recipe('buzz-thump', 'Buzz & thump', 'A quick texture against slower beats.', t => pair(.62 + .28 * Math.sin(t * 22.2), Math.max(bump(phase(t, 2.4), .12, .08), bump(phase(t, 2.4), .7, .09)))),
  recipe('static', 'Static', 'Two steady, deliberately different levels.', () => pair(.82, .46)),
  recipe('mixed-tease', 'Mixed tease', 'A changing blend of slow and quick.', t => pair(.7 * wave(t, 7) + .3 * (.55 + .4 * Math.sin(t * 11.1)), .45 * (1 - wave(t, 7)) + .2 + .35 * Math.sin(t * 6.67 + 1.3))),
]);

export const LUSH_PATTERNS = Object.freeze([
  recipe('steady', 'Steady', 'A continuous level.', () => pair(1)),
  recipe('pulse', 'Pulse', 'Evenly spaced on and off.', t => pair(pulse(t, 1.6, .45))),
  recipe('wave', 'Wave', 'A smooth four-second wave.', t => pair(wave(t, 4))),
  recipe('breathe', 'Breathe', 'A slower, wider wave.', t => pair(wave(t, 8))),
  recipe('heartbeat', 'Heartbeat', 'A repeating double beat.', t => pair(beat(phase(t, 2.6)))),
  recipe('ramp', 'Ramp', 'Build gradually, release quickly.', t => pair(ramp(phase(t, 5)))),
  recipe('steps', 'Steps', 'Stepped rises and falls.', t => pair(steps[Math.floor(phase(t, 6.4) * 8)])),
  recipe('flutter', 'Flutter', 'Small, quick variations.', t => pair(.5 + .4 * Math.sin(t * 14.2))),
  recipe('ripple', 'Ripple', 'Waves within a slower wave.', t => pair(.2 + .8 * wave(t, 6) * (.6 + .4 * wave(t, .8)))),
  recipe('drift', 'Drift', 'A slowly evolving rhythm.', t => pair(.5 + .3 * Math.sin(t * .5) + .15 * Math.sin(t * 1.2))),
  recipe('rain', 'Rain', 'A scattered sequence of short pulses.', t => { const h = hash(Math.floor(t / .3) * 13 + 4); return pair(h > .7 ? .3 + (h - .7) * 2.3 : .06); }),
  recipe('mixed', 'Mixed', 'Slow changes with a quicker texture.', t => pair(.7 * wave(t, 7) + .3 * (.55 + .4 * Math.sin(t * 9)))),
]);

export function patternsFor(toy) {
  return toy === 'lush' ? LUSH_PATTERNS : toy === 'opossum' ? OPOSSUM_PATTERNS : [];
}

export function samplePattern(toy, id, elapsedSeconds = 0) {
  if (toy === 'vacuglide') return {a: 100, b: 0};
  const pattern = patternsFor(toy).find(p => p.id === id);
  if (!pattern) return {a: 0, b: 0};
  return pattern.sample(Math.max(0, Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0));
}

/** null means no selected patterns; an empty pool never silently enables exclusions. */
export function choosePattern(toy, includedIds = null, previous = null, rng = Math.random) {
  const pool = patternsFor(toy).map(p => p.id).filter(id => !Array.isArray(includedIds) || includedIds.includes(id));
  if (!pool.length) return null;
  const alternatives = pool.filter(id => id !== previous);
  const choices = alternatives.length ? alternatives : pool;
  const random = Math.max(0, Math.min(.999999999, Number(rng()) || 0));
  return choices[Math.floor(random * choices.length)];
}
