// lib/core.js
// Shared primitives used by both the original StudentHub routes (in
// server.js) and the new Library/Marketplace routes (in routes/library.js).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'db.json');
const SEED_PATH = path.join(ROOT, 'data', 'seed.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

const SEED = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Session lifetime, enforced server-side (not just via the cookie's own
// Max-Age, which a client could ignore/replay). 30 days by default.
const SESSION_MAX_AGE_MS = Number(process.env.SESSION_MAX_AGE_DAYS || 30) * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------
// Tiny JSON-file datastore for the ORIGINAL app data (users, sessions,
// legacy demo purchases/payments). The new Library feature's own data
// (resources, purchases) lives behind db/store.js instead — see there
// for the Postgres-ready abstraction.
//
// KNOWN LIMITATION (documented, not silently relied upon): this is
// synchronous, whole-file read-modify-write with no cross-process locking.
// Each individual store function here does its read and write back-to-back
// with no `await` in between, so within ONE function call it's safe from
// interleaving (Node won't preempt synchronous code). It is NOT safe
// against multi-step sequences that `await` between a read and a later
// write from a DIFFERENT call (see routes/library.js's purchase-intent fix
// for a concrete example of that exact problem and how it's avoided).
// This is a fundamental limitation of a single JSON file with no ACID
// transactions — it is not "fixed", it's why db/postgresStore.js exists
// for production, where real transactions and unique constraints apply.
// ---------------------------------------------------------------------
function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = { users: [], sessions: [], payments: [], purchases: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  // Defensive defaults in case of an older db.json from before this feature existed.
  db.users ||= []; db.sessions ||= []; db.payments ||= []; db.purchases ||= [];
  return db;
}
function writeDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ---------------------------------------------------------------------
// Password hashing (scrypt — built into Node, no bcrypt dependency needed)
// ---------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------
// Sessions via a random token in an HttpOnly cookie. Shared by every
// route (old and new) so one login works across the whole app.
// Sessions now carry a real server-side expiry (SESSION_MAX_AGE_MS) —
// previously only the cookie's own Max-Age implied expiration, which the
// server never actually checked, so a copied/leaked token worked forever.
// ---------------------------------------------------------------------
function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions.push({ token, userId, createdAt: new Date().toISOString() });
  writeDB(db);
  return token;
}
function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header.split(';').filter(Boolean).map(p => {
      const [k, ...v] = p.trim().split('=');
      return [k, decodeURIComponent(v.join('='))];
    })
  );
}
// Cookie flags: Secure is required for cookies to be sent over HTTPS-only,
// which matters once this is deployed behind a TLS-terminating proxy
// (Render, etc). We can't just hardcode Secure=true because that would
// break plain-http local development. Detection: NODE_ENV=production, or
// the proxy telling us the original request was https.
function isRequestSecure(req) {
  if (!IS_PRODUCTION) return false;
  const forwardedProto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return forwardedProto === 'https' || req.socket?.encrypted === true;
}
function sessionCookieHeader(req, token, maxAgeSeconds) {
  const parts = [`sh_session=${token}`, 'HttpOnly', 'Path=/', `Max-Age=${maxAgeSeconds}`, 'SameSite=Lax'];
  if (isRequestSecure(req)) parts.push('Secure');
  return parts.join('; ');
}
function clearSessionCookieHeader(req) {
  const parts = ['sh_session=', 'HttpOnly', 'Path=/', 'Max-Age=0', 'SameSite=Lax'];
  if (isRequestSecure(req)) parts.push('Secure');
  return parts.join('; ');
}
function getSessionUser(req, db) {
  const cookies = parseCookies(req);
  const token = cookies.sh_session;
  if (!token) return null;
  const session = db.sessions.find(s => s.token === token);
  if (!session) return null;
  const ageMs = Date.now() - new Date(session.createdAt).getTime();
  if (ageMs > SESSION_MAX_AGE_MS) {
    // Expired — clean it up rather than leaving dead sessions to accumulate.
    db.sessions = db.sessions.filter(s => s.token !== token);
    writeDB(db);
    return null;
  }
  return db.users.find(u => u.id === session.userId) || null;
}
function publicUser(u) {
  if (!u) return null;
  const { passwordHash, resetTokenHash, resetTokenExpiresAt, ...rest } = u;
  return rest;
}

// requireAuth / requireAdmin: return the user, or send the error response
// and return null. Callers do: const user = requireAuth(req,res,db); if(!user) return;
function requireAuth(req, res, db) {
  const user = getSessionUser(req, db);
  if (!user) { sendJSON(res, 401, { error: 'You need to be logged in for this.' }); return null; }
  return user;
}
// Role hierarchy: student < moderator < admin < super_admin. requireAdmin
// accepts admin or super_admin (super_admin is a superset of admin).
// requireRole(minRole) is the general form other routes can use as the
// RBAC model grows (e.g. requireRole(req,res,db,'moderator')).
const ROLE_RANK = { student: 0, moderator: 1, admin: 2, super_admin: 3 };
function requireRole(req, res, db, minRole) {
  const user = requireAuth(req, res, db);
  if (!user) return null;
  const rank = ROLE_RANK[user.role] ?? 0;
  if (rank < ROLE_RANK[minRole]) { sendJSON(res, 403, { error: `This action requires the '${minRole}' role or higher.` }); return null; }
  return user;
}
function requireAdmin(req, res, db) {
  return requireRole(req, res, db, 'admin');
}

