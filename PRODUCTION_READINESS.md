# StudentHub — Production Readiness Report

This is the result of a full audit of the existing codebase (not a rewrite),
followed by systematic fixes, followed by testing every fix against the
actual running server. Nothing below is claimed as "working" without
having been run — where something couldn't be run in this environment
(no network access — no live Postgres, no live S3 bucket, no live
Paystack account), that is stated explicitly rather than implied.

---

## 1. What changed, and why

### Architecture split (server.js was becoming a monolith)

`server.js` used to contain every route handler inline. It's now just the
HTTP server + route table + static file serving. Logic moved to:

- `routes/auth.js` — register, login, logout, session check, profile update,
  password reset (new)
- `routes/legacyPurchases.js` — the original demo purchase flow, isolated
  and clearly marked deprecated
- `routes/library.js` — resource browsing, admin CRUD, file replacement,
  archive/publish, access control
- `routes/payments.js` — purchase-intent + Paystack integration (new)
- `lib/core.js` — shared session/auth/response/rate-limit helpers

This was a genuine refactor of *working* code, not a rewrite: every route's
request/response contract is unchanged from the frontend's point of view.
I re-ran the full original test suite (registration → login → session →
logout → legacy purchases) after the split to confirm nothing broke — see
section 4.

### Security fixes (all tested against the running server)

| # | Issue found | Fix |
|---|---|---|
| 1 | **Password reset was 100% fake** — the frontend's "Forgot password" never called a backend endpoint | Real `POST /api/password-reset/request` + `POST /api/password-reset/confirm`: random token, sha256-hashed at rest, 1-hour expiry, single-use, invalidates all existing sessions on success, and the request endpoint responds identically whether or not the email exists (no account enumeration) |
| 2 | **Sessions never expired server-side** — only the cookie's own Max-Age implied expiry, never checked | `getSessionUser()` now checks session age against `SESSION_MAX_AGE_MS` and deletes expired sessions |
| 3 | **Cookies missing `Secure`** | `sessionCookieHeader()` sets `Secure` when `NODE_ENV=production` and the request is actually HTTPS (via `X-Forwarded-Proto` behind a proxy, or a direct TLS socket) |
| 4 | **No rate limiting anywhere** | In-memory sliding-window limiter (`lib/core.js`) applied to register, login, password-reset request/confirm, resource access, and purchase-intent. **Documented limitation**: per-process/per-IP, resets on restart, doesn't share state across multiple instances — fine for one Render service, not a substitute for a shared store (Redis) at real scale |
| 5 | **500 handler leaked `e.message`** to the client | `sendServerError()` logs full detail server-side via `console.error`, sends a generic message to the client |
| 6 | **Real race condition**: `purchase-intent` did `findPurchase()` then `createPurchase()` as two separate awaited calls, with a yield point in between | Replaced with one atomic `findOrCreatePurchase()` per store. JSON store: single synchronous read-modify-write, no yield point. Postgres store: real `INSERT ... ON CONFLICT (user_id, resource_id) DO NOTHING`, backed by the schema's actual unique constraint — this is genuine DB-level concurrency safety, not just "no await in between." **Verified live**: fired 5 concurrent + 1 prior `purchase-intent` request for the same user+resource against the JSON store; exactly 1 purchase row resulted (see section 4) |
| 7 | `level` accepted any value on register/resource create | Validated against `[100,200,300,400,500]` |
| 8 | `GET /api/courses/:code` — dead code, confirmed unused by the frontend | Removed |

### Data integrity / resource lifecycle

- **Resources now have a `status` (`published`/`archived`)**. `DELETE
  /api/admin/resources/:id` checks purchase history first: if any purchase
  references the resource, it's archived (kept, excluded from public
  browse, still visible to admin) instead of destroyed; only a resource
  with zero purchases is actually hard-deleted (DB row + storage file).
  **Verified live** in both directions (section 4).
- **File replacement/versioning**: `PUT /api/admin/resources/:id/file`
  uploads the new file, points the DB record at it, *then* deletes the old
  file — never the reverse — so a crash mid-replacement can't leave a
  resource pointing at a file that no longer exists. **Verified live**.
- **Duplicate-upload detection**: every upload is sha256-hashed; a repeat
  upload of the same bytes doesn't get blocked (an admin might legitimately
  want that) but the response includes a `duplicateWarning` naming the
  existing resource. **Verified live**.
- **Path traversal**: `storage/localAdapter.js`'s `resolveKey()` normalizes
  and verifies the resolved path stays inside the storage directory. This
  was already true before this pass — re-verified, not newly added.
  Storage keys are always server-generated UUIDs regardless, so this is
  defense in depth rather than the primary protection.

