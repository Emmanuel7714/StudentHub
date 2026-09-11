# StudentHub — real full-stack app (local)

A genuine client-server app: a Node.js backend with real password hashing,
real session cookies, and real server-side persistence, serving a frontend
that talks to it over `fetch()` — not a static mockup.

## Run it

No `npm install` needed — the backend uses **only Node's built-in modules**.

```bash
node server.js
```

Then open **http://localhost:3000** in your browser.

Requires Node.js 18+ (built and tested on Node 22).

## What's real here

- **Registration & login** — passwords are hashed with `crypto.scrypt` (salted,
  never stored in plain text). Sessions are random tokens in an HttpOnly
  cookie, checked server-side on every request. Log out, close the tab,
  reopen it — you're still logged in, because the session is real.
- **Server-side validation** — faculty/department combinations are checked
  against the real UNIBEN catalog (`data/seed.json`) before an account is
  created; duplicate emails are rejected; passwords must be 6+ characters.
- **Purchases** — `POST /api/purchases` runs server-side, is idempotent
  (buying the same resource twice doesn't double-charge), and writes a real
  purchase + payment record that `GET /api/library` reads back.
- **Persistence** — everything lives in `data/db.json`, a JSON file the
  server reads and writes on every request. Restart the server and your
  account, purchases, and profile are still there.

## What's intentionally simplified

- **Payments are simulated.** There's no live Paystack/Flutterwave call —
  `POST /api/purchases` marks the payment `success` immediately. The
  comment in `server.js` right above that code marks exactly where a real
  `initialize` call and webhook-based `verify` call would go. See
  `studenthub-architecture.md` for the real flow.
- **Datastore is a JSON file, not Postgres.** Fine for local use and for
  understanding the shape of the data; swap `readDB`/`writeDB` in
  `server.js` for a real Postgres client (schema already written — see
  `studenthub-schema.sql`) before this touches real users.
- **Community, groups, and chat are still frontend-only.** Auth, the
  academic catalog, resources, and purchases are wired to the real API;
  posts/groups/messaging weren't in scope for this pass and still use the
  static demo content from the original prototype.
- **No real email.** "Verify your email" and "forgot password" links are
  not actually sent anywhere.

## Project structure

```
studenthub-app/
  server.js          — the entire backend (one file, no dependencies)
  package.json
  data/
    seed.json         — academic catalog: real UNIBEN faculties/departments,
                         plus demo courses & resources for GET205 etc.
    db.json            — created on first run; users/sessions/purchases live here
  public/
    index.html          — the frontend (landing, auth, onboarding, app shell)
```

## The academic catalog

`data/seed.json` contains the real faculty → department structure of the
University of Benin, checked against `uniben.edu`, `eng.uniben.edu`,
`envsci.uniben.edu`, and `vetmed.uniben.edu` in September 2026 — 17 entries
in total. Two of the portal's current listings (**Basic Clinical Sciences**
and **Vocational and Technical Education**) didn't have a public
department-level breakdown at the time of writing; they're included with a
`_unverified` placeholder so the gap is visible rather than guessed at —
check with the faculty directly if you need those filled in.

One correction from the original brief: **Geomatics sits in the Faculty of
Environmental Sciences**, not Engineering — confirmed on `envsci.uniben.edu`
and a UNIBEN Geomatics Engineering programme document. The seed data and the
sample GET205/GEE252/GEE222 courses reflect that.

## Next steps toward production

See `studenthub-architecture.md` for the full path: swapping in Postgres,
wiring real Paystack/Flutterwave, adding the real-time chat layer, and
deploying somewhere with a public URL (Render/Railway/Fly.io for the API,
a managed Postgres instance, and an S3-compatible bucket for the actual
PDFs).
