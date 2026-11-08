import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startGrokTestServer } from '../scripts/grok-test-server.mjs';

async function browser() {
  const chrome = spawn('google-chrome', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--user-data-dir=/tmp/grok-local-chrome', '--remote-debugging-port=9355', 'about:blank',
  ], { stdio: 'ignore' });
  const started = Date.now();
  let version;
  while (Date.now() - started < 8000) {
    try {
      version = await fetch('http://127.0.0.1:9355/json/version').then(response => response.json());
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  if (!version) { chrome.kill('SIGKILL'); throw new Error('Chrome did not start'); }
  return chrome;
}

function cdp(wsUrl) {
  let id = 0;
  const pending = new Map();
  const ws = new WebSocket(wsUrl);
  ws.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (!data.id || !pending.has(data.id)) return;
    const item = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) item.reject(new Error('browser call failed'));
    else item.resolve(data.result);
  });
  const ready = new Promise(resolve => ws.addEventListener('open', resolve));
  return {
    ready,
    async send(method, params = {}) {
      await ready;
      const msgId = ++id;
      ws.send(JSON.stringify({ id: msgId, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(msgId, { resolve, reject });
        setTimeout(() => { if (pending.has(msgId)) { pending.delete(msgId); reject(new Error('browser timed out')); } }, 8000);
      });
    },
    close() { ws.close(); },
  };
}

test('the browser uses the fake radio, rejects a replayed enrollment, and hides the session from a stranger', async () => {
  const started = await startGrokTestServer();
  const chrome = await browser();
  let session;
  try {
    const tab = await fetch('http://127.0.0.1:9355/json/new?about:blank', { method: 'PUT' }).then(response => response.json());
    session = cdp(tab.webSocketDebuggerUrl);
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Page.navigate', { url: `http://127.0.0.1:${started.port}/GROK/?test=1&bridge=1` });
    const evalJs = async expression => {
      const result = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error('page failed');
      return result.result.value;
    };
    const waitFor = async expression => {
      const begin = Date.now();
      while (Date.now() - begin < 12000) {
        const value = await evalJs(expression);
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw new Error('page was not ready');
    };
    const paired = await fetch(started.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'login', enrollment: started.enrollment }),
    }).then(response => response.json());
    const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'grok-page-')), 'pairing.token');
    fs.writeFileSync(tokenFile, `${paired.refresh}\n`, { mode: 0o600 });
    await waitFor('Boolean(document.getElementById("grok-pair")) && document.body.innerText.includes("Simulated")');
    assert.equal((await evalJs('document.body.innerText')).includes('sign-in is required'), false);
    assert.equal(await evalJs('document.querySelector("[data-act=\\"grok-arm\\"]").disabled'), false);
    await evalJs('document.querySelector("[data-act=\\"grok-arm\\"]").click()');
    await waitFor('document.getElementById("grok-status")?.textContent.includes("Armed")');
    await evalJs(`{
      document.getElementById('grok-pair').value = ${JSON.stringify(paired.refresh)};
      document.querySelector('[data-grok-pair]').requestSubmit();
      true;
    }`);
    await waitFor('document.body.innerText.includes("Paired.")');
    assert.equal((await evalJs('document.body.innerText')).includes(paired.refresh), false);
    await waitFor('document.querySelector("[data-act=\\"grok-arm\\"]")');
    await evalJs('document.querySelector("[data-act=\\"grok-arm\\"]").click()');
    await waitFor('document.getElementById("grok-status")?.textContent.includes("Armed")');
    await new Promise(resolve => setTimeout(resolve, 2500));
    const bot = spawn(process.execPath, ['scripts/grok-bot.mjs', 'send', 'stop'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, GROK_FUNCTION_URL: started.url, GROK_TOKEN_FILE: tokenFile, GROK_ACK_WAIT_MS: '12000' },
    });
    let botOut = '';
    let botErr = '';
    bot.stdout.on('data', chunk => { botOut += chunk; });
    bot.stderr.on('data', chunk => { botErr += chunk; });
    const botCode = await new Promise(resolve => bot.on('exit', resolve));
    await waitFor('window.__ctmpTest?.().phase === "stopped"');
    const snapshot = await evalJs('window.__ctmpTest()');
    assert.equal(snapshot.phase, 'stopped');
    assert.equal(snapshot.displayA, 0);
    assert.equal(snapshot.displayB, 0);
    assert.equal(botCode, 0);
    assert.match(botOut, /"applied":true/);
    assert.equal(botOut.includes(paired.refresh), false);
    assert.equal(botErr.includes(paired.refresh), false);
    assert.match(await evalJs('document.body.innerText'), /Simulated/);
    const replay = await fetch(started.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'login', enrollment: started.enrollment }),
    });
    assert.equal(replay.status, 401);
    const stranger = await fetch(started.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-grok-access': 'ef'.repeat(32) },
      body: JSON.stringify({ action: 'read' }),
    });
    const strangerBody = await stranger.text();
    assert.equal(stranger.status, 401);
    assert.equal(strangerBody.includes(paired.refresh), false);
  } finally {
    session?.close();
    chrome.kill('SIGKILL');
    started.server.closeAllConnections?.();
    await new Promise(resolve => started.server.close(resolve));
  }
});