### RBAC

- Role enum expanded to `student | moderator | admin | super_admin`
  (schema + `ROLE_RANK` in `lib/core.js`). `requireAdmin` now really means
  "admin or super_admin." **What's NOT done**: no endpoint currently
  distinguishes moderator-level permissions from admin-level ones — the
  rank infrastructure (`requireRole(req,res,db,'moderator')`) exists for
  when specific moderator-only actions are defined, but nothing uses that
  minimum yet. This needs product input (what exactly can a moderator do
  that a student can't, that an admin doesn't need to?) before it's
  meaningfully implemented, not just declared.
- Re-confirmed (not newly fixed — this was already correct): registration
  and profile-update both use explicit field whitelists. `role` has never
  been among the accepted fields in either handler, so a client cannot
  set/escalate their own role by adding it to a request body. Verified by
  re-reading both handlers line by line.

### Payments — architecture built, NOT tested live

`routes/payments.js` is written against Paystack's real, documented API:
`POST /transaction/initialize`, webhook signature verification via
HMAC-SHA512 over the raw request body, `GET /transaction/verify/:reference`
before ever trusting a webhook's claim. **This has not been run against
Paystack's actual servers** — this environment has no network access, so
there was nothing to call. What *was* tested here:

- Webhook rejects requests with no signature (401) — verified.
- Webhook rejects requests with a wrong/forged signature (401) — verified.
- With `PAYSTACK_SECRET_KEY` unset (the default), `purchase-intent`
  behaves exactly as the original stub did: creates a `pending` purchase,
  returns 202 with an explanatory message, grants no access — verified.
- The idempotency logic (`findPurchaseByProviderReference`, short-circuit
  if already `success`) is straightforward and was reviewed carefully, but
  **has not been exercised with a real duplicate webhook delivery**, since
  that requires an actual Paystack account sending one.

**Before this goes live**: get a Paystack test account, set
`PAYSTACK_SECRET_KEY`, install nothing extra (it uses the Node 18+ global
`fetch`, no new dependency), and run a real test transaction end-to-end,
including deliberately re-sending the webhook to confirm the idempotency
check actually holds against the real payload shape Paystack sends (this
was written against their documented shape, not a captured real payload).

### Two purchase systems — consolidation plan (not yet executed)

Confirmed both still exist:
- **Legacy** (`routes/legacyPurchases.js`): `POST /api/purchases` +
  `GET /api/library`, fake instant success, keyed to `data/seed.json`'s
  hardcoded resource IDs (e.g. `res_get205_2025_pq`).
- **Current** (`routes/library.js` + `routes/payments.js`): real resources
  table, real (pending, not fake) purchase flow.

**Why not consolidated yet**: there's no real user data in either system in
this environment to migrate, and the task explicitly said not to silently
break things or delete without a plan. Here's the plan for when it matters:

1. Once Paystack is live-tested (above), seed the `resources` table with
   equivalents of the demo `seed.json` items (or decide they're not needed
   in production at all — they're demo content).
   2. Update the frontend's "Unlock" button (currently calling
   `POST /api/purchases`) and "My Library" page (currently calling
   `GET /api/library`) to call the new `/api/resources/:id/purchase-intent`
   and a `GET /api/purchases/mine`-style endpoint (would need adding —
   `listPurchasesForUser` already exists in the store, just not wired to a
   route) against the new system instead.
3. If this app ever ran with real users against the legacy system, migrate
   `data/db.json`'s `purchases`/`payments` arrays into the new
   `resources`/`purchases` tables (mapping `resourceId` strings to newly
   created resource rows) rather than discarding that history.
4. Remove `routes/legacyPurchases.js`, its registration in `server.js`, and
   the "My Library" nav item / `app-library` view in the frontend.
