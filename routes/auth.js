// routes/auth.js
// All authentication routes: register, login, logout, session check,
// profile update, and password reset. Extracted from server.js so that
// file doesn't keep growing into a monolith (see README's architecture
// notes) — logic for register/login/logout/me/profile is unchanged from
// before, just moved. Password reset is NEW — it was previously 100% fake
// (the frontend "Forgot password" flow never called a backend endpoint at
// all; see PRODUCTION_READINESS.md for how that was found).

const crypto = require('crypto');
const {
  SEED, readDB, writeDB, hashPassword, verifyPassword, createSession,
  parseCookies, getSessionUser, publicUser, sendJSON, sendServerError,
  readBody, isValidEmail, isValidLevel, requireRateLimit,
  sessionCookieHeader, clearSessionCookieHeader, IS_PRODUCTION
} = require('../lib/core');

// Reset tokens: we store only a hash of the token (same principle as a
// password — if the database ever leaks, the tokens in it shouldn't be
// directly usable), with a short expiry, and they're single-use (cleared
// once consumed).
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function registerAuthRoutes(route) {
  route('POST', '/api/register', async (req, res) => {
    if (!requireRateLimit(req, res, 'register', 10, 10 * 60 * 1000)) return; // 10 per 10min per IP

    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJSON(res, 413, { error: e.message }, { 'Connection': 'close' }); }
    const { fullName, email, phone, password, faculty, department, level, avatarDataUrl } = body;

    if (!fullName || !isValidEmail(email) || !password || password.length < 6) {
      return sendJSON(res, 400, { error: 'Full name, a valid email, and a password of at least 6 characters are required.' });
    }
    if (!isValidLevel(level)) {
      return sendJSON(res, 400, { error: 'Level must be one of 100, 200, 300, 400, 500.' });
    }

    const chosenFaculty = faculty || 'Environmental Sciences';
    if (!SEED.faculties[chosenFaculty]) {
      return sendJSON(res, 400, { error: 'Please choose a valid faculty.' });
    }
    const chosenDepartment = department || 'Geomatics';
    if (!SEED.faculties[chosenFaculty].includes(chosenDepartment)) {
      return sendJSON(res, 400, { error: 'Please choose a department that belongs to the selected faculty.' });
    }

    const db = readDB();
    if (db.users.some(u => u.email.toLowerCase() === String(email).toLowerCase())) {
      return sendJSON(res, 409, { error: 'An account with this email already exists.' });
    }

    const baseUsername = '@' + String(fullName).trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    let username = baseUsername;
    let n = 1;
    while (db.users.some(u => u.username === username)) { username = baseUsername + (n++); }

    const user = {
      id: crypto.randomUUID(),
      fullName: String(fullName).trim(),
      username,
      email: String(email).trim(),
      phone: phone || null,
      passwordHash: hashPassword(password),
      university: SEED.university,
      faculty: chosenFaculty,
      department: chosenDepartment,
      level: level ? Number(level) : null,
      bio: '',
      interests: [],
      avatarDataUrl: avatarDataUrl || null,
      discoverable: true,
      role: 'student', // never accepted from client input — always hardcoded here
      emailVerifiedAt: null, // see note in PRODUCTION_READINESS.md — verification isn't enforced yet
      createdAt: new Date().toISOString()
    };
    db.users.push(user);
    const token = createSession(db, user.id);
    sendJSON(res, 201, { user: publicUser(user) }, { 'Set-Cookie': sessionCookieHeader(req, token, 2592000) });
  });

  route('POST', '/api/login', async (req, res) => {
    if (!requireRateLimit(req, res, 'login', 15, 10 * 60 * 1000)) return; // 15 per 10min per IP

    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJSON(res, 413, { error: e.message }, { 'Connection': 'close' }); }
    const { email, password } = body;
    const db = readDB();
    const user = db.users.find(u => u.email.toLowerCase() === String(email || '').toLowerCase());
    if (!user || !verifyPassword(password || '', user.passwordHash)) {
      return sendJSON(res, 401, { error: 'Incorrect email or password.' });
    }
    const token = createSession(db, user.id);
    sendJSON(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookieHeader(req, token, 2592000) });
  });

  route('POST', '/api/logout', async (req, res) => {
    const db = readDB();
    const cookies = parseCookies(req);
    db.sessions = db.sessions.filter(s => s.token !== cookies.sh_session);
    writeDB(db);
    sendJSON(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookieHeader(req) });
  });

  route('GET', '/api/me', async (req, res) => {
    const db = readDB();
    const user = getSessionUser(req, db);
    if (!user) return sendJSON(res, 401, { error: 'Not logged in.' });
    sendJSON(res, 200, { user: publicUser(user) });
  });

  route('PATCH', '/api/profile', async (req, res) => {
    const db = readDB();
    const user = getSessionUser(req, db);
    if (!user) return sendJSON(res, 401, { error: 'Not logged in.' });
    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJSON(res, 413, { error: e.message }, { 'Connection': 'close' }); }
    // Explicit whitelist — role, email, id etc. are never editable this way,
    // regardless of what the client sends.
    ['bio', 'interests', 'discoverable', 'avatarDataUrl'].forEach(field => {
      if (body[field] !== undefined) user[field] = body[field];
    });
    writeDB(db);
    sendJSON(res, 200, { user: publicUser(user) });
  });

  route('GET', '/api/catalog', async (req, res) => {
    sendJSON(res, 200, { university: SEED.university, faculties: SEED.faculties, courses: SEED.courses });
  });

  // -----------------------------------------------------------------
  // Password reset — REAL backend mechanics, previously nonexistent.
  // What's real: token generation, hashed storage, expiry, single-use
  // consumption, and actually changing the password.
  // What's NOT real yet: sending the email. There's no email provider
  // wired up (no network access to test one from where this was built,
  // and none was configured). In development, the raw token is returned
  // in the API response and logged to the console so the flow is fully
  // testable end-to-end; in production that must be replaced with an
  // actual email send (see PRODUCTION_READINESS.md) — the response will
  // NOT include the token when NODE_ENV=production.
  // -----------------------------------------------------------------
  route('POST', '/api/password-reset/request', async (req, res) => {
    if (!requireRateLimit(req, res, 'password-reset-request', 5, 15 * 60 * 1000)) return;

    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJSON(res, 413, { error: e.message }, { 'Connection': 'close' }); }
    const email = String(body.email || '').trim();
    const db = readDB();
    const user = db.users.find(u => u.email.toLowerCase() === email.toLowerCase());

    // Always respond the same way whether or not the account exists —
    // otherwise this endpoint becomes an email-enumeration oracle.
    const genericResponse = { ok: true, message: 'If an account exists for that email, a reset link has been sent.' };

    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      user.resetTokenHash = hashToken(rawToken);
      user.resetTokenExpiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
      writeDB(db);

      const resetLink = `/reset-password?token=${rawToken}&email=${encodeURIComponent(user.email)}`;
      console.log(`[password-reset] Reset link for ${user.email} (would be emailed in production): ${resetLink}`);

      if (!IS_PRODUCTION) {
        // Dev/test convenience ONLY — never expose the token in production.
        return sendJSON(res, 200, { ...genericResponse, devOnlyToken: rawToken, devOnlyLink: resetLink });
      }
    }
    sendJSON(res, 200, genericResponse);
  });

  route('POST', '/api/password-reset/confirm', async (req, res) => {
    if (!requireRateLimit(req, res, 'password-reset-confirm', 10, 15 * 60 * 1000)) return;

    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJSON(res, 413, { error: e.message }, { 'Connection': 'close' }); }
    const { email, token, newPassword } = body;
    if (!email || !token || !newPassword || newPassword.length < 6) {
      return sendJSON(res, 400, { error: 'Email, token, and a new password of at least 6 characters are required.' });
    }

    const db = readDB();
    const user = db.users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
    if (!user || !user.resetTokenHash || !user.resetTokenExpiresAt) {
      return sendJSON(res, 400, { error: 'Invalid or expired reset link.' });
    }
    if (new Date(user.resetTokenExpiresAt).getTime() < Date.now()) {
      return sendJSON(res, 400, { error: 'This reset link has expired. Request a new one.' });
    }
    const providedHash = hashToken(String(token));
    const a = Buffer.from(providedHash, 'hex');
    const b = Buffer.from(user.resetTokenHash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return sendJSON(res, 400, { error: 'Invalid or expired reset link.' });
    }

    user.passwordHash = hashPassword(newPassword);
    user.resetTokenHash = null;
    user.resetTokenExpiresAt = null;
    // Reset also invalidates all existing sessions for this user — if
    // someone else had a stolen/leaked session, this cuts it off.
    db.sessions = db.sessions.filter(s => s.userId !== user.id);
    writeDB(db);

    sendJSON(res, 200, { ok: true, message: 'Password updated. Please log in again.' });
  });
}

module.exports = { registerAuthRoutes };
