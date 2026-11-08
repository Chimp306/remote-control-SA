# Grok Control

`/GROK/` is the solo player plus an owner-only remote command channel. `/SOLO/` and `/suc/` do not open that channel. The menu code is not used.

The browser keeps the 100 ms cutoff loop. A remote process never writes Bluetooth and never supplies sensor samples.

## Apply later

Do not run this against production until it has been reviewed. It is the only Grok Control migration:

`supabase/migrations/20261108210000_grok_control_realtime.sql`

It adds two policies on `realtime.messages` for broadcast topics `grok-control:<auth.uid>`. It does not alter `freq_entries` or the device-control tables.

In Realtime settings, turn **Allow public access** off. While that toggle stays on, a public channel does not consult these policies. Clients in this repo set `private: true`. See [Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization) and [Realtime settings](https://supabase.com/docs/guides/realtime/settings).

No new Supabase plan, user, or email is required. Sign in with the owner account that already exists. The browser key is the existing `PUBLISHABLE_KEY` in `app/config.js`. Do not put the service-role key in a browser or in the example client.

## Sign-in

`/GROK/` has an email and password form until an owner is signed in, then a Sign out button. It uses `signInWithPassword` and does not send an email link, so it does not depend on a redirect URL. The account must already exist. This page cannot create one. Create or reset that account in the Supabase Auth dashboard. The session is stored under `ctmp-grok-auth`, separate from FREQ. A failed sign-in shows one fixed sentence for a rejected password, a network failure, or any other failure. The page does not echo the password, the email, or a token. Signing out, losing the session, or switching accounts disarms remote control and pauses output immediately. The channel generation changes before the next network call, so a callback from the previous account cannot apply.

## Events

The page publishes two broadcast names on the owner topic:

- `state`, about every 2 seconds while armed. One current pressure sample, phase, cutoff, edge count, pattern, and commanded percentages. This is not a high-rate history.
- `event`, at a transition. `event` is `edge`, `cutoff`, `pattern`, `session`, or `fault`. Each has `id`, `at`, `sessionId`, and `epoch`. An edge, a cutoff change, a pattern change, arming, disarming, pause, stop, sign-out, and a fault each publish one event. Pressure on an event is the single current sample. It is not a medical or clench status.
- `ack`, after a command is judged. `accepted` means the envelope was allowed. `applied` means the local engine entered the requested phase or setting. `hardware: "not-confirmed"` means a radio write was requested and the toy did not prove it. `not-sent` means the write was not requested. A remote stop or pause disarms or latches itself; that self-effect is still reported as applied when the engine reached the requested phase. A newer local session is not stopped by an older start.

## Remote client

Dry run, with no credentials and no network:

`GROK_DRY_RUN=1 node scripts/grok-control-client.mjs`

Live owner session, values only in the environment:

`SUPABASE_URL=... SUPABASE_PUBLISHABLE_KEY=... GROK_OWNER_ACCESS_TOKEN=... node scripts/grok-control-client.mjs`

The optional `GROK_OWNER_REFRESH_TOKEN` lets the Supabase client refresh the session. The script refuses a JWT whose `role` is `service_role`. It prints state, event, and ack summaries as JSON lines. Send one command per stdin line, for example `{"command":"pause"}` or `{"command":"changePattern","params":{"pattern":"sine-wave"}}`. A command that arrives before the first state, or while the page is disarmed, prints one error line and the process keeps reading. The error does not include the input line. The adapter fills `seq`, `sessionId`, `epoch`, `issuedAt`, and `expiresAt` from the latest state. A chat window does not receive that stream until a host runs this adapter, or an equivalent tool, with the owner token. The page compares the channel generation and owner id, so an acknowledgement is published for the live channel even though the callback token and the page binding are different objects. A replaced channel does not run or acknowledge a command that arrives on the old one.

Command envelope:

```json
{"v":1,"id":"…","seq":1,"sessionId":"…","epoch":1,"issuedAt":0,"expiresAt":5000,"command":"start","params":{}}
```

`command` is `start`, `stop`, `pause`, `changePattern`, `forceCutoff`, `adjustCutoff`, or `setDowntime`. `changePattern` takes `params.pattern`. `adjustCutoff` takes `params.delta` of `0.1` or `-0.1`. `setDowntime` takes integer `params.min` and `params.max`.

Ack:

```json
{"v":1,"type":"ack","commandId":"…","seq":1,"sessionId":"…","epoch":1,"accepted":true,"applied":true,"hardware":"not-confirmed","reason":""}
```

Event:

```json
{"v":1,"type":"event","event":"edge","id":"…","at":0,"sessionId":"…","epoch":1,"phase":"cooldown","edgeCount":1,"pattern":"synchronized","sensorFresh":true,"pressureKpa":0.2,"threshold":0.2,"resetThreshold":0.19,"outputPercentA":0,"outputPercentB":0}
```

## Safety the page enforces

Remote start is accepted only while this page is armed, the sensor id matches, the accepted profile permits output, and the reading is under one second old. Local Stop and local Pause disarm remote start immediately, including a start that has not finished applying. Resume stays on this page. Force cutoff uses `SessionEngine.requestRecovery` and does not change the pressure reading. A dropped network does not stop the toy and does not let an old command apply after reconnect.
