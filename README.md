# StudentHub

A real client-server app for UNIBEN students, plus a PDF Library/Marketplace
feature with backend-enforced access control, admin resource management,
and a clean data model ready for a Postgres + Paystack + S3 migration.

**Read `PRODUCTION_READINESS.md` first** if you're evaluating this for
production use — it's the full audit report: what's tested, what's mocked
(only one thing: password-reset email delivery), what's genuinely
untested (Postgres/S3/Paystack against real infrastructure), and the exact
next steps.

## Run it locally

```bash
node server.js
```

Open **http://localhost:3000**. No `npm install` needed for the default
setup — the core app and the Library feature's default (JSON + local disk)
backend use only Node's built-in modules.

Requires Node.js 18+ (built and tested on Node 22).

---

## What's in this project

```
studenthub-app/
  server.js                — HTTP server, route table, static file serving (thin — logic lives in routes/)
  lib/core.js               — shared session/auth/response/rate-limit helpers
  routes/
    auth.js                  — register, login, logout, session, profile, password reset
    legacyPurchases.js        — DEPRECATED original demo purchase flow (see below)
    library.js                — resource browsing, admin CRUD, file replace, archive/publish, access control
    payments.js                — purchase-intent + Paystack integration (real, untested live — see PRODUCTION_READINESS.md)
  db/
    schema.sql                — Postgres schema (users, sessions, resources, purchases)
    store.js                   — picks JSON or Postgres based on DATABASE_URL
    jsonStore.js                — default resources/purchases backend (JSON file)
    postgresStore.js            — production backend (needs `npm install pg`; untested live)
  storage/
    index.js                   — picks local-disk or S3 based on STORAGE_PROVIDER
    localAdapter.js              — dev-only PDF storage (NOT for Render/production)
    s3Adapter.js                  — production PDF storage (needs AWS SDK packages; untested live)
  public/index.html           — the whole frontend (landing, auth, app shell, Library)
  data/
    seed.json                   — real UNIBEN faculty/department catalog + demo courses
    db.json                      — created on first run; all persisted data lives here
  PRODUCTION_READINESS.md    — full audit report, route table, test results
  .env.example
  .gitignore
```

---

## The two purchase systems — read this first

This app has **two separate "unlock a resource" systems**, and that's
intentional, not leftover mess:

1. **The original demo flow** (`routes/legacyPurchases.js`:
   `POST /api/purchases`, `GET /api/library`, the "My Library" nav item) —
   unchanged from before the Library feature was added. It simulates
   instant payment success against the hardcoded demo resources in
   `data/seed.json`. Kept working on purpose rather than silently broken —
   see `PRODUCTION_READINESS.md` for the consolidation plan for when this
   should actually be retired.

2. **The new Library/Marketplace** (`routes/library.js` + `routes/payments.js`,
   the "Library" nav item) — built with a real database
   model, real admin-managed PDFs, real backend-enforced access control,
   and **no fake payment success**. A paid resource stays locked
   (`402 Payment Required`) until a real payment is confirmed — which isn't
   wired up yet (see the Paystack section below).

If you go on to build real payments, the natural next step is retiring #1
and moving everything onto #2's model.

---

## Feature 2 in detail: Library/Marketplace

### Data model

See `db/schema.sql` for the full DDL. Three tables (plus `sessions`, shared
with the rest of the app):

- **users** — has a `role` column (`student` | `admin`)
- **resources** — title, courseCode, courseName, faculty, department, level,
  description, accessType (`free`|`paid`), priceKobo, storageProvider,
  storageKey, originalFilename, fileSizeBytes, uploadedBy, timestamps.
  **`storageKey` and `storageProvider` are never sent to the client** — see
  `publicResource()` in `routes/library.js`.
- **purchases** — userId, resourceId, status (`pending`|`success`|`failed`),
  provider, providerReference, amountKobo, timestamps. Starts `pending` and
  is only ever flipped to `success` by a real payment confirmation.

