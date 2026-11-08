# Grok Control bridge

`/GROK/` is the solo player plus an owner-only command bridge. `/SOLO/` and `/suc/` do not open it. The browser keeps the 100 ms cutoff loop. A remote process never writes Bluetooth.

This bridge is for the fresh project `ctmp-grok` only:

| | |
| --- | --- |
| Project ref | `kmswwrfglbdbwoapusfw` |
| API URL | `https://kmswwrfglbdbwoapusfw.supabase.co` |
| Function | `https://kmswwrfglbdbwoapusfw.supabase.co/functions/v1/grok-control` |
| Publishable key | `sb_publishable_mnNJB7hsFVUnpo_ikIxXxA_OYuPBKl8` in `app/grok-public.js` |

The publishable key is public. It cannot read the tables. Do not put a secret key, a service-role key, or an owner token in the repository or in chat.

The old project and `app/config.js` stay as they are. Do not apply this SQL there. Do not apply the older migration files, including `20261108210000_grok_control_realtime.sql`, to `ctmp-grok`. Realtime is not used. Supabase Auth email and redirect settings are not used.

## Apply this SQL only

`supabase/migrations/20261108234500_grok_bridge.sql`

It creates private `grok_*` tables with row level security and no policies for `anon` or `authenticated`. Grants are revoked from those roles. The service role is the only database role the Edge Function uses.

## Deploy the function

Deploy `supabase/functions/grok-control/index.ts` with `verify_jwt` false.

`verify_jwt` only accepts legacy JWT API keys. This project authenticates with an owner token inside the function, and the platform secret key is not a JWT. The same setting is recorded in `supabase/config.toml`.

The platform injects these environment variables. Do not copy them into the function source or the browser:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEYS` (JSON object; the function reads the `default` secret)
- `SUPABASE_SERVICE_ROLE_KEY` (legacy fallback, also injected)

Database calls send that key on the `apikey` header only.

Files to deploy together: `index.ts` and `bridge.mjs`.

## One-time enrollment

After the SQL is applied, a privileged SQL session runs:

`select public.grok_provision_enrollment();`

The result is a 64-character hex code. It is shown once, to that SQL session. The database stores only its SHA-256 digest. The code expires in 24 hours and works once.

Copy it into a password manager or the private handoff. Do not paste it into chat, git, or the function. There is no public “first caller becomes owner” route. Until this statement has been run, login fails.

If a live owner session must be replaced, run `select public.grok_clear_owner();` and then provision again. That deletes the bridge session, state, commands, events, and acknowledgements.

## Using it

On `/GROK/`, paste the enrollment code once. The page stores a refresh token in `ctmp-grok-refresh-v1` and shows a bot token once. Put that bot token in `GROK_REFRESH_TOKEN`. Do not send it in chat.

The access token lasts 15 minutes and stays in memory. The refresh token lasts 30 days. The browser and the bot can both sign in with it; each receives its own access token. Sign-out revokes the refresh token and every access token. A new enrollment code is then required.

Bot, values only in the environment:

`GROK_FUNCTION_URL=https://kmswwrfglbdbwoapusfw.supabase.co/functions/v1/grok-control GROK_PUBLISHABLE_KEY=sb_publishable_mnNJB7hsFVUnpo_ikIxXxA_OYuPBKl8 GROK_REFRESH_TOKEN=... node scripts/grok-control-client.mjs`

A secret key or service-role JWT is refused. One stdin line sends one command, for example `{"command":"pause"}`. A command before the first state, or while the page is disarmed, prints an error and the process keeps reading.

Dry run, with no credentials:

`GROK_DRY_RUN=1 node scripts/grok-control-client.mjs`

## Limits

The browser polls about once a second and publishes state about every 2 seconds. The function allows 90 syncs, 90 reads, and 30 commands a minute, and 8 login attempts per address each 10 minutes. Request bodies are limited to 12 KB. Commands live at most 5 seconds. The page still enforces the sensor, calibration, epoch, sequence, and local Stop rules. `hardware: "not-confirmed"` means a radio write was requested, not that the toy proved it.
