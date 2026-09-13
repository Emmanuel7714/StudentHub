// routes/library.js
// The PDF Library/Marketplace feature: browsing, admin CRUD (including
// file replacement and archive/publish), and backend-enforced access
// control. Purchase creation and Paystack now live in routes/payments.js
// (see PRODUCTION_READINESS.md for why that split happened).

const crypto = require('crypto');
const {
  readDB, writeDB, requireAuth, requireAdmin, sendJSON, sendServerError,
  readBody, escapeHtml, requireRateLimit
} = require('../lib/core');
const store = require('../db/store');
const storage = require('../storage');

const MAX_PDF_MB = Number(process.env.MAX_PDF_MB || 15);
const MAX_PDF_BYTES = MAX_PDF_MB * 1024 * 1024;
// Base64 inflates size ~33% — cap the raw request body generously above the file cap.
const MAX_UPLOAD_BODY_BYTES = Math.ceil(MAX_PDF_BYTES * 1.4) + 20 * 1024;

function isPdfBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length > 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Original filenames are for display only — never used to build a path,
// and stripped down hard so nothing unexpected reaches the UI.
function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'resource.pdf';
  return name.replace(/[^\w.\- ]/g, '').slice(0, 120) || 'resource.pdf';
}

function publicResource(r) {
  // storageKey, storageProvider and fileHash are internal — never sent to the client.
  const { storageKey, storageProvider, fileHash, ...rest } = r;
  return { ...rest, title: escapeHtml(r.title), description: escapeHtml(r.description || ''), courseName: escapeHtml(r.courseName || '') };
}

function decodeAndValidatePdf(fileBase64, res) {
  let buffer;
  try { buffer = Buffer.from(fileBase64, 'base64'); }
  catch (e) { sendJSON(res, 400, { error: 'fileBase64 is not valid base64.' }); return null; }
  if (buffer.length === 0) { sendJSON(res, 400, { error: 'Uploaded file is empty.' }); return null; }
  if (buffer.length > MAX_PDF_BYTES) { sendJSON(res, 413, { error: `PDF exceeds the ${MAX_PDF_MB}MB limit.` }); return null; }
  if (!isPdfBuffer(buffer)) { sendJSON(res, 400, { error: 'File does not look like a valid PDF.' }); return null; }
  return buffer;
}

// ---------------------------------------------------------------------
// Optional admin bootstrap: if ADMIN_EMAIL/ADMIN_PASSWORD are set and no
// user with that email exists yet, create an admin account so there's a
// way into the upload form on a fresh install. See README.md.
// ---------------------------------------------------------------------
function bootstrapAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.log('[library] No ADMIN_EMAIL/ADMIN_PASSWORD set — no admin account will be created automatically.');
    console.log('[library] To get one, set both env vars and restart, or manually set role:"admin" for a user in data/db.json.');
    return;
  }
  const { hashPassword } = require('../lib/core');
  const db = readDB();
  const existing = db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    if (existing.role !== 'admin' && existing.role !== 'super_admin') { existing.role = 'admin'; writeDB(db); }
    console.log(`[library] Admin account ready: ${email}`);
    return;
  }
  const user = {
    id: crypto.randomUUID(),
    fullName: process.env.ADMIN_NAME || 'StudentHub Admin',
    username: '@admin',
    email,
    phone: null,
    passwordHash: hashPassword(password),
    university: 'University of Benin',
    faculty: 'Environmental Sciences',
    department: 'Geomatics',
    level: null,
    bio: '', interests: [], avatarDataUrl: null, discoverable: false,
    role: 'admin',
    emailVerifiedAt: new Date().toISOString(), // admin bootstrap is trusted by definition
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  writeDB(db);
  console.log(`[library] Created admin account: ${email}`);
}

