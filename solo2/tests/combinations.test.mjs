import test from 'node:test';
import assert from 'node:assert/strict';
import {DeviceManager} from '../devices.js';
import {SessionEngine} from '../engine.js';

// Integration of the actual simulation adapter and session state machine.
// Time advances in worker-sized steps; no wall-clock waits or hardware exist.
for (const toy of ['opossum', 'lush', 'vacuglide']) {
  for (const civetEnabled of [false, true]) {
    test(`${toy}${civetEnabled ? ' + Civet' : ' alone'}: live output, gating, resume, and persistent Stop without external I/O`, async () => {
      let now = 0;
      let bluetoothCalls = 0;
      let httpCalls = 0;
      let pressureSamples = 0;
      const faults = [];
      const levels = [];
      const engine = new SessionEngine({now: () => now, random: () => .5});
      engine.configure({
        toy, civetEnabled, cutoff: 20.5, restMin: 1, restMax: 3, maxPower: 60,
        pattern: toy === 'opossum' ? 'ping-pong' : toy === 'lush' ? 'wave' : 'random',
      });
      let snapshot = engine.snapshot();
      const manager = new DeviceManager({
        now: () => now,
        bluetooth: {
          requestDevice: () => { bluetoothCalls++; throw new Error('Simulation requested Bluetooth'); },
          getDevices: () => { bluetoothCalls++; throw new Error('Simulation queried Bluetooth'); },
        },
        fetchImpl: () => { httpCalls++; throw new Error('Simulation requested the network'); },
        onPressure: (kpa, at) => { pressureSamples++; snapshot = engine.pressure(kpa, now, at); },
        onFault: message => faults.push(message),
      });
      await manager.setTest(true);
      await manager.connect(toy);
      if (civetEnabled) await manager.connect('civet');
      for (const key of ['opossum', 'lush', 'vacuglide', 'civet']) {
        assert.equal(manager.status(key), key === toy || (key === 'civet' && civetEnabled) ? 'connected' : 'disconnected');
      }

      const apply = async (value) => {
        snapshot = value;
        levels.push({...value.output});
        const result = await manager.setOutput(toy, value.output, {hardwareCap: 40, speedCap: 35});
        assert.equal(result.simulated, true);
        assert.equal(manager.slots[toy].outputActive, value.output.a > 0 || (toy === 'opossum' && value.output.b > 0));
        return value;
      };
      const step = async () => {
        now += 100;
        manager.tickFakePressure();
        return apply(engine.tick(now));
      };

      await apply(engine.start(now));
      for (let i = 0; i < 10; i++) await step();
      assert.equal(snapshot.state, 'running');
      assert.ok(levels.some(level => level.a > 0), 'output must become positive');
      if (toy === 'opossum') assert.ok(levels.some(level => level.b > 0));
      if (toy !== 'vacuglide') assert.ok(new Set(levels.map(level => level.a.toFixed(3))).size > 1, 'the chart source must move');

      manager.setFakePressure(20.75);
      if (civetEnabled) {
        // The notification itself trips; no next clock tick is needed to zero.
        assert.equal(snapshot.state, 'resting');
        assert.equal(snapshot.edges, 1);
        assert.equal(snapshot.restTotalMs, 2000);
        assert.deepEqual(snapshot.output, {a: 0, b: 0});
        await apply(snapshot);
        for (let i = 0; i < 20; i++) {
          await step();
          assert.equal(snapshot.edges, 1, 'a held pressure must count only once');
          assert.deepEqual(snapshot.output, {a: 0, b: 0});
        }
        assert.equal(snapshot.state, 'waiting', 'rest completes without restarting against high pressure');
        manager.setFakePressure(20.2);
        assert.equal(snapshot.state, 'running');
        await apply(snapshot);
        for (let i = 0; i < 3; i++) await step();
        assert.ok(snapshot.output.a > 0 || snapshot.output.b > 0, 'release resumes live output');
        assert.equal(snapshot.edges, 1);
      } else {
        await step();
        assert.equal(snapshot.state, 'running');
        assert.equal(snapshot.edges, 0);
        assert.equal(pressureSamples, 0, 'disabled Civet emits no fake readings');
      }

      await apply(engine.stop('Stopped', now));
      await manager.stopAll();
      const stoppedElapsed = snapshot.elapsedMs;
      manager.setFakePressure(20);
      for (let i = 0; i < 10; i++) {
        await step();
        assert.equal(snapshot.state, 'idle');
        assert.deepEqual(snapshot.output, {a: 0, b: 0});
        assert.equal(snapshot.elapsedMs, stoppedElapsed);
      }
      if (toy === 'vacuglide') {
        assert.equal((await manager.stroke(1)).simulated, true);
        assert.equal((await manager.stroke(-1)).simulated, true);
      }
      await manager.disconnect(toy);
      if (civetEnabled) await manager.disconnect('civet');
      assert.equal(manager.status(toy), 'disconnected');
      assert.equal(manager.status('civet'), 'disconnected');
      assert.deepEqual(faults, []);
      assert.equal(bluetoothCalls, 0);
      assert.equal(httpCalls, 0);
    });
  }
}
