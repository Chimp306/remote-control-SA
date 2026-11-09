# CTMP

Static site for ctmp.uk. There is no backend.

- `/` is a short cover. The menu opens when the typed value hashes to the digest in `app/gate.js`. `/solo/` and `/suc/` open without it.
- `/solo/` is the manual control app: one stimulation toy (Lush Mini, Opossum, or Vacuglide), optionally with the Civet sensor.
- `/suc/` is unchanged.
- `/SOLO/` redirects to `/solo/`.

```sh
npm test
npm run dev
```

Civet pressure is the DG-LAB D0 int16 at bytes 8–9, divided by 100, in kPa. Opossum output is capped at 40% of the 0–200 scale unless you raise the ceiling. VacuGlide uses Autoblow’s HTTP API with a device token; the API allows browser calls.