**Storage default is JSON** (`data/db.json`, under its own `resources` and
`libraryPurchases` keys — separate from the original app's `users`/
`sessions`/`purchases`/`payments` arrays, no collisions). Set `DATABASE_URL`
to switch to Postgres — nothing else in the app needs to change, because
everything goes through `db/store.js`'s interface.

### API endpoints

The full route table (all endpoints, methods, and who can access them) is
in `PRODUCTION_READINESS.md` — kept in one place there so it can't drift
out of sync with this file. Quick summary of the Library-specific ones:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/resources` | none | Browse/search/filter (`?q=`, `?faculty=`, `?department=`, `?level=`). Published only |
| GET | `/api/resources/:id` | none | Resource detail (metadata only). Published only |
| GET | `/api/resources/:id/access` | **required** | The only route that ever returns file bytes — see below |
| GET | `/api/admin/resources` | **admin** | Full listing including archived, plus purchase count/revenue per resource |
| POST | `/api/admin/resources` | **admin** | Upload a new PDF resource |
| PUT | `/api/admin/resources/:id` | **admin** | Edit metadata (not the file) |
| PUT | `/api/admin/resources/:id/file` | **admin** | Replace the file (new version); old file deleted only after the new one's in place |
| DELETE | `/api/admin/resources/:id` | **admin** | Archives if any purchase references it, otherwise hard-deletes |
| POST | `/api/resources/:id/purchase-intent` | **required** | routes/payments.js — atomic find-or-create, calls Paystack if configured |
| POST | `/api/webhooks/paystack` | signature-verified | routes/payments.js — see Payments section below |

### Access control (the part that matters most)

`GET /api/resources/:id/access` is the **only** place a PDF's bytes are
ever reached from, and it's enforced entirely server-side:

1. Not logged in → `401`.
2. Resource is `free` → any logged-in user is authorized.
3. Resource is `paid` → looks up a `purchases` row for this user+resource
   with `status = 'success'`. No such row → `402 Payment Required`, and
   the response body is just the price — never a file URL, never the
   storage key.
4. Authorized → if the storage adapter supports presigned URLs (S3), the
   server 302-redirects to a short-lived (5 minute) signed URL; if not
   (local disk), the server streams the bytes through itself with
   `Content-Type: application/pdf` and `Cache-Control: private, no-store`.

The frontend never decides access — it just calls this endpoint and shows
whatever the server says. Disabling JavaScript or forging a request
directly changes nothing.

### Upload validation

- **PDF content is checked, not the filename or extension** — the decoded
  file must start with the `%PDF-` magic bytes or the upload is rejected
  (400), regardless of what it's named or what `Content-Type` claims.
- **Max size**: `MAX_PDF_MB` env var, default 15MB. Oversized uploads get a
  clean `413`.
- **Storage keys are always server-generated** (`resources/<uuid>.pdf`) —
  the original filename is kept only as sanitized display text
  (`sanitizeFilename()` in `routes/library.js`), never used to build a
  path or storage key.
- **Metadata is escaped** before being echoed back (`escapeHtml()` in
  `lib/core.js`), so a title/description can't inject HTML into the admin
  list or the Library grid.

### Why the upload is base64 JSON, not multipart/form-data

The rest of this app (avatar upload) already reads files as base64 via
`FileReader` and posts them as JSON — this feature follows the same
pattern instead of introducing a hand-rolled multipart parser (which is
easy to get subtly wrong for binary data). The trade-off: base64 inflates
the request body by ~33%, so the body-size cap for this route is set
higher than the rest of the app's (`MAX_PDF_MB * 1.4`, see
`routes/library.js`). If you outgrow this — very large PDFs, lots of
concurrent uploads — switching to true multipart streaming is the
natural next step.

### Admin access

There's no admin management UI (out of scope for this pass). Two ways to
get an admin account:

**Option A — env vars (recommended):** set `ADMIN_EMAIL` and
`ADMIN_PASSWORD` before starting the server. On every startup, that
account is created if it doesn't exist yet, or promoted to `admin` if it
already exists as a student. See `.env.example`.

**Option B — manual:** register a normal account through the app, stop the
server, open `data/db.json`, find your user object, and change
`"role": "student"` to `"role": "admin"`. Restart.

---

## Payments: real architecture, untested against live Paystack

Per the task's explicit instruction, **no fake payment confirmation** is
used. `routes/payments.js` implements the real flow:

- `purchases.status` starts `pending` and only a verified confirmation
  ever sets it to `success`.
- `POST /api/resources/:id/purchase-intent` is atomic (`findOrCreatePurchase`
  — see `PRODUCTION_READINESS.md` for the race condition this fixes) and,
  when `PAYSTACK_SECRET_KEY` is set, calls Paystack's real
  `POST /transaction/initialize` and returns `authorizationUrl` for the
  client to redirect to. Without that key set, it behaves as a stub:
  creates the `pending` purchase, returns 202 saying payment isn't
  connected yet — access stays locked either way.
- `POST /api/webhooks/paystack` verifies the `x-paystack-signature` header
  (HMAC-SHA512 over the raw body — never the parsed/re-serialized JSON,
  which isn't guaranteed to match byte-for-byte) before trusting anything
  in the payload, then independently calls Paystack's
  `GET /transaction/verify/:reference` — the payload's own "it succeeded"
  claim is never trusted alone. Only then does a purchase get marked
  `success`. Idempotent on `providerReference`, so a duplicate webhook
  delivery (which Paystack's own docs say can happen) doesn't double-process.

**What's tested**: the signature-rejection paths (no signature, forged
signature) and the no-key-configured stub path — all verified against the
running server. **What's not tested**: an actual call to Paystack's
initialize/verify endpoints, or a real webhook delivery — this environment
has no network access and no Paystack account. See
`PRODUCTION_READINESS.md` for exactly what to do before trusting this with
real money.

---

## File storage

**Default: local disk** (`storage/localAdapter.js`), writing to
`private-uploads/` — outside `public/`, so nothing there is ever directly
web-servable; only the authenticated `/access` route reads from it. This
is fine for local development and testing, but **do not use it on Render or
any host with an ephemeral filesystem** — a redeploy or restart wipes it.

**Production: S3-compatible** (`storage/s3Adapter.js`). Works with AWS S3
directly, or Cloudflare R2 / Backblaze B2 / DigitalOcean Spaces via
`S3_ENDPOINT`. Requires:

```bash
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

