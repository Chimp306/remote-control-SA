import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mapRequestPath } from '../scripts/site-paths.mjs';
import { MENU_DIGEST, hexEqual, menuMarkup, passcodeMatches, sha256Hex } from '../app/gate.js';

const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');

test('a matching digest opens and a different digest does not', async () => {
  const sample = 'sample-entry-for-the-test-only';
  const digest = await sha256Hex(sample);
  assert.equal(await passcodeMatches(sample, digest), true);
  assert.equal(await passcodeMatches('different-entry', digest), false);
  assert.equal(await passcodeMatches('wrong-entry', MENU_DIGEST), false);
  assert.equal(await passcodeMatches('', MENU_DIGEST), false);
  assert.equal(hexEqual(digest, digest), true);
  assert.equal(MENU_DIGEST, '5872b2dc693ebfa8adb71c74cb583a78c20f8c0ee5d49dad9e89d749b24ca1af');
});

test('the cover source does not store or print the typed code', () => {
  const source = read('../app/gate.js');
  assert.match(source, /crypto\.subtle\.digest\('SHA-256'/);
  assert.equal(source.includes('console.'), false);
  assert.equal(source.includes('localStorage'), false);
  assert.match(source, /sessionStorage\.setItem\(COVER_FLAG, '1'\)/);
  assert.equal(source.includes('sessionStorage.setItem(COVER_FLAG, typed'), false);
  assert.equal(/\b\d{6}\b/.test(source), false);
  const menu = menuMarkup();
  assert.match(menu, /href="\/suc\/"/);
  assert.match(menu, /href="\/SOLO\/"/);
  assert.match(menu, /href="\/FREQ\/"/);
  assert.match(menu, /href="\/GROK\/"/);
  assert.match(menu, />SUC</);
  assert.match(menu, />SOLO</);
  assert.match(menu, />FREQ</);
  assert.match(menu, /href="\/\?classic"/);
  assert.match(menu, /not an account/);
});

test('root sends test mode to SOLO and does not load the player on the menu', () => {
  const root = read('../index.html');
  assert.match(root, /params\.has\('test'\)/);
  assert.match(root, /location\.replace\('\/SOLO\/\?test=1'\)/);
  const testBranch = root.slice(root.indexOf("params.has('test')"), root.indexOf("params.has('classic')"));
  assert.equal(testBranch.includes('simple-player'), false);
  assert.equal(testBranch.includes('bluetooth'), false);
  assert.match(root, /params\.has\('classic'\)/);
  assert.match(root, /const version = '20261101-dual40'/);
  assert.match(root, /import\(`\/app\/main\.js\?v=\$\{version\}`\)/);
  assert.match(root, /const version = '20261108-v216'/);
  assert.match(root, /import\(`\/app\/gate\.js\?v=\$\{version\}`\)/);
  assert.equal(root.includes('simple-player.js'), false);
});

test('SOLO uses absolute current assets and FREQ cannot save entries', () => {
  const solo = read('../SOLO/index.html');
  assert.match(solo, /const version = '20261108-v220'/);
  assert.match(solo, /\/app\/simple-player\.css\?v=\$\{version\}/);
  assert.match(solo, /import\(`\/app\/simple-player\.js\?v=\$\{version\}`\)/);
  assert.equal(solo.includes('src="app/'), false);
  const player = read('../app/simple-player.js');
  assert.match(player, /from '\.\/config\.js\?v=20261108-v215'/);
  assert.equal(player.includes('pc-media'), false);
  assert.equal(player.includes('config.js?v=20261107-v213'), false);
  const config = read('../app/config.js');
  assert.match(config, /BUILD = '2026\.11\.08-v2\.15'/);
  const freq = read('../FREQ/index.html');
  assert.match(freq, /data-freq="checking"/);
  assert.match(freq, /Nothing has been saved/);
  assert.match(freq, /\/app\/freq\.js\?v=\$\{version\}/);
  assert.match(freq, /const version = '20261107-v216'/);
  assert.equal(freq.includes('simple-player'), false);
  assert.equal(freq.includes('ctmp-control'), false);
  assert.equal(freq.includes('<form'), false);
});

test('/PC no longer loads the picture player', () => {
  const removed = read('../PC/index.html');
  assert.match(removed, /Picture player removed/);
  assert.equal(removed.includes('simple-player'), false);
  assert.equal(removed.includes('pc-media'), false);
  assert.equal(fs.existsSync(new URL('../app/pc-media.js', import.meta.url)), false);
  assert.deepEqual(mapRequestPath('/PC'), { redirect: '/PC/' });
  assert.deepEqual(mapRequestPath('/PC/'), { file: '/PC/index.html' });
  assert.deepEqual(mapRequestPath('/SOLO'), { redirect: '/SOLO/' });
  assert.deepEqual(mapRequestPath('/SOLO/'), { file: '/SOLO/index.html' });
  assert.deepEqual(mapRequestPath('/FREQ/'), { file: '/FREQ/index.html' });
  assert.deepEqual(mapRequestPath('/'), { file: '/index.html' });
  const suc = read('../suc/index.html');
  assert.match(suc, /const VERSION = '1\.4\.10'/);
});
