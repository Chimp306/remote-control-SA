import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../suc/index.html', import.meta.url), 'utf8');
const rootHtml = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const storyStart = html.indexOf('const DIFFICULTIES');
const storyEnd = html.indexOf('function prescriptionFor');
const STORY_HASH = '82f65e42e2b58e96fef68741b73be6760aff51af63ff77694c31692f55964954';
const ROOM_HASHES = {
  reception: 'a199c27f4d1aa0d5bcc24783c17472ebdc7f9481071775edb3a7558b2fb560b6',
  assessment: 'dc72f4d32fb3fa2e7e0fbbd0a894d965abeebe8338046cefd99a5f82cc9a57a1',
  observation: '9b5bc8e128c220660a13695a9d85f4c34fafc810354d34d50b3acd22824b2201',
  waiting: 'fa8d29072f3ae13a5d84c4ca8b6d1bbac0e5f8316c401b35b813f5ab55a6c076',
};
const CHOICE_IDS = ['counting','professional','custom_tease','change','enjoy','custom_intense','quota','smile','custom_close','boss','patience','custom_hold','permission','resolve','custom_beg'];
const BANNED = /\b(cock|cocks|precum|orgasm|orgasms|milking|milk|drip|dripping|leak|leaking|leaked|suction|toy|toys|throb|throbbing|aching|ache|erection|nude|naked|breast|breasts|cleavage|fetish|stocking|stockings|lingerie|beg|begging|begged|cum|penis|pussy|fuck|fucking|wet|hard|come|comes|coming|edge|edges|edging)\b/i;

function storyVm() {
  const code = html.slice(html.indexOf('// SUC Clinic:'), html.indexOf('let game=null'))
    + '\nglobalThis.__suc = {CHOICES, DIFFICULTIES, NURSES, createAppointment, hallAirFor};';
  const context = {Math, Date, JSON, Object, Array, Set, Map, Number, String, Boolean, Error, RegExp};
  vm.createContext(context);
  vm.runInContext(code, context, {filename: 'suc/index.html'});
  return context.__suc;
}

function artValue(key) {
  const token = `"${key}":"`;
  const art = html.slice(html.indexOf('const ART='), html.indexOf('const VERSION'));
  const at = art.indexOf(token);
  assert.ok(at >= 0, key);
  const start = at + token.length;
  const end = art.indexOf('"', start);
  return art.slice(start, end);
}

test('SUC version is 1.4.9 and the simple player story hooks are untouched', () => {
  assert.match(html, /const VERSION = '1\.4\.9';/);
  assert.equal(html.includes("const VERSION = '1.4.8'"), false);
  assert.equal(rootHtml.includes('HALL_AIR'), false);
  assert.equal(rootHtml.includes('hallAirFor'), false);
});

test('existing story constants are byte-for-byte unchanged', () => {
  assert.equal(crypto.createHash('sha256').update(html.slice(storyStart, storyEnd)).digest('hex'), STORY_HASH);
});

test('hall atmosphere is original, non-explicit, and specific to each beat', () => {
  const suc = storyVm();
  const nurses = ['evelyn', 'scarlett', 'beatrice', 'victoria'];
  const beats = [
    {phase: 'waiting', stage: 0, day: 'generous'},
    {phase: 'intro', stage: 0, day: 'quota'},
    {phase: 'scene', stage: 0, day: 'inspection'},
    {phase: 'running', stage: 1, day: 'ordinary'},
    {phase: 'scene', stage: 2, day: 'efficient'},
    {phase: 'running', stage: 3, day: 'generous'},
    {phase: 'scene', stage: 4, day: 'quota'},
    {phase: 'ended', stage: 4, day: 'ordinary'},
  ];
  const passages = [];
  for (const nurse of nurses) {
    for (const beat of beats) {
      const lines = suc.hallAirFor({nurse, ...beat});
      assert.equal(lines.length, beat.phase === 'waiting' ? 3 : 2);
      const text = lines.join('\n');
      assert.ok(text.length > 400, `${nurse} ${beat.phase} ${beat.stage} is too short`);
      assert.equal(BANNED.test(text), false, `${nurse} ${beat.phase}: ${text.match(BANNED)?.[0]}`);
      passages.push(`${nurse}:${beat.phase}:${beat.stage}:${text}`);
    }
  }
  assert.equal(new Set(passages).size, passages.length);
  assert.match(html, /receptionAirHtml\(\)/);
  assert.match(html, /hallAirHtml\(hallAirFor\(s\)\)/);
  assert.match(html, /class="air-card"/);
});