Then set `STORAGE_PROVIDER=s3` plus the `S3_*` env vars in `.env.example`.

**I could not test `s3Adapter.js` against a real bucket** — the environment
this was built in has no network access or cloud credentials. It's written
carefully and follows the documented AWS SDK v3 API, but treat it as
unverified until you've run it against a real bucket yourself.

---

## Environment variables

See `.env.example` for the full annotated list. Summary:

| Variable | Required? | Default behavior if unset |
|---|---|---|
| `PORT` | no | `3000` |
| `NODE_ENV` | no | `development` — affects Secure cookie flag and password-reset dev-token exposure; set to `production` when deployed |
| `SESSION_MAX_AGE_DAYS` | no | `30` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | no, but you need one to reach admin features | No admin account created — use the manual db.json method instead |
| `DATABASE_URL` | no | Uses the local JSON store |
| `STORAGE_PROVIDER` | no | `local` (dev-only disk storage) |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | only if `STORAGE_PROVIDER=s3` | — |
| `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE` | only for non-AWS S3-compatible providers | — |
| `MAX_PDF_MB` | no | `15` |
| `PAYSTACK_SECRET_KEY` | no | Purchases stay in "not connected yet" stub mode — see Payments section |

---

## Local testing instructions

Zero-setup path (JSON store + local disk storage):

```bash
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=yourpassword node server.js
```

Then:
1. Open `http://localhost:3000`, register a normal student account.
2. In a separate browser (or incognito), log in as
   `admin@example.com` / `yourpassword`.
