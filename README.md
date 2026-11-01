# CTMP private control

Mobile-first pressure-triggered control for Civet, Lovense Lush, DG-Lab Opossum and VacuGlide V2. This is a buildless ES-module site, served by GitHub Pages at the existing custom domain. The backend is the `ctmp-control` Supabase Edge Function.

## Run and test

```sh
npm run dev
npm test
```

The local server is for browser/UI testing. Real Bluetooth use needs a browser with Web Bluetooth support and a secure context. Simulator checks do not require connected devices.

## Application structure

- `app/main.js`: host/guest routing, calibration, keep-awake, session lifecycle, backend coordination and developer diagnostics.
- `app/engine.js`: deterministic pressure cutoff, hysteresis, cooldown and ramp state machine.
- `app/devices.js`: capped, serialized device adapters and stop-priority command handling.
- `app/ui.js` and `app/styles.css`: responsive host, guest and developer interfaces.
- `app/backend.js`: authenticated calls to the existing Supabase backend.
- `supabase/functions/ctmp-control`: server-side owner authentication, short guest links, score persistence and command validation.

`/` is the local host interface. Six-letter session paths load the guest interface through `404.html`; a guest link is a bearer credential. There is no guest account or approval screen. Ending the link invalidates guest access.

## Storage and secrets

The developer password is verified server-side against a salted password hash. It must never be added to client files, repository history or configuration served publicly. The publishable Supabase key in `app/config.js` is not a server secret.

Owner tokens and device tokens stay in page memory. A guest's session credential and client sequence are kept only in `sessionStorage` so that refreshing the guest page does not reset its connection. Calibration and pressure settings are not persisted. The browser stores only the real personal best under `ctmp.best.v2`; authenticated backend access merges that record with the server's maximum.

## Developer tests

Open **Debugging** and unlock with the privately configured password. Isolated simulation stops and disconnects physical devices before enabling test controls. Simulation has its own score, supports test guest links, and cannot update the real server record. The preview-record fixture changes only the displayed preview.

Real hardware diagnostics require a separate explicit arm step. The low-output pulse is limited to one second and always requests a stop afterward. It is unavailable during simulation or an active session. Opossum uses one selected output channel at a time, defaulting to A.

## Runtime behaviour

- The host requests a screen wake lock while visible. Hiding the host page pauses output; returning never automatically resumes it.
- Fresh pressure readings are required to start or resume. A sensor gap faults the session.
- Solo mode begins a fresh ramp after cooldown. Guest mode resumes the selected level without a ramp.
- A cooldown ends only when its timer has elapsed and a fresh reading is below the reset threshold.
- Output caps are enforced in each physical adapter, including patterns: Lush 65%, Opossum 60%, VacuGlide 35% of the device's native maximum.
- Host Stop has priority. Guest Stop during cooldown sets the desired output to zero without bypassing the timer.
- Guest commands carry a sequence and state epoch. Stale or out-of-order controls are rejected; host state is authoritative.
- Connection failures pause output where commands can still be delivered. A failed or lost connection cannot guarantee delivery of a physical stop command.

## Hardware verification still required

Automated tests and simulation validate software behaviour, not physical timing or safety. Before relying on a live session, verify the actual device models, simultaneous connections, zeroing, cap mappings, Stop delivery, Opossum channel selection, VacuGlide valve release, background interruption and network-disconnect behaviour. Do not describe a pressure threshold as proof of an orgasm or a guarantee of prevention.
