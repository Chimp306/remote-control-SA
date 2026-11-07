# FREQ account store

FREQ is a personal log of a date, a count, and an optional short note. The page at `/FREQ/` uses Supabase Auth and the `public.freq_entries` table. It does not use the menu code, guest links, or the `ctmp-control` function.

The migration in this repo has not been applied by the coding agent. This environment has no Supabase CLI, no `SUPABASE_ACCESS_TOKEN`, and no database URL. Do not paste the service-role key or a database password into the repository, a chat, or the site.

## What is already public

- Project URL origin comes from `API_URL` in `app/config.js`.
- The publishable key in that file is the browser key. It is not an owner password and it must not be treated as permission to read every row.
- Device-control tables stay behind `ctmp-control` and `service_role`.

## Apply the table

Run `supabase/migrations/20261107224500_freq_entries.sql` in the existing project's SQL editor, or with the Supabase CLI as the project owner (`supabase db push` against project ref `hqciviafxtfescteyvnn`). That creates only `public.freq_entries`.

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