3. As admin: go to **Admin** in the sidebar → fill out **Upload a PDF
   resource** → pick a real PDF file → submit.
4. As the student: go to **Library** in the sidebar → search/filter → open
   the resource you uploaded → **Open PDF** works instantly if it's free,
   or shows a clean "payment required" message if it's paid.
5. Try uploading a non-PDF file (rename a `.txt` to `.pdf`) as admin — it
   should be rejected with "File does not look like a valid PDF."

To test the Postgres path: install `pg`, run `psql "$DATABASE_URL" -f
db/schema.sql`, set `DATABASE_URL`, restart, repeat the same steps.

To test the S3 path: install the AWS SDK packages, set `STORAGE_PROVIDER=s3`
and the `S3_*` vars, restart, repeat the same steps — the "Open PDF" action
should redirect to a signed S3 URL instead of streaming from the server.

---

## Render deployment instructions

1. Push this project to a Git repository.
2. In Render, create a **Web Service** from that repo.
   - Build command: `npm install` (only actually installs anything if you
     added `pg`/AWS SDK packages to `package.json` — see below)
   - Start command: `node server.js`
3. **Do not rely on local disk storage on Render** — its filesystem is
   ephemeral. Set `STORAGE_PROVIDER=s3` and the `S3_*` env vars in Render's
   dashboard, using a real S3-compatible bucket.
4. **Do not rely on the JSON store for anything you care about keeping** —
   `data/db.json` also lives on that same ephemeral filesystem. Provision a
   Postgres instance (Render has a managed Postgres offering), run
   `db/schema.sql` against it, and set `DATABASE_URL`.
5. Set `ADMIN_EMAIL`/`ADMIN_PASSWORD` in Render's environment variables so
   an admin account exists on first boot.
6. If you added `pg` and/or the AWS SDK packages, make sure they're listed
   in `package.json`'s `dependencies` (see note below) so Render's build
   step actually installs them.

**Note on `package.json`:** it intentionally lists no dependencies right
now, so the zero-setup local experience keeps working for anyone who
hasn't opted into Postgres/S3. Before deploying with `DATABASE_URL` and/or
`STORAGE_PROVIDER=s3` set, run:

```bash
npm install pg @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

which will add them to `package.json` for you — commit that change.

---

## Limitations and assumptions (please read before relying on this)

**See `PRODUCTION_READINESS.md` for the complete, current audit** — full
route table, exactly what's tested vs. untested, and next steps. Summary:

- **Postgres and S3 code paths are untested against real infrastructure**
  — no network access was available where this was built. The JSON store +
  local disk path, and the webhook signature-verification logic, **were**
  fully tested end-to-end against the running server.
- **No real payments yet, but the real architecture is built** — Paystack
  initialize/verify/webhook code is written and the rejection paths are
  tested; the actual calls to Paystack's servers are not (no account/network
  here). See the Payments section above.
- **File replacement IS supported** (`PUT /api/admin/resources/:id/file`)
  — this used to be a limitation, fixed in the production-hardening pass.
- **No admin management UI** — admin accounts are created via env vars or
  by hand-editing `data/db.json`. Fine for a single admin; not fine for a
  team. `moderator`/`super_admin` roles exist in the schema but nothing
  uses them yet — needs a product decision on their actual permissions.
- **Base64 JSON upload, not streaming multipart** — simpler and consistent
  with the rest of the app, but costs ~33% more bandwidth/memory than a
  true multipart upload. Revisit if file sizes grow significantly.
- **The two purchase systems are genuinely separate**, as explained above
  — not an oversight. See `PRODUCTION_READINESS.md` for the consolidation plan.
- **Rate limiting is in-memory, per-process** — fine for one server
  instance, needs a shared store (Redis) before scaling to multiple.
- **Password reset email is not actually sent** — token mechanics are real;
  there's no email provider wired up. Dev mode returns the token directly.
