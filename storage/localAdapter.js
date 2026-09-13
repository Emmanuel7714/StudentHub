// storage/localAdapter.js
// Dev/testing-only storage: PDFs are written to a private directory on
// local disk, outside the public/ static-file root (so they're never
// directly web-servable — only routes/library.js's authorized /access
// endpoint can read them).
//
// This is NOT suitable for Render (or any host with an ephemeral/
// non-persistent filesystem) in production — an app restart or redeploy
// wipes this directory. Use STORAGE_PROVIDER=s3 for anything real.
// This adapter exists so the feature is fully testable locally with zero
// cloud setup.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { ROOT } = require('../lib/core');

const STORAGE_DIR = path.join(ROOT, 'private-uploads');
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

function resolveKey(key) {
  // Defense in depth: storage keys are always server-generated UUIDs (see
  // routes/library.js), but never trust a path segment even so.
  const safe = path.normalize(key).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(STORAGE_DIR, safe);
  if (!full.startsWith(STORAGE_DIR)) throw new Error('Invalid storage key');
  return full;
}

module.exports = {
  provider: 'local',
  warning: 'Using local disk storage — fine for local dev/testing, NOT durable in production (e.g. on Render). Set STORAGE_PROVIDER=s3 for real deployments.',

  async putObject(key, buffer) {
    const full = resolveKey(key);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, buffer);
  },

  async getObjectBuffer(key) {
    return fsp.readFile(resolveKey(key));
  },

  async deleteObject(key) {
    try { await fsp.unlink(resolveKey(key)); } catch (e) { /* already gone is fine */ }
  },

  // Local storage has no concept of a signed URL — the route handler
  // streams the bytes directly through the server instead when this
  // returns null.
  async getPresignedDownloadUrl() {
    return null;
  }
};
