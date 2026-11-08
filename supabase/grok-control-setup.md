# Grok Control

`/GROK/` is the solo player plus an owner-only remote command channel. `/SOLO/` and `/suc/` do not open that channel. The menu code is not used.

The browser keeps the 100 ms cutoff loop. A remote process never writes Bluetooth and never supplies sensor samples.

## Apply later

Do not run this against production until it has been reviewed. It is the only Grok Control migration:

`supabase/migrations/20261108210000_grok_control_realtime.sql`

It adds two policies on `realtime.messages` for broadcast topics `grok-control:<auth.uid>`. It does not alter `freq_entries` or the device-control tables.

In Realtime settings, turn **Allow public access** off. While that toggle stays on, a public channel does not consult these policies. Clients in this repo set `private: true`. See [Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization) and [Realtime settings](https://supabase.com/docs/guides/realtime/settings).

No new Supabase plan, user, or email is required. Sign in with the owner account that already exists. The browser key is the existing `PUBLISHABLE_KEY` in `app/config.js`. Do not put the service-role key in a browser or in the example client.

## Remote client

`scripts/grok-control-client.mjs` subscribes with the owner access token and optional refresh token. Those values come from the environment, not the repo. The script refuses a JWT whose `role` is `service_role`. The client refreshes the session when a refresh token is present. This chat is not connected to that channel.

## Safety the page enforces

Remote start is accepted only while this page is armed, the sensor id matches, the accepted profile permits output, and the reading is under one second old. Local Stop and local Pause disarm remote start immediately, including a start that has not finished applying. Resume stays on this page. Force cutoff uses `SessionEngine.requestRecovery` and does not change the pressure reading. A dropped network does not stop the toy and does not let an old command apply after reconnect.
