/**
 * Vacuglide V2 over Autoblow's HTTP API.
 * Cluster lookup: GET https://latency.autoblowapi.com/vacuglide/connected
 * with header x-device-token. Speed is PUT /vacuglide/target-speed (0–100).
 * Stroke length is the stroke-plus / stroke-minus valves, opened briefly
 * per tap and then closed. Oscillate is an Autoblow Ultra endpoint and is
 * not used here.
 *
 * The API responds with Access-Control-Allow-Origin: * and allows the
 * x-device-token header, so a page on ctmp.uk can call it directly.
 */

import { vacuglideConnectedUrl, vacuglideSpeed, vacuglideUrl } from './protocol.js';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function networkMessage(error) {
  const text = String(error?.message || error || '');
  if (error?.name === 'AbortError' || /timed out/i.test(text)) {
    return 'VacuGlide did not answer in time. Check the device, then try again.';
  }
  if (error instanceof TypeError || /failed to fetch|network|cors/i.test(text)) {
    return 'The browser blocked the Autoblow request (network or CORS). Nothing was sent.';
  }
  return text || 'VacuGlide request failed.';
}

async function request(fetchImpl, url, { method = 'GET', token, body, timeout = 8000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('HTTP requests are unavailable in this browser.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = { 'x-device-token': token };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('That device token was rejected.');
      if (response.status === 429) throw new Error('Autoblow rate limit reached. Wait a moment, then try again.');
      if (response.status === 502) throw new Error('VacuGlide is offline or this is the wrong cluster. Turn on online mode, then connect again.');
      throw new Error(`VacuGlide request failed (HTTP ${response.status}).`);
    }
    if (response.status === 204) return {};
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error('VacuGlide did not answer in time. Check the device, then try again.');
    throw new Error(networkMessage(error));
  } finally {
    clearTimeout(timer);
  }
}

export function createVacuGlide({ fetchImpl = globalThis.fetch, onStatus = () => {}, onCommand = () => {} } = {}) {
  let token = '';
  let cluster = '';
  let ready = false;
  let generation = 0;
  let lastSpeed = null;
  let nudge = null;

  function status(state, message) {
    try { onStatus({ state, connected: ready, message }); } catch { /* observer */ }
  }

  async function call(path, method, body) {
    if (!cluster || !token) throw new Error('VacuGlide is not connected.');
    return request(fetchImpl, vacuglideUrl(cluster, path), { method, token, body });
  }

  return {
    get connected() { return ready; },

    async connect(nextToken) {
      const trimmed = String(nextToken || '').trim();
      if (!trimmed || trimmed.length > 512 || /[\s\u0000-\u001f\u007f]/.test(trimmed)) {
        throw new Error('Paste the VacuGlide device token for this session.');
      }
      generation += 1;
      const epoch = generation;
      token = trimmed;
      ready = false;
      cluster = '';
      lastSpeed = null;
      status('connecting', 'Checking VacuGlide…');
      try {
        const result = await request(fetchImpl, vacuglideConnectedUrl(), { token: trimmed });
        if (epoch !== generation) return;
        if (result?.connected !== true) throw new Error('VacuGlide is offline. Hold the mode button to turn on online mode, then connect again.');
        if (result.deviceType && result.deviceType !== 'vacuglide') throw new Error('This token is not for a VacuGlide.');
        if (!result.cluster) throw new Error('VacuGlide did not say which server it is on.');
        vacuglideUrl(result.cluster, '/vacuglide/state');
        cluster = result.cluster;
        await call('/vacuglide/target-speed/stop', 'PUT');
        if (epoch !== generation) return;
        ready = true;
        lastSpeed = 0;
        onCommand('PUT /vacuglide/target-speed/stop');
        status('connected', 'Connected');
      } catch (error) {
        if (epoch === generation) {
          token = '';
          cluster = '';
          ready = false;
          status('error', error.message);
        }
        throw error;
      }
    },

    async setSpeed(displayPercent, ceiling) {
      if (!ready) return;
      const speed = vacuglideSpeed(displayPercent, ceiling);
      if (speed === lastSpeed) return;
      const epoch = generation;
      if (speed === 0) {
        lastSpeed = 0;
        onCommand('PUT /vacuglide/target-speed/stop');
        await call('/vacuglide/target-speed/stop', 'PUT');
        return;
      }
      lastSpeed = speed;
      onCommand(`PUT /vacuglide/target-speed ${speed}`);
      await call('/vacuglide/target-speed', 'PUT', { targetSpeed: speed });
      if (epoch !== generation) await call('/vacuglide/target-speed/stop', 'PUT').catch(() => {});
    },

    async nudgeStroke(direction) {
      if (!ready) throw new Error('Connect VacuGlide before changing the stroke.');
      if (direction !== 'plus' && direction !== 'minus') return;
      if (nudge) return;
      const epoch = generation;
      const path = `/vacuglide/valve/stroke-${direction}`;
      nudge = direction;
      try {
        onCommand(`PUT ${path} open`);
        await call(path, 'PUT', { valveState: true });
        await sleep(300);
        if (epoch !== generation) return;
        onCommand(`PUT ${path} close`);
        await call(path, 'PUT', { valveState: false });
      } finally {
        nudge = null;
      }
    },

    async stop() {
      generation += 1;
      if (!cluster || !token) {
        lastSpeed = 0;
        return;
      }
      lastSpeed = 0;
      onCommand('PUT /vacuglide/target-speed/stop');
      const failures = [];
      for (const [path, body] of [
        ['/vacuglide/target-speed/stop', undefined],
        ['/vacuglide/valve/stroke-plus', { valveState: false }],
        ['/vacuglide/valve/stroke-minus', { valveState: false }],
      ]) {
        try { await call(path, 'PUT', body); }
        catch (error) { failures.push(error.message); }
      }
      if (failures.length) throw new Error(failures[0]);
    },

    async disconnect() {
      let failure = null;
      try { await this.stop(); }
      catch (error) { failure = error; }
      generation += 1;
      ready = false;
      token = '';
      cluster = '';
      lastSpeed = null;
      status('disconnected', failure ? 'Disconnected. The stop was not confirmed.' : 'Disconnected');
      if (failure) throw failure;
    },
  };
}