function registerLibraryRoutes(route) {
  bootstrapAdmin();

  // ---- Public/browse endpoints (published resources only) -----------
  route('GET', '/api/resources', async (req, res, params, query) => {
    const resources = await store.listResources({
      q: query.get('q') || undefined,
      faculty: query.get('faculty') || undefined,
      department: query.get('department') || undefined,
      level: query.get('level') || undefined
    });
    sendJSON(res, 200, { resources: resources.map(publicResource) });
  });

  route('GET', '/api/resources/:id', async (req, res, params) => {
    const resource = await store.getResource(params.id);
    if (!resource || resource.status === 'archived') return sendJSON(res, 404, { error: 'Resource not found.' });
    sendJSON(res, 200, { resource: publicResource(resource) });
  });

  // ---- Access control: the ONLY place a PDF's bytes are ever reached from ----
  route('GET', '/api/resources/:id/access', async (req, res, params) => {
    if (!requireRateLimit(req, res, 'resource-access', 60, 10 * 60 * 1000)) return;

    const db = readDB();
    const user = requireAuth(req, res, db);
    if (!user) return;

    const resource = await store.getResource(params.id);
    if (!resource || resource.status === 'archived') return sendJSON(res, 404, { error: 'Resource not found.' });

    if (resource.accessType === 'paid') {
      const purchase = await store.findPurchase(user.id, resource.id);
      if (!purchase || purchase.status !== 'success') {
        return sendJSON(res, 402, {
          error: 'This resource requires payment before it can be accessed.',
          accessType: 'paid',
          priceKobo: resource.priceKobo
        });
      }
    }
    // Free resources: any authenticated user is authorized. Paid resources:
    // only a user with a confirmed ('success') purchase reaches this point.

    try {
      const presigned = await storage.getPresignedDownloadUrl(resource.storageKey, 300);
      if (presigned) {
        // S3-style adapter: redirect to a short-lived signed URL. The
        // storage credentials themselves never reach the client.
        res.writeHead(302, { Location: presigned });
        return res.end();
      }
      // Local-disk adapter: stream the bytes through the server directly.
      const buffer = await storage.getObjectBuffer(resource.storageKey);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': buffer.length,
        'Content-Disposition': `inline; filename="${sanitizeFilename(resource.originalFilename)}"`,
        'Cache-Control': 'private, no-store'
      });
      res.end(buffer);
    } catch (e) {
      sendServerError(res, e, 'resource-access');
    }
  });

  // ---- Admin: full listing including archived, plus purchase stats ----
  route('GET', '/api/admin/resources', async (req, res, params, query) => {
    const db = readDB();
    const admin = requireAdmin(req, res, db);
    if (!admin) return;

    const resources = await store.listResources({
      q: query.get('q') || undefined,
      faculty: query.get('faculty') || undefined,
      department: query.get('department') || undefined,
      level: query.get('level') || undefined,
      includeArchived: true
    });
    const allPurchases = await store.listAllPurchases();
    const withStats = resources.map(r => {
      const forResource = allPurchases.filter(p => p.resourceId === r.id);
      return {
        ...publicResource(r),
        status: r.status,
        purchaseCount: forResource.length,
        successfulPurchaseCount: forResource.filter(p => p.status === 'success').length,
        revenueKobo: forResource.filter(p => p.status === 'success').reduce((sum, p) => sum + (p.amountKobo || 0), 0)
      };
    });
    sendJSON(res, 200, { resources: withStats });
  });

  // ---- Admin CRUD -----------------------------------------------------
  route('POST', '/api/admin/resources', async (req, res) => {
    const db = readDB();
    const admin = requireAdmin(req, res, db);
    if (!admin) return;

    let body;
    try { body = await readBody(req, MAX_UPLOAD_BODY_BYTES); }
    catch (e) { return sendJSON(res, 413, { error: e.message }, { 'Connection': 'close' }); }

    const { title, courseCode, courseName, faculty, department, level, description, accessType, price, fileBase64, filename } = body;

    if (!title || !courseCode || !faculty || !department || !accessType) {
      return sendJSON(res, 400, { error: 'title, courseCode, faculty, department and accessType are required.' });
    }
    if (!['free', 'paid'].includes(accessType)) {
      return sendJSON(res, 400, { error: 'accessType must be "free" or "paid".' });
    }
    if (accessType === 'paid' && (!Number.isFinite(Number(price)) || Number(price) <= 0)) {
      return sendJSON(res, 400, { error: 'A paid resource needs a price greater than 0.' });
    }
    if (!fileBase64) {
      return sendJSON(res, 400, { error: 'fileBase64 (the PDF, base64-encoded) is required.' });
    }

    const buffer = decodeAndValidatePdf(fileBase64, res);
    if (!buffer) return; // response already sent

    const fileHash = sha256(buffer);
    const duplicate = await store.findResourceByHash(fileHash);
    // Not blocked — an admin may legitimately re-upload the same file under
    // a different course/title — but the caller is told, since this is
    // exactly the kind of thing that otherwise goes unnoticed until storage
    // costs or search results look odd.
    const duplicateWarning = duplicate
      ? `This exact file is already uploaded as "${duplicate.title}" (id ${duplicate.id}).`
      : null;

    const storageKey = `resources/${crypto.randomUUID()}.pdf`;
    try {
      await storage.putObject(storageKey, buffer, 'application/pdf');
    } catch (e) {
      return sendServerError(res, e, 'storage-put');
    }

    const resource = await store.createResource({
      title: String(title).trim(),
      courseCode: String(courseCode).trim().toUpperCase(),
      courseName: courseName ? String(courseName).trim() : null,
      faculty, department,
      level: level ? Number(level) : null,
      description: description ? String(description).trim() : '',
      accessType,
      priceKobo: accessType === 'paid' ? Math.round(Number(price) * 100) : 0,
      storageProvider: storage.provider,
      storageKey,
      fileHash,
      originalFilename: sanitizeFilename(filename),
      fileSizeBytes: buffer.length,
      uploadedBy: admin.id
    });

    sendJSON(res, 201, { resource: publicResource(resource), duplicateWarning });
  });

  route('PUT', '/api/admin/resources/:id', async (req, res, params) => {
    const db = readDB();
    const admin = requireAdmin(req, res, db);
    if (!admin) return;

    const existing = await store.getResource(params.id);
    if (!existing) return sendJSON(res, 404, { error: 'Resource not found.' });

    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJSON(res, 413, { error: e.message }, { 'Connection': 'close' }); }

    if (body.accessType && !['free', 'paid'].includes(body.accessType)) {
      return sendJSON(res, 400, { error: 'accessType must be "free" or "paid".' });
    }
    if (body.status && !['published', 'archived'].includes(body.status)) {
      return sendJSON(res, 400, { error: 'status must be "published" or "archived".' });
    }
    // Explicit whitelist of what a metadata edit may touch — file fields
    // (storageKey etc.) are never settable this way, only via the
    // dedicated replace-file route below.
    const patch = {};
    ['title', 'courseCode', 'courseName', 'faculty', 'department', 'level', 'description', 'accessType', 'status']
      .forEach(f => { if (body[f] !== undefined) patch[f] = body[f]; });
    if (body.price !== undefined) patch.priceKobo = Math.round(Number(body.price) * 100);
    if (patch.courseCode) patch.courseCode = String(patch.courseCode).trim().toUpperCase();

    const resource = await store.updateResource(params.id, patch);
    sendJSON(res, 200, { resource: publicResource(resource) });
  });

  // Replace the underlying file without changing the resource's id, url,
  // or purchase history — a real "new version" rather than delete+re-upload.
  // Ordering matters: we upload the NEW file and update the DB record to
  // point at it BEFORE deleting the OLD file, so a crash mid-operation
  // never leaves the resource pointing at a file that no longer exists.
  route('PUT', '/api/admin/resources/:id/file', async (req, res, params) => {
    const db = readDB();
    const admin = requireAdmin(req, res, db);
    if (!admin) return;

    const existing = await store.getResource(params.id);
    if (!existing) return sendJSON(res, 404, { error: 'Resource not found.' });

    let body;
    try { body = await readBody(req, MAX_UPLOAD_BODY_BYTES); }
    catch (e) { return sendJSON(res, 413, { error: e.message }, { 'Connection': 'close' }); }

    if (!body.fileBase64) return sendJSON(res, 400, { error: 'fileBase64 is required.' });
    const buffer = decodeAndValidatePdf(body.fileBase64, res);
    if (!buffer) return;

    const fileHash = sha256(buffer);
    const newStorageKey = `resources/${crypto.randomUUID()}.pdf`;
    try {
      await storage.putObject(newStorageKey, buffer, 'application/pdf');
    } catch (e) {
      return sendServerError(res, e, 'storage-put-replace');
    }

    const result = await store.replaceResourceFile(params.id, {
      storageProvider: storage.provider,
      storageKey: newStorageKey,
      originalFilename: sanitizeFilename(body.filename),
      fileSizeBytes: buffer.length,
      fileHash
    });

    // Only now delete the old file — the DB already points at the new one.
    if (result?.oldStorageKey) {
      try { await storage.deleteObject(result.oldStorageKey); } catch (e) { /* non-fatal; logged */ console.error('[library] failed to delete old file after replacement', e); }
    }

    sendJSON(res, 200, { resource: publicResource(result.resource) });
  });

  // Archive if the resource has purchase history (never destroy something
  // a paying student's access depends on being traceable); hard-delete
  // (including the stored file) only when nothing references it.
  route('DELETE', '/api/admin/resources/:id', async (req, res, params) => {
    const db = readDB();
    const admin = requireAdmin(req, res, db);
    if (!admin) return;

    const existing = await store.getResource(params.id);
    if (!existing) return sendJSON(res, 404, { error: 'Resource not found.' });

    const purchaseCount = await store.countPurchasesForResource(params.id);
    if (purchaseCount > 0) {
      const resource = await store.updateResource(params.id, { status: 'archived' });
      return sendJSON(res, 200, { archived: true, resource: publicResource(resource) });
    }

    try { await storage.deleteObject(existing.storageKey); } catch (e) { console.error('[library] failed to delete storage object', e); }
    await store.deleteResource(params.id);
    sendJSON(res, 200, { deleted: true });
  });
}

module.exports = { registerLibraryRoutes };
