import {SessionEngine} from './engine.js';

// Device I/O remains on the page: Web Bluetooth is unavailable in Workers.
// The Worker owns both the clock and session state, independent of painting.
const engine = new SessionEngine();
let sequence = 0;
let currentEpoch = 0;
const emit = (snapshot, at = Date.now(), clock = false) => self.postMessage({type: 'tick', snapshot, at, sequence: ++sequence, epoch: currentEpoch, clock});

self.onmessage = ({data}) => {
  if (!Number.isSafeInteger(data?.epoch) || data.epoch < 0) return;
  if (['start', 'stop', 'fault'].includes(data.type)) {
    if (data.epoch < currentEpoch) return;
    currentEpoch = data.epoch;
  } else if (data.epoch !== currentEpoch) return;
  const now = Date.now();
  switch (data?.type) {
    case 'config': emit(engine.configure(data.config, now), now); break;
    case 'start': emit(engine.start(now), now); break;
    case 'stop': emit(engine.stop(data.reason || '', now), now); break;
    case 'fault': emit(engine.fault(data.reason, now), now); break;
    case 'pressure': {
      const sampledAt = Number.isFinite(data.at) ? data.at : now;
      // engine.pressure checks age, order and heartbeat before changing output.
      emit(engine.pressure(data.kpa, now, sampledAt), now);
      break;
    }
    case 'snapshot': emit(engine.snapshot(now), now); break;
    default: break;
  }
};

setInterval(() => {
  const now = Date.now();
  emit(engine.tick(now), now, true);
}, 100);
emit(engine.snapshot());
