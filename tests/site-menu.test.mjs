import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mapRequestPath } from '../scripts/site-paths.mjs';
import { MENU_DIGEST, menuMarkup, passcodeMatches, sha256Hex } from '../app/gate.js';

const read = (name) => fs.readFileSync(new URL(name, import.meta.url), 'utf8');

test('the menu cover still compares a SHA-256 digest and does not store the typed code', async () => {
  const sample = 'sample-entry-for-the-test-only';
  const digest = await sha256Hex(sample);
  assert.equal(await passcodeMatches(sample, digest), true);
  assert.equal(await passcodeMatches('different-entry', digest), false);
  assert.equal(MENU_DIGEST, '5872b2dc693ebfa8adb71c74cb583a78c20f8c0ee5d49dad9e89d749b24ca1af');
  const source = read('../app/gate.js');
  assert.match(source, /crypto\.subtle\.digest\('SHA-256'/);
  assert.equal(source.includes('localStorage'), false);
  assert.equal(source.includes('console.'), false);
  const menu = menuMarkup();
  assert.match(menu, /href="\/solo\/"/);
  assert.match(menu, /href="\/suc\/"/);
  assert.match(menu, />SOLO</);
  assert.match(menu, />SUC</);
  assert.equal(menu.includes('/FREQ/'), false);
  assert.equal(menu.includes('/GROK/'), false);
  assert.equal(menu.includes('/SOLO/'), false);
  assert.match(menu, /not an account/);
});

test('root opens the cover, sends test mode to /solo/, and /SOLO/ redirects', () => {
  const root = read('../index.html');
  assert.match(root, /params\.has\('test'\)/);
  assert.match(root, /location\.replace\('\/solo\/\?test=1'\)/);
  assert.match(root, /import\(`\/app\/gate\.js\?v=\$\{version\}`\)/);
  assert.equal(root.includes('simple-player'), false);
  assert.equal(root.includes('supabase'), false);
  const redirect = read('../SOLO/index.html');
  assert.match(redirect, /location\.replace\('\/solo\/'/);
  assert.deepEqual(mapRequestPath('/SOLO'), { redirect: '/solo/' });
  assert.deepEqual(mapRequestPath('/SOLO/'), { redirect: '/solo/' });
  assert.deepEqual(mapRequestPath('/solo'), { redirect: '/solo/' });
  assert.deepEqual(mapRequestPath('/solo/'), { file: '/solo/index.html' });
  assert.deepEqual(mapRequestPath('/'), { file: '/index.html' });
});

test('removed sections are gone and SUC still imports only its shared modules', () => {
  const root = new URL('..', import.meta.url);
  for (const gone of ['FREQ/index.html', 'GROK/index.html', 'PC/index.html', 'supabase/config.toml', 'app/backend.js', 'app/config.js', 'app/simple-player.js']) {
    assert.equal(fs.existsSync(new URL(gone, root)), false, gone);
  }
  const suc = read('../suc/index.html');
  assert.match(suc, /const VERSION = '1\.4\.10'/);
  assert.match(suc, /app\/page-lifecycle\.js/);
  assert.match(suc, /app\/engine\.js/);
  assert.match(suc, /app\/devices\.js/);
  assert.match(suc, /app\/civet-calibration\.js/);
  const solo = read('../solo/app.js');
  assert.equal(solo.includes('supabase'), false);
  assert.equal(solo.includes('visibilitychange'), false);
});
