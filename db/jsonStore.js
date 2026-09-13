// db/jsonStore.js
// Default data layer for the Library/Marketplace feature: resources and
// purchases, persisted to a JSON file. Same file (data/db.json) the rest
// of the app already uses, but under its own top-level keys so it never
// collides with the existing users/sessions/purchases/payments arrays.
//
// This exists so the app runs with zero setup (no database to install).
// db/postgresStore.js implements the exact same interface against real
// Postgres — see db/store.js for how the choice is made.

const fs = require('fs');
const crypto = require('crypto');
const { DB_PATH } = require('../lib/core');

function readRaw() {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  db.resources ||= [];
  db.libraryPurchases ||= [];
  return db;
}
function writeRaw(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

module.exports = {
  kind: 'json',

  async listResources({ q, faculty, department, level, includeArchived } = {}) {
    let results = readRaw().resources;
    if (!includeArchived) results = results.filter(r => r.status !== 'archived');
    if (q) {
      const needle = q.toLowerCase();
      results = results.filter(r =>
        r.title.toLowerCase().includes(needle) || r.courseCode.toLowerCase().includes(needle));
    }
    if (faculty) results = results.filter(r => r.faculty === faculty);
    if (department) results = results.filter(r => r.department === department);
    if (level) results = results.filter(r => String(r.level) === String(level));
    return results.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },

  async getResource(id) {
    return readRaw().resources.find(r => r.id === id) || null;
  },

  async createResource(data) {
    const db = readRaw();
    const resource = {
      id: crypto.randomUUID(),
      title: data.title,
      courseCode: data.courseCode,
      courseName: data.courseName || null,
      faculty: data.faculty,
      department: data.department,
      level: data.level || null,
      description: data.description || '',
      accessType: data.accessType,
      priceKobo: data.accessType === 'free' ? 0 : data.priceKobo,
      status: 'published',
      storageProvider: data.storageProvider,
      storageKey: data.storageKey,
      fileHash: data.fileHash || null,
      originalFilename: data.originalFilename || null,
      fileSizeBytes: data.fileSizeBytes || null,
      uploadedBy: data.uploadedBy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    db.resources.push(resource);
    writeRaw(db);
    return resource;
  },

  async findResourceByHash(fileHash) {
    if (!fileHash) return null;
    return readRaw().resources.find(r => r.fileHash === fileHash && r.status !== 'archived') || null;
  },

  async updateResource(id, patch) {
    const db = readRaw();
    const resource = db.resources.find(r => r.id === id);
    if (!resource) return null;
    const editable = ['title', 'courseCode', 'courseName', 'faculty', 'department', 'level', 'description', 'accessType', 'priceKobo', 'status'];
    editable.forEach(f => { if (patch[f] !== undefined) resource[f] = patch[f]; });
    if (resource.accessType === 'free') resource.priceKobo = 0;
    resource.updatedAt = new Date().toISOString();
    writeRaw(db);
    return resource;
  },

  // Replaces the stored file reference for a resource (a "new version").
  // The OLD storage key is returned so the caller can delete the old file
  // from storage after successfully writing the new one — see
  // routes/library.js's replace-file route for the ordering that avoids
  // ever deleting a file while it's still the resource's active version.
  async replaceResourceFile(id, { storageProvider, storageKey, originalFilename, fileSizeBytes, fileHash }) {
    const db = readRaw();
    const resource = db.resources.find(r => r.id === id);
    if (!resource) return null;
    const oldStorageKey = resource.storageKey;
    const oldStorageProvider = resource.storageProvider;
    resource.storageProvider = storageProvider;
    resource.storageKey = storageKey;
    resource.originalFilename = originalFilename;
    resource.fileSizeBytes = fileSizeBytes;
    resource.fileHash = fileHash || null;
    resource.updatedAt = new Date().toISOString();
    writeRaw(db);
    return { resource, oldStorageKey, oldStorageProvider };
  },

  // Hard delete — only safe to call once the caller has confirmed there's
  // no purchase history pointing at this resource (see routes/library.js).
  async deleteResource(id) {
    const db = readRaw();
    const before = db.resources.length;
    db.resources = db.resources.filter(r => r.id !== id);
    writeRaw(db);
    return db.resources.length < before;
  },

  async countPurchasesForResource(resourceId) {
    return readRaw().libraryPurchases.filter(p => p.resourceId === resourceId).length;
  },

  async findPurchase(userId, resourceId) {
    return readRaw().libraryPurchases.find(p => p.userId === userId && p.resourceId === resourceId) || null;
  },

  async findPurchaseByProviderReference(providerReference) {
    if (!providerReference) return null;
    return readRaw().libraryPurchases.find(p => p.providerReference === providerReference) || null;
  },

  // Atomic check-then-insert: does its read AND write in one synchronous
  // pass with no `await` in between, so two near-simultaneous calls for the
  // same user+resource cannot both observe "no existing purchase" and both
  // insert one. (Previously routes/library.js called findPurchase() and
  // createPurchase() as two separate awaited store calls with a yield point
  // between them — a real, confirmed race. This method replaces that.)
  async findOrCreatePurchase(data) {
    const db = readRaw();
    const existing = db.libraryPurchases.find(p => p.userId === data.userId && p.resourceId === data.resourceId);
    if (existing) return { purchase: existing, created: false };
    const purchase = {
      id: crypto.randomUUID(),
      userId: data.userId,
      resourceId: data.resourceId,
      status: data.status || 'pending',
      provider: data.provider || null,
      providerReference: data.providerReference || null,
      amountKobo: data.amountKobo || 0,
      createdAt: new Date().toISOString(),
      confirmedAt: data.status === 'success' ? new Date().toISOString() : null
    };
    db.libraryPurchases.push(purchase);
    writeRaw(db);
    return { purchase, created: true };
  },

  // Used by the (untested-live) Paystack webhook handler. Idempotent by
  // construction: if the purchase is already 'success', callers should
  // check that BEFORE calling this again — see routes/payments.js.
  async updatePurchaseStatus(id, status, extra = {}) {
    const db = readRaw();
    const purchase = db.libraryPurchases.find(p => p.id === id);
    if (!purchase) return null;
    purchase.status = status;
    if (extra.providerReference !== undefined) purchase.providerReference = extra.providerReference;
    if (status === 'success') purchase.confirmedAt = new Date().toISOString();
    writeRaw(db);
    return purchase;
  },

  async listPurchasesForUser(userId) {
    return readRaw().libraryPurchases.filter(p => p.userId === userId);
  },

  async listAllPurchases() {
    return readRaw().libraryPurchases;
  }
};
