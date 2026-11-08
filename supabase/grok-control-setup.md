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

## Apply the SQL

The base file is already applied on `kmswwrfglbdbwoapusfw` as version `20261108224632`:

`supabase/migrations/20261108234500_grok_bridge.sql`

Do not apply it again. PostgREST rejects a `DELETE` that has no `WHERE` clause, and that base file has three functions which do that. Apply this follow-up only:

`supabase/migrations/20261108235500_grok_bridge_safe_delete.sql`

It replaces `grok_login_enrollment`, `grok_logout`, and `grok_clear_owner`. The locks and grants stay the same. `grok_provision_enrollment` and `grok_login_refresh` do not need a change: provision does not delete, and refresh already has a `WHERE` clause.

The base file creates private `grok_*` tables with row level security and no policies for `anon` or `authenticated`. Grants are revoked from those roles. The service role is the only database role the Edge Function uses.

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

`/GROK/` connects, calibrates, and arms with no pairing. Local Stop still wins. Remote commands stay off until the page is paired and armed again.

The long owner token stays in `GROK_TOKEN_FILE` on the bot. It is not typed into the browser. On the bot machine:

`GROK_TOKEN_FILE=/path/grok-bot.token GROK_PAIR_CODE_FILE=/path/grok-pair.txt node scripts/grok-bot.mjs pair`

That writes a 4-character code to the pair file and does not print it. Show that file on the desktop. The user types those 4 characters into Pair on `/GROK/`. The page receives its own access and refresh tokens. The bot token is not replaced. The code expires in 3 minutes, works once, and is burned after 5 wrong tries. There is no account form. Unpair leaves local control and the bot token in place.

Apply `supabase/migrations/20261109001000_grok_pair_code.sql` and redeploy `supabase/functions/grok-control`.

The bot is not connected until a host runs it:

`GROK_TOKEN_FILE=/path/grok-bot.token node scripts/grok-bot.mjs status`

`GROK_TOKEN_FILE=/path/grok-bot.token node scripts/grok-bot.mjs send stop`

`status` exits 2 when the page state is older than its lease. `send` waits up to 8 seconds for an acknowledgement. The token is not written to the output. A chat window does not receive state until this command runs.

The hosted function must be redeployed so published state keeps `lastSeq`. No SQL change is required for that. The public project coordinates are unchanged.

## Limits

The browser polls about once a second and publishes state about every 2 seconds. The function allows 90 syncs, 90 reads, and 30 commands a minute, and 8 login attempts per address each 10 minutes. Rate-limit keys are at least 8 characters, which is what `grok_rate` requires. A confirmed HTTP 401 signs the page out, disarms remote control, and pauses output. A network failure does not. Login and logout take the same database lock and re-check the session after it, so a new access token cannot be saved after revocation. A legacy service-role JWT is sent as both `apikey` and `Authorization`. An `sb_secret` key is sent only as `apikey`. This was not exercised against the hosted gateway. Request bodies are limited to 12 KB. Commands live at most 5 seconds. The page still enforces the sensor, calibration, epoch, sequence, and local Stop rules. `hardware: "not-confirmed"` means a radio write was requested, not that the toy proved it.
