# FREQ account store

FREQ is a personal log of a date, a count, and an optional short note. The page at `/FREQ/` uses Supabase Auth and the `public.freq_entries` table. It does not use the menu code, guest links, or the `ctmp-control` function.

The migration in this repo has not been applied by the coding agent. This environment has no Supabase CLI, no `SUPABASE_ACCESS_TOKEN`, and no database URL. Do not paste the service-role key or a database password into the repository, a chat, or the site.

## Public client config

The browser already has everything it needs. No new key belongs in the repo.

| Setting | Value |
| --- | --- |
| Project URL | `https://hqciviafxtfescteyvnn.supabase.co` |
| Browser key | Existing `PUBLISHABLE_KEY` in `app/config.js` |
| Where the URL comes from | Origin of `API_URL` in that same file |
| Script | `/app/freq.js`, library `@supabase/supabase-js@2.49.1` |
| Auth storage key | `ctmp-freq-auth` (separate from the classic host key) |
| Auth flow | PKCE, session persisted, redirect `/FREQ/` |
| Magic link | `shouldCreateUser: false` |
| Table | `public.freq_entries` through `/rest/v1/freq_entries` |
| Columns read | `id`, `user_id`, `occurred_on`, `count`, `note`, `created_at` |
| Columns written | `occurred_on` (`YYYY-MM-DD`), `count` (0–99), `note` (at most 280 characters), `user_id` |
| Not used | `ctmp-control`, guest links, the menu code, the service-role key |

Device-control tables stay behind `ctmp-control` and `service_role`.

## Auth settings outside this SQL file

These are project Auth settings, not rows in `freq_entries`. The connector or dashboard can set them. This agent must not create the user or send mail.

- Turn off public sign-ups so the publishable key cannot register a stranger.
- Create one confirmed user for Steve in the dashboard. Choose the email and password there.
- If magic links will be used, allow redirect URLs `https://ctmp.uk/FREQ/` and `http://127.0.0.1:4173/FREQ/`. Password sign-in does not need a redirect URL.

## Apply the table

The parent connector should apply this one file after review:

`supabase/migrations/20261107224500_freq_entries.sql`

It is the only FREQ migration. It has not been applied. Do not run a second copy alongside it. The coding agent will not apply it. The file creates only `public.freq_entries` and its trigger. It does not alter `ctmp_v2_*` tables or `ctmp-control`.

The migration:

- enables and forces row level security
- revokes `anon` and `service_role`
- grants select, insert, update, and delete to `authenticated` only
- allows a row only when `user_id` equals `auth.uid()`
- stamps `user_id` from `auth.uid()` on insert and update

`service_role` bypasses row level security on Supabase even after this revoke if a later grant is added. Do not add a FREQ action to `ctmp-control`, and do not put the service-role key in the browser.

## Create the account

In Authentication for this project, create one user for Steve in the dashboard. Set the password there, or send a sign-in link from the dashboard. This repository does not choose an email and does not send mail.

Turn off public sign-ups so the publishable key cannot register a stranger. The page asks for a magic link only with "create user" disabled.

If magic links will be used, allow these redirect URLs:

- `https://ctmp.uk/FREQ/`
- `http://127.0.0.1:4173/FREQ/` for local checks

Password sign-in does not need a redirect URL.

## How to tell that it is live

Until the table exists, `/FREQ/` says storage is not set up and shows no entry form. After the migration, the same page asks for the account. A failed save, a missing table, or an offline browser is labeled as not saved.

No purchase or plan change is required for this table. If the project is on the published Free plan, Supabase pauses it after one week without activity. Confirm the current plan in the dashboard before relying on the log.
