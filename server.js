// StudentHub — backend server
// Deliberately zero external dependencies (only Node's built-in modules)
// so it runs anywhere with just `node server.js` — no npm install needed.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'data', 'db.json');
const SEED_PATH = path.join(ROOT, 'data', 'seed.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

const SEED = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));

// ---------------------------------------------------------------------
// Tiny JSON-file datastore. Good enough for a real dev/demo deployment;
// swap readDB/writeDB for a real Postgres client (see /mnt schema) when
// you're ready to run this in production.
// ---------------------------------------------------------------------
function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = { users: [], sessions: [], payments: [], purchases: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
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
// Sessions via a signed random token in an HttpOnly cookie
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
function getSessionUser(req, db) {
  const cookies = parseCookies(req);
  const token = cookies.sh_session;
  if (!token) return null;
  const session = db.sessions.find(s => s.token === token);
  if (!session) return null;
  return db.users.find(u => u.id === session.userId) || null;
}
function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

// ---------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------
function sendJSON(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 5 * 1024 * 1024) { reject(new Error('Payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
function isValidEmail(e) { return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

// ---------------------------------------------------------------------
// API route handlers
// ---------------------------------------------------------------------
const routes = [];
function route(method, matcher, handler) { routes.push({ method, matcher, handler }); }

route('POST', '/api/register', async (req, res) => {
  const body = await readBody(req);
  const { fullName, email, phone, password, faculty, department, level, avatarDataUrl } = body;

  if (!fullName || !isValidEmail(email) || !password || password.length < 6) {
    return sendJSON(res, 400, { error: 'Full name, a valid email, and a password of at least 6 characters are required.' });
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
    level: Number(level) || 300,
    bio: '',
    interests: [],
    avatarDataUrl: avatarDataUrl || null,
    discoverable: true,
    role: 'student',
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  const token = createSession(db, user.id);
  sendJSON(res, 201, { user: publicUser(user) }, { 'Set-Cookie': `sh_session=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax` });
});

route('POST', '/api/login', async (req, res) => {
  const body = await readBody(req);
  const { email, password } = body;
  const db = readDB();
  const user = db.users.find(u => u.email.toLowerCase() === String(email || '').toLowerCase());
  if (!user || !verifyPassword(password || '', user.passwordHash)) {
    return sendJSON(res, 401, { error: 'Incorrect email or password.' });
  }
  const token = createSession(db, user.id);
  sendJSON(res, 200, { user: publicUser(user) }, { 'Set-Cookie': `sh_session=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax` });
});

route('POST', '/api/logout', async (req, res) => {
  const db = readDB();
  const cookies = parseCookies(req);
  db.sessions = db.sessions.filter(s => s.token !== cookies.sh_session);
  writeDB(db);
  sendJSON(res, 200, { ok: true }, { 'Set-Cookie': 'sh_session=; HttpOnly; Path=/; Max-Age=0' });
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
  const body = await readBody(req);
  ['bio', 'interests', 'discoverable', 'avatarDataUrl'].forEach(field => {
    if (body[field] !== undefined) user[field] = body[field];
  });
  writeDB(db);
  sendJSON(res, 200, { user: publicUser(user) });
});

route('GET', '/api/catalog', async (req, res) => {
  sendJSON(res, 200, { university: SEED.university, faculties: SEED.faculties, courses: SEED.courses });
});

route('GET', '/api/courses/:code', async (req, res, params) => {
  const course = SEED.courses.find(c => c.code === params.code);
  if (!course) return sendJSON(res, 404, { error: 'Course not found.' });
  const resources = SEED.resources.filter(r => r.courseCode === params.code);
  sendJSON(res, 200, { course, resources });
});

route('GET', '/api/resources', async (req, res, params, query) => {
  let results = SEED.resources;
  if (query.get('courseCode')) results = results.filter(r => r.courseCode === query.get('courseCode'));
  if (query.get('tier')) results = results.filter(r => r.tier === query.get('tier'));
  sendJSON(res, 200, { resources: results });
});

route('POST', '/api/purchases', async (req, res) => {
  const db = readDB();
  const user = getSessionUser(req, db);
  if (!user) return sendJSON(res, 401, { error: 'Log in to unlock resources.' });

  const body = await readBody(req);
  const resource = SEED.resources.find(r => r.id === body.resourceId);
  if (!resource) return sendJSON(res, 404, { error: 'Resource not found.' });

  const existing = db.purchases.find(p => p.userId === user.id && p.resourceId === resource.id);
  if (existing) return sendJSON(res, 200, { purchase: existing, alreadyOwned: true });

  // Real integration point: call Paystack/Flutterwave "initialize" here, redirect
  // the client to their checkout, then only mark this successful inside your
  // webhook handler after a server-side "verify transaction" call.
  // This demo server has no live payment gateway to call, so it simulates an
  // immediately-successful payment so the purchase flow is genuinely end-to-end.
  const payment = {
    id: crypto.randomUUID(),
    userId: user.id,
    provider: 'demo',
    amountKobo: resource.priceKobo,
    status: 'success',
    createdAt: new Date().toISOString()
  };
  const purchase = {
    id: crypto.randomUUID(),
    userId: user.id,
    resourceId: resource.id,
    paymentId: payment.id,
    purchasedAt: new Date().toISOString()
  };
  db.payments.push(payment);
  db.purchases.push(purchase);
  writeDB(db);
  sendJSON(res, 201, { purchase, alreadyOwned: false });
});

route('GET', '/api/library', async (req, res) => {
  const db = readDB();
  const user = getSessionUser(req, db);
  if (!user) return sendJSON(res, 401, { error: 'Log in to view your library.' });
  const items = db.purchases
    .filter(p => p.userId === user.id)
    .map(p => ({ ...p, resource: SEED.resources.find(r => r.id === p.resourceId) }));
  sendJSON(res, 200, { items });
});

// ---------------------------------------------------------------------
// Static file serving for the frontend
// ---------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, indexData) => {
        if (err2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(indexData);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------------
// Simple router matcher supporting ":param" segments
// ---------------------------------------------------------------------
function matchRoute(routeDef, method, pathname) {
  if (routeDef.method !== method) return null;
  const patternParts = routeDef.matcher.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    else if (patternParts[i] !== pathParts[i]) return null;
  }
  return params;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    for (const r of routes) {
      const params = matchRoute(r, req.method, pathname);
      if (params) {
        try { return await r.handler(req, res, params, url.searchParams); }
        catch (e) { return sendJSON(res, 500, { error: e.message || 'Server error' }); }
      }
    }
    return sendJSON(res, 404, { error: 'No such API route.' });
  }

  return serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`StudentHub server running at http://localhost:${PORT}`);
});
