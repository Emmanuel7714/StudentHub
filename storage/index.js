// storage/index.js
// Picks the file-storage backend based on STORAGE_PROVIDER.
//   STORAGE_PROVIDER=s3     -> storage/s3Adapter.js  (production)
//   anything else / unset   -> storage/localAdapter.js (dev only — see its warning)

let adapter;
if (process.env.STORAGE_PROVIDER === 's3') {
  adapter = require('./s3Adapter');
} else {
  adapter = require('./localAdapter');
}

module.exports = adapter;