// ---------------------------------------------------------------------
// Request/response helpers
// ---------------------------------------------------------------------
function sendJSON(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}

// Server-side logging for unexpected errors, WITHOUT leaking internals to
// the client. Previously the top-level dispatcher sent e.message straight
// to the client for any uncaught error — fine for a deliberate validation
// error (those use sendJSON directly with a safe message), not fine for a
// genuine bug/internal failure (stack traces, file paths, DB errors, etc).
function sendServerError(res, err, context) {
  console.error(`[error]${context ? ' [' + context + ']' : ''}`, err);
  sendJSON(res, 500, { error: 'Something went wrong on our end. Please try again.' });
}

// maxBytes is configurable per-route: normal JSON routes keep the original
// 5MB ceiling; the admin PDF-upload route asks for a larger one explicitly.
//
// Note: on exceeding the limit we pause the stream and reject rather than
// destroying the socket outright — destroying it here would prevent the
// caller's error response from ever reaching the client (the connection
// would just reset). The route's catch block sends a proper 413 with
// Connection: close, and Node closes the socket cleanly after that,
// discarding whatever request body was left unread.
function readBody(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', c => {
      if (settled) return;
      size += c.length;
      if (size > maxBytes) {
        settled = true;
        req.pause();
        reject(new Error(`Payload too large (max ${(maxBytes / (1024 * 1024)).toFixed(0)}MB)`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
function isValidEmail(e) { return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
const VALID_LEVELS = [100, 200, 300, 400, 500];
function isValidLevel(level) {
  if (level === null || level === undefined || level === '') return true; // optional
  return VALID_LEVELS.includes(Number(level));
}

// Like readBody, but returns the raw Buffer without JSON-parsing it. Needed
// for webhook signature verification (e.g. Paystack), which is computed
// over the exact raw request bytes — parsing and re-serializing JSON is
// NOT guaranteed to reproduce the same bytes the signature was computed
// over (key order, whitespace, number formatting can all differ).
function readRawBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', c => {
      if (settled) return;
      size += c.length;
      if (size > maxBytes) {
        settled = true;
        req.pause();
        reject(new Error(`Payload too large (max ${(maxBytes / (1024 * 1024)).toFixed(1)}MB)`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', reject);
  });
}

// Escape any user-supplied text before it's ever interpolated into HTML
// server-side. (The frontend also treats resource metadata as untrusted —
// see escapeHtml() in public/index.html — this is defense in depth.)
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

// ---------------------------------------------------------------------
// Simple in-memory rate limiter. Per-process, per-IP sliding window —
// resets on restart and doesn't share state across multiple instances.
// That's a real limitation (documented, not hidden): for a multi-instance
// production deployment, replace this with a shared store (Redis) keyed
// the same way. For a single-instance deployment (e.g. one Render service)
// this genuinely throttles brute-force attempts against this process.
// ---------------------------------------------------------------------
const rateLimitBuckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let bucket = rateLimitBuckets.get(key);
  if (!bucket || now - bucket.windowStart > windowMs) {
    bucket = { windowStart: now, count: 0 };
    rateLimitBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count <= limit;
}
function clientIp(req) {
  // Trust X-Forwarded-For only in production behind a known proxy; for
  // local dev this is just the socket address.
  const fwd = req.headers['x-forwarded-for'];
  if (IS_PRODUCTION && fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}
// requireRateLimit: true = OK, false = limit exceeded and a 429 was already sent.
function requireRateLimit(req, res, bucketName, limit, windowMs) {
  const key = bucketName + ':' + clientIp(req);
  if (!rateLimit(key, limit, windowMs)) {
    sendJSON(res, 429, { error: 'Too many attempts. Please wait a bit and try again.' }, { 'Retry-After': String(Math.ceil(windowMs / 1000)) });
    return false;
  }
  return true;
}

module.exports = {
  ROOT, DB_PATH, SEED_PATH, PUBLIC_DIR, SEED, IS_PRODUCTION, SESSION_MAX_AGE_MS,
  readDB, writeDB,
  hashPassword, verifyPassword,
  createSession, parseCookies, getSessionUser, publicUser,
  sessionCookieHeader, clearSessionCookieHeader, isRequestSecure,
  requireAuth, requireAdmin, requireRole, ROLE_RANK,
  sendJSON, sendServerError, readBody, readRawBody, isValidEmail, isValidLevel, escapeHtml,
  requireRateLimit, clientIp
};