test('appointment mechanics, choices, caps and recorded text are unchanged by the aside', () => {
  const suc = storyVm();
  const ids = suc.CHOICES.map(stage => stage.map(choice => String(choice[0]))).flat();
  assert.equal(ids.join('|'), CHOICE_IDS.join('|'));
  const first = suc.createAppointment({difficulty: 'medium', preview: true, seed: 42, preferredNurse: 'evelyn', visitedBefore: false});
  const second = suc.createAppointment({difficulty: 'medium', preview: true, seed: 42, preferredNurse: 'evelyn', visitedBefore: false});
  assert.equal(first.s.target, second.s.target);
  assert.equal(first.s.day, second.s.day);
  assert.equal(first.s.rule, second.s.rule);
  assert.deepEqual(first.s.boundaries, second.s.boundaries);
  const hard = suc.DIFFICULTIES.hard;
  const visit = suc.createAppointment({difficulty: 'hard', preview: true, seed: 7, preferredNurse: 'victoria', visitedBefore: true, previousPrescription: 'denied'});
  assert.equal(visit.s.nurse, 'victoria');
  assert.equal(visit.s.rule, 'request');
  assert.ok(visit.s.target >= hard.min && visit.s.target <= hard.max);
  assert.equal(visit.s.hardCap, Math.ceil(hard.max * 1.2));
  assert.equal(visit.s.floor, Math.max(Math.floor(hard.min * .8), Math.floor(visit.s.originalTarget * .79) + 1));
  assert.deepEqual(visit.s.boundaries, [.13, .31, .53, .78].map(f => Math.floor(visit.s.originalTarget * f)));
  assert.equal(visit.waitingChoice('seat'), true);
  assert.equal(visit.s.phase, 'intro');
  assert.ok(visit.s.currentText.includes(suc.NURSES.victoria.intro));
  assert.equal(visit.s.events.some(event => String(event.text).includes('ASIDE FROM THE CHART')), false);
  assert.equal(visit.introduction('observe'), true);
  assert.equal(visit.choose(suc.CHOICES[0][0][0]), true);
  assert.equal(visit.choose('not-a-choice'), false);
  assert.equal(visit.beginStage(), true);
  const boundary = visit.s.boundaries[0];
  while (visit.s.phase === 'running' && visit.s.count < boundary) {
    assert.equal(visit.credit(visit.s.lastIncoming + 1, {cycleSeconds: 10}), true);
  }
  assert.equal(visit.s.stage, 1);
  assert.equal(visit.s.phase, 'scene');
  assert.equal(visit.s.count, boundary);
  assert.equal(visit.s.target, visit.s.originalTarget);

  let mercy = null;
  for (let seed = 1; seed < 80 && !mercy; seed++) {
    const game = suc.createAppointment({difficulty: 'easy', preview: true, seed, preferredNurse: 'evelyn'});
    if (game.s.rule === 'mercy') mercy = game;
  }
  assert.ok(mercy);
  mercy.waitingChoice('ask');
  mercy.introduction('questions');
  mercy.choose(suc.CHOICES[0][1][0]);
  mercy.beginStage();
  mercy.credit(1, {cycleSeconds: 10});
  for (let i = 0; i < 40 && mercy.s.target > mercy.s.floor && mercy.s.phase !== 'ended'; i++) {
    if (mercy.request()) continue;
    if (mercy.s.phase !== 'running' || !mercy.credit(mercy.s.lastIncoming + 1, {cycleSeconds: 10})) break;
  }
  assert.ok(mercy.s.target >= mercy.s.floor);
  assert.ok(mercy.s.target <= mercy.s.hardCap);

  let extend = null;
  for (let seed = 1; seed < 80 && !extend; seed++) {
    const game = suc.createAppointment({difficulty: 'medium', preview: true, seed, preferredNurse: 'scarlett'});
    if (game.s.rule === 'extend') extend = game;
  }
  assert.ok(extend);
  extend.waitingChoice('notice');
  extend.introduction('questions');
  extend.choose(suc.CHOICES[0][2][0]);
  extend.beginStage();
  extend.credit(1, {cycleSeconds: 10});
  for (let i = 0; i < 40 && extend.s.phase !== 'ended'; i++) {
    if (extend.request()) continue;
    if (extend.s.phase !== 'running' || !extend.credit(extend.s.lastIncoming + 1, {cycleSeconds: 10})) break;
  }
  assert.ok(extend.s.target <= extend.s.hardCap);
  assert.equal(extend.s.events.some(event => String(event.text).includes('hall-air')), false);
});

test('nurse portraits are distinct clothed replacements and room plates are unchanged', () => {
  const seen = new Set();
  for (const nurse of ['evelyn', 'scarlett', 'beatrice', 'victoria']) {
    for (const pose of ['head', '34', 'laugh', 'notes']) {
      const value = artValue(`${nurse}_${pose}`);
      assert.match(value, /^data:image\/webp;base64,/);
      const bytes = Buffer.from(value.split(',')[1], 'base64');
      assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
      assert.ok(bytes.length > 8000);
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      assert.equal(seen.has(hash), false, `${nurse}_${pose} duplicates another portrait`);
      seen.add(hash);
    }
  }
  for (const [room, expected] of Object.entries(ROOM_HASHES)) {
    const bytes = Buffer.from(artValue(room).split(',')[1], 'base64');
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expected);
  }
});