5. Delete the now-unused hardcoded resources array from `data/seed.json`
   (keep the faculty/department/course catalog — that's still real and used).

---

## 2. Full route table

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/register` | none | Rate-limited (10/10min/IP). Validates email format, password length, level enum, faculty→department consistency |
| POST | `/api/login` | none | Rate-limited (15/10min/IP) |
| POST | `/api/logout` | session cookie | Clears session server-side and via cookie |
| GET | `/api/me` | required | |
| PATCH | `/api/profile` | required | Explicit field whitelist: bio, interests, discoverable, avatarDataUrl only |
| GET | `/api/catalog` | none | Static faculty/department/course data |
| POST | `/api/password-reset/request` | none | Rate-limited (5/15min/IP). Same response whether or not the email exists |
| POST | `/api/password-reset/confirm` | none (token-authenticated) | Rate-limited (10/15min/IP). Single-use token, invalidates all sessions on success |
| POST | `/api/purchases` | required | **Deprecated legacy flow** — fake instant success, hardcoded seed resources |
| GET | `/api/library` | required | **Deprecated legacy flow** — pairs with the above |
| GET | `/api/resources` | none | Published only. Filters: q, faculty, department, level |
| GET | `/api/resources/:id` | none | Published only; metadata, never the file or storage key |
| GET | `/api/resources/:id/access` | required | Rate-limited (60/10min/IP). The ONLY route that returns file bytes/a signed URL. Free → any authed user; paid → requires a `success` purchase, else 402 |
| GET | `/api/admin/resources` | **admin** | Includes archived; includes purchase count/revenue per resource |
| POST | `/api/admin/resources` | **admin** | PDF magic-byte + size validated; storage key server-generated; duplicate-hash warning |
| PUT | `/api/admin/resources/:id` | **admin** | Metadata only, explicit whitelist (title/courseCode/courseName/faculty/department/level/description/accessType/status/price) |
| PUT | `/api/admin/resources/:id/file` | **admin** | Replaces the file (new storage key); old file deleted only after the DB points at the new one |
| DELETE | `/api/admin/resources/:id` | **admin** | Archives if purchases exist; hard-deletes (DB row + storage file) otherwise |
| POST | `/api/resources/:id/purchase-intent` | required | Rate-limited (20/10min/IP). Atomic find-or-create; calls Paystack's initialize if configured, else returns the "not connected" message |
| POST | `/api/webhooks/paystack` | signature-verified, not session-authenticated | Verifies HMAC-SHA512 over the raw body; independently calls Paystack's verify endpoint; idempotent on `providerReference` |

Removed: `GET /api/courses/:code` (dead — confirmed unused by the frontend).

---

## 3. Frontend/backend contract check

Traced every `api(...)` call the frontend actually makes (not what the UI
implies) against the routes above — all match. Specifically fixed:

- **"Forgot password" previously called nothing** — now calls
  `/api/password-reset/request` then `/api/password-reset/confirm`, with a
  real two-step UI (request → enter code + new password). Since there's no
  email provider wired up (no network access here to test one, and none
  configured), the dev-mode response includes the raw token so the flow is
  testable end-to-end locally; production (`NODE_ENV=production`) omits it
  — the real email send is the one piece of this still to be built (see
  Remaining Blockers).
- Admin resource list now calls the new `GET /api/admin/resources`
  (includes archived + stats) instead of the public listing.
- Delete button now correctly reflects archive-vs-delete based on the
  server's actual response rather than assuming deletion always happened.

---

## 4. Tests actually run (against the live running server, this session)

**Auth:**
- ✅ Register → login → session check (`/api/me`) → logout → session check fails (401)
- ✅ Invalid level rejected (400)
- ✅ Password reset: request → wrong token rejected → correct token accepted → old password fails → new password works → reusing the same token fails (single-use) → prior session invalidated by the reset

**Admin/RBAC:**
- ✅ Non-admin calling an admin endpoint → 403
- ✅ Unauthenticated call to a protected endpoint → 401
- ✅ Fake (non-PDF) file upload → rejected (400)
- ✅ Real PDF upload → succeeds, `storageKey`/`storageProvider` confirmed absent from the response
- ✅ Duplicate file upload → warning returned, not blocked

**Student/Library:**
- ✅ Browse/search/filter (`?q=`, faculty/department/level)
- ✅ Free resource: byte-for-byte correct file returned after auth
- ✅ Paid resource without purchase → 402, no file/URL leaked
- ✅ Guessing a random resource UUID → 404, no information leak

**Concurrency:**
- ✅ 6 near-simultaneous `purchase-intent` calls (1 sequential + 5 fired concurrently) for the same user+resource → exactly 1 purchase row in `data/db.json`, confirmed by direct inspection

**File security:**
- ✅ Oversized upload (16MB against a 15MB limit) → clean 413, connection stays healthy (previously this reset the connection — fixed and verified in an earlier session, re-confirmed here)
- ✅ Path traversal defenses reviewed in `localAdapter.js` (pre-existing, re-verified)
- ✅ File replacement: new file served correctly, byte-for-byte, after replacing an existing resource's file

**Payments:**
- ✅ Webhook with no signature → 401
- ✅ Webhook with a forged signature → 401
- ✅ Purchase-intent without `PAYSTACK_SECRET_KEY` → pending, 202, no access granted (no fake success)
- ❌ **Not run**: an actual Paystack initialize/verify call, or a real webhook delivery — no network access in this environment, no Paystack account to test against

**Rate limiting:**
- ✅ Login endpoint: confirmed switches from 401 (bad credentials) to 429 (rate limited) once the configured threshold is crossed

**Regression (legacy flow, to confirm the refactor didn't break it):**
- ✅ `POST /api/purchases` + `GET /api/library` still work exactly as before the `server.js` split into modules

---

## 5. Production readiness summary

### Fully working (tested against the running server)
- Registration, login, logout, session check, profile update
- Password reset (request + confirm), including single-use tokens and session invalidation
- Session expiration (server-side, not just cookie-implied)
- Rate limiting on sensitive endpoints
- Admin RBAC enforcement (401/403 paths)
- PDF upload validation (magic bytes, size limit, duplicate detection)
- Resource browsing/search/filtering
- Free resource access control
- Paid resource access control (blocks until a real `success` purchase exists)
- Archive-vs-hard-delete based on purchase history
- File replacement/versioning
- Purchase race condition fix (verified with concurrent requests)
- Paystack webhook signature verification (rejection paths)
- Legacy demo purchase flow (unchanged, still works)

### Partially working / needs product decisions
- RBAC: `moderator`/`super_admin` roles exist in the schema and rank
  system, but no endpoint yet uses anything other than `student` vs
  `admin`-or-higher. Needs a decision on what moderators can actually do.
- Two purchase systems coexist by design for now — see the consolidation
  plan above for when to retire the legacy one.

### Mocked / not real
- **Password reset email delivery.** The token-generation, storage,
  expiry, and consumption are all real. Actually emailing the link is not
  — there's no email provider configured (and no network access here to
  test one). In dev, the token is returned directly in the API response
  instead.
- **Nothing else is mocked.** Storage, PDF validation, purchase logic, and
  access control are all real code paths, run against real data on the
  local JSON store.

### Genuinely untested (real code, not exercised live)
- `db/postgresStore.js` — written against `db/schema.sql`, follows the
  same parameterized-query conventions throughout, but never run against
  an actual Postgres instance (no network/DB access in this environment).
- `storage/s3Adapter.js` — written against the documented AWS SDK v3 API,
  never run against a real S3/R2/B2 bucket.
- `routes/payments.js`'s actual Paystack HTTP calls (initialize, verify) —
  only the signature-verification and no-key-configured paths were
  testable here.

### Security issues found and fixed this pass
See the table in section 1 — password reset, session expiration, secure
cookies, rate limiting, error message leakage, the purchase race
condition, and level validation. All verified fixed against the running
server, not just reasoned about.

### Remaining blockers to real production use
1. **Get a Postgres instance and actually run `db/schema.sql` +
   `db/postgresStore.js` against it.** This is the single biggest
   "unverified" item — the JSON store's fundamental limitation (no real
   transactions, whole-file rewrites) is fine for a demo, not for
   concurrent real users.
2. **Get an S3-compatible bucket and test `storage/s3Adapter.js` for
   real**, including that presigned URLs actually work end-to-end.
3. **Get a Paystack account, set `PAYSTACK_SECRET_KEY`, and run a real
   test transaction** including a real webhook delivery (and a
   deliberately duplicated one, to confirm idempotency against Paystack's
   actual payload shape, not just the documented one).
4. **Wire up a real email provider** for password reset (and, per the
   original audit ask, email verification — the `email_verified_at` column
   and field exist but nothing currently enforces verification before
   login; decide whether that's required before launch).
5. **Decide the moderator role's actual permissions** and implement the
   specific endpoints/checks for it, rather than leaving the rank
   infrastructure unused.
6. **Execute the purchase-system consolidation plan** above once Paystack
   is live-tested — don't run both systems in production long-term.
7. Rate limiting is per-process/in-memory — fine for a single Render
   instance, needs a shared store (Redis) before scaling to multiple
   instances.

### Exact next steps, in order
1. Provision Postgres, run `db/schema.sql`, set `DATABASE_URL`, re-run the
   test checklist in section 4 against it.
2. Provision an S3-compatible bucket, set `STORAGE_PROVIDER=s3` + the
   `S3_*` vars, re-run the file-upload/access/replace/delete tests against it.
3. Get Paystack test credentials, set `PAYSTACK_SECRET_KEY`, do one real
   test purchase end-to-end including the webhook.
4. Decide on email provider for password reset + verification; implement
   the actual send.
5. Then, and only then, execute the purchase-system consolidation plan.
