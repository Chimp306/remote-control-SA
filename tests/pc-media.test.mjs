import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mapRequestPath } from '../scripts/site-paths.mjs';
import {
  advanceDeckOnEdge,
  createPatternTrace,
  createPictureDeck,
  isPcRoute,
  isSupportedImage,
  pictureLoadFailureMessage,
} from '../app/pc-media.js';

function file(name, type, size = 8) {
  return { name, type, size };
}

function deck(random = Math.random) {
  const urls = [];
  const revoked = [];
  let n = 0;
  const pictures = createPictureDeck({
    createUrl(item) { const url = `blob:${item.name}-${n += 1}`; urls.push(url); return url; },
    revokeUrl(url) { revoked.push(url); },
    random,
  });
  return { pictures, urls, revoked };
}

test('/PC and /PC/ are the picture player and the root path is not', () => {
  assert.equal(isPcRoute('/PC'), true);
  assert.equal(isPcRoute('/PC/'), true);
  assert.equal(isPcRoute('/'), false);
  assert.equal(isPcRoute('/pc'), false);
  assert.equal(isPcRoute('/suc/'), false);
  assert.deepEqual(mapRequestPath('/PC'), { redirect: '/PC/' });
  assert.deepEqual(mapRequestPath('/PC/'), { file: '/PC/index.html' });
  assert.deepEqual(mapRequestPath('/'), { file: '/index.html' });
  const page = fs.readFileSync(new URL('../PC/index.html', import.meta.url), 'utf8');
  assert.match(page, /\/app\/simple-player\.js\?v=/);
  assert.match(page, /\/app\/simple-player\.css\?v=/);
  assert.doesNotMatch(page, /src="app\//);
  const suc = fs.readFileSync(new URL('../suc/index.html', import.meta.url), 'utf8');
  assert.match(suc, /const VERSION = '1\.4\.10'/);
});

test('unsupported, empty, and scriptable files are skipped', () => {
  assert.equal(isSupportedImage(file('a.jpg', 'image/jpeg')), true);
  assert.equal(isSupportedImage(file('a.PNG', '')), true);
  assert.equal(isSupportedImage(file('a.svg', 'image/svg+xml')), false);
  assert.equal(isSupportedImage(file('a.html', 'text/html')), false);
  assert.equal(isSupportedImage(file('empty.png', 'image/png', 0)), false);
  const { pictures, urls } = deck();
  const result = pictures.replace([
    file('note.html', 'text/html'),
    file('icon.svg', 'image/svg+xml'),
    file('blank.png', 'image/png', 0),
    file('one.png', 'image/png'),
  ]);
  assert.equal(result.ok, true);
  assert.match(result.message, /Skipped 3/);
  assert.equal(result.current.name, 'one.png');
  assert.equal(urls.length, 1);
  const none = pictures.replace([file('page.html', 'text/html')]);
  assert.equal(none.ok, false);
  assert.match(none.message, /No supported pictures/);
});

test('object URLs are revoked on the next picture and on replacement', () => {
  const { pictures, revoked } = deck(() => 0);
  pictures.replace([file('a.png', 'image/png'), file('b.png', 'image/png'), file('<b>.png', 'image/png')]);
  const first = pictures.current().url;
  pictures.advance();
  assert.deepEqual(revoked, [first]);
  const second = pictures.current().url;
  pictures.replace([file('c.png', 'image/png')]);
  assert.ok(revoked.includes(second));
  assert.equal(pictures.current().name, 'c.png');
});

test('an edge advances once and Next does not know about the engine', () => {
  const { pictures } = deck(() => 0.5);
  pictures.replace([file('a.png', 'image/png'), file('b.png', 'image/png'), file('c.png', 'image/png')]);
  const before = pictures.current().name;
  assert.equal(advanceDeckOnEdge(pictures, 0, 0), 0);
  assert.equal(pictures.current().name, before);
  assert.equal(advanceDeckOnEdge(pictures, 0, 1), 1);
  assert.notEqual(pictures.current().name, before);
  const afterEdge = pictures.current().name;
  pictures.advance();
  assert.notEqual(pictures.current().name, afterEdge);
  const source = fs.readFileSync(new URL('../app/pc-media.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /engine|setLevels|opossum/i);
  const player = fs.readFileSync(new URL('../app/simple-player.js', import.meta.url), 'utf8');
  assert.match(player, /advanceDeckOnEdge\(pictureDeck, previousCount, state\.edgeCount\)/);
  assert.match(player, /data-act="pc-next"/);
});

test('the pattern trace uses commanded samples and reports pause as stopped', () => {
  const trace = createPatternTrace();
  trace.push(10, 10);
  trace.push(20, 30);
  trace.push(40, 50);
  assert.equal(trace.relation(), 'in phase');
  const opposed = createPatternTrace();
  opposed.push(50, 10);
  opposed.push(40, 20);
  opposed.push(30, 30);
  opposed.push(20, 40);
  assert.equal(opposed.relation(), 'opposed');
  const stopped = createPatternTrace();
  stopped.push(0, 0);
  stopped.push(0, 0);
  stopped.push(0, 0);
  assert.equal(stopped.relation(), 'stopped');
  const paused = createPatternTrace();
  paused.push(10, 20);
  paused.push(30, 40);
  paused.push(0, 0);
  assert.equal(paused.relation(), 'at zero');
  assert.equal(stopped.samples().length, 1);
  assert.match(pictureLoadFailureMessage(), /could not be shown/);
  const player = fs.readFileSync(new URL('../app/simple-player.js', import.meta.url), 'utf8');
  assert.match(player, /pictureLoadFailureMessage\(\)/);
  assert.doesNotMatch(player, /pc-picture[\s\S]{0,240}engine\.stop/);
});
