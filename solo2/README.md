# SOLO 02

A buildless personal device-control studio. Open `https://ctmp.uk/solo2/`; use `?test=1` for a completely simulated session. No installation, build, account, application backend, analytics, remote fonts or third-party JavaScript. Vacuglide hardware control uses the manufacturer's cloud API.

## Use

1. Choose Lush Mini, Opossum or Vacuglide. Optionally enable Civet.
2. Connect each selected device. Bluetooth requires a supported browser and HTTPS. For Vacuglide, paste a device token and enable the device's online mode. Remembering the token is opt-in.
3. Capture Civet's **latest single sample** at Zero, Baseline, Half and Full, or enter the readings manually. Cutoff defaults to 20.50 kPa until calibration; entering Half and Full calculates their midpoint. An explicitly edited cutoff stays manual until “Use calculated midpoint”. Zero is a reference value, not an offset subtracted from the raw kPa readings.
4. Open Session, select a pattern and limits, then Start. Pressure at/above cutoff zeroes output, increments the edge count once, and begins a random whole-second rest within the chosen bounds. Output resumes after rest only when pressure is below cutoff. Held pressure does not generate repeated edges.
5. Stop immediately invalidates pending session commands and prioritizes zero output. Escape also stops an active session (unless the pattern dialog is open). Changing setup stops the session. Reconnection restores zero output and requires another Start.

Each Start begins a new timer and edge count; Stop preserves the last displayed values until then. All settings use the `solo2.settings.v1` localStorage key. A remembered token uses `solo2.token.v1`; without that option it exists only for this page visit. Nothing is shared with `/solo/` or `/suc/` storage.

## Test mode

Test mode never opens Bluetooth or calls Autoblow. The selected toy and sensor connect as simulations. All six combinations work. Use **Run a demo loop**, or Start and move the virtual Civet slider past the cutoff. Release below it while resting to observe automatic resume. The demo uses the configured rest interval, not an accelerated hidden interval. With Civet disabled the toy runs until Stop.

Opossum includes 22 data-driven dual-channel patterns and Lush includes 12. Random pools persist independently, omit excluded patterns, and avoid consecutive repeats when at least two remain. Selecting None is allowed, but blocks Random Start until a pattern is included.

## Control architecture and limits

- `engine.js`: pure session state machine, capture-time sensor freshness, rest/held-pressure behavior and output envelopes.
- `clock.worker.js`: 100 ms Worker loop. Epochs invalidate old run messages. Only clock ticks and transitions request positive hardware output; incoming pressure can request zero immediately.
- `devices.js`: serialized latest-command Bluetooth queue, prioritized zero, reconnect at zero, fresh Civet subscriptions, and authenticated/allowlisted Vacuglide requests.
- `protocol.js`: self-contained packet encoders and signed pressure parser.
- `patterns.js`: add a catalogue recipe to expose it automatically in the selector and Random pool.
- `app.js`, `styles.css`, `index.html`: UI, charts, local settings and fallback timer.

The Opossum hardware ceiling defaults to 40% (80 of 200); session Max power scales within it. Lush maps its 0–100% envelope to native 0–20. Vacuglide Max speed is the actual 0–100 API ceiling, initially 35; stroke buttons send brief valve adjustments, and do not claim an absolute measured stroke length.

**Browser limitations:** Web Bluetooth is exposed on the window, not a Worker. The Worker handles scheduling and state, while Bluetooth writes necessarily run on the page. Ordinary tab visibility changes do not pause control. A missed Opossum heartbeat over 500 ms, a stale queued Worker tick, or missing Civet samples over 1500 ms faults the session. Optional screen wake lock is requested during sessions; it cannot prevent all operating-system suspension. The fallback timer is clearly marked and should be used with the tab visible. Closing, discarding, freezing, loss of radio, or losing the network can prevent software from delivering zero; physical controls remain the final stop mechanism. Cloud Stop is sent immediately and repeated after in-flight speed writes, but network actuation is never instantaneous or guaranteed.

**Hardware validation:** no real devices are available in the development environment. Protocol and transport behavior is covered by tests; actual firmware/device compatibility still needs a low-output hardware check. Lovense includes the existing repo's UART profiles, which can vary by firmware. DG LAB's official protocol identifies Opossum as a **vibration controller**, not an electrical stimulation unit.

## Verification

From the repository root:

```sh
node --test solo2/tests/*.test.mjs
```

Tests cover protocol byte offsets and caps, prioritized Stop, disconnect/reconnect, token-origin validation, in-flight HTTP Stop ordering, valve closure, all patterns, non-repeating selection, exact rest boundaries, held pressure, stale samples, heartbeat faults and Worker message epochs.

All imports and assets are relative to `/solo2/`. No service worker or root deployment/config changes are required. GitHub Pages serves the folder's `index.html` directly.

## Protocol references

- [DG LAB Opossum protocol](https://github.com/dungeonlab-open/dglab-bluetooth-protocol/blob/main/opossum-vibrate-controller/README.md)
- [DG LAB Civet protocol](https://github.com/dungeonlab-open/dglab-bluetooth-protocol/blob/main/civet-edging-sensor/README.md)
- [Vacuglide HTTP API](https://developers.autoblow.com/reference/http-api-v1-vacuglide/)
- [Web Bluetooth availability and Worker limitations](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API)
