-- StudentHub Library/Marketplace — Postgres schema
-- Covers the three models requested: users, resources, purchases
-- (sessions included since auth depends on it). This is the target
-- schema for db/postgresStore.js. Run it once against your database
-- before setting DATABASE_URL:
--
--   psql "$DATABASE_URL" -f db/schema.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name      TEXT NOT NULL,
  username       TEXT NOT NULL UNIQUE,
  email          TEXT NOT NULL UNIQUE,
  phone          TEXT,
  password_hash  TEXT NOT NULL,
  university     TEXT,
  faculty        TEXT,
  department     TEXT,
  level          SMALLINT,
  bio            TEXT DEFAULT '',
  interests      JSONB DEFAULT '[]',
  avatar_data_url TEXT,
  discoverable   BOOLEAN NOT NULL DEFAULT TRUE,
  role           TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'moderator', 'admin', 'super_admin')),
  email_verified_at TIMESTAMPTZ,           -- infrastructure only — not yet enforced at login, see PRODUCTION_READINESS.md
  reset_token_hash TEXT,                    -- sha256 of an outstanding password-reset token; never store the raw token
  reset_token_expires_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS resources (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title             TEXT NOT NULL,
  course_code       TEXT NOT NULL,
  course_name       TEXT,
  faculty           TEXT NOT NULL,
  department        TEXT NOT NULL,
  level             SMALLINT,
  description       TEXT,
  access_type       TEXT NOT NULL DEFAULT 'paid' CHECK (access_type IN ('free', 'paid')),
  price_kobo        INTEGER NOT NULL DEFAULT 0 CHECK (price_kobo >= 0),
  status            TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'archived')),
  storage_provider  TEXT NOT NULL,               -- 'local' | 's3'
  storage_key       TEXT NOT NULL,               -- never exposed to the client directly
  file_hash         TEXT,                        -- sha256 of the file, for duplicate-upload detection
  original_filename TEXT,                        -- sanitized, display only — never used to build a path
  file_size_bytes   INTEGER,
  uploaded_by       UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_resources_course ON resources(course_code);
CREATE INDEX IF NOT EXISTS idx_resources_faculty_dept_level ON resources(faculty, department, level);
CREATE INDEX IF NOT EXISTS idx_resources_file_hash ON resources(file_hash);
CREATE INDEX IF NOT EXISTS idx_resources_status ON resources(status);

CREATE TABLE IF NOT EXISTS purchases (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_id         UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
  provider            TEXT,                      -- 'paystack', once integrated
  provider_reference  TEXT UNIQUE,               -- Paystack transaction reference
  amount_kobo         INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_user_resource ON purchases(user_id, resource_id);
CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status);

-- Notes:
-- 1. A purchase starts 'pending' and is only ever flipped to 'success' by
--    a server-side Paystack webhook handler that has independently called
--    Paystack's "verify transaction" endpoint — never by the client.
-- 2. storage_key is an opaque identifier (e.g. "resources/<uuid>.pdf"),
--    resolved to actual file bytes only by the storage adapter, only after
--    routes/library.js confirms the requesting user is authorized.
-- 3. The legacy demo purchase flow in server.js (db.json's own
--    `purchases`/`payments` arrays) is intentionally NOT part of this
--    schema — it's a separate, pre-existing demo mechanism left untouched.
--    If you migrate fully to Postgres, decide whether to fold that demo
--    data into this `purchases` table or retire it.
