// db/store.js
// Single entry point the rest of the app uses for resources/purchases data.
// Swap the backend by setting (or not setting) DATABASE_URL — nothing else
// in the app needs to change.

let store;
if (process.env.DATABASE_URL) {
  console.log('[db] DATABASE_URL is set — using Postgres store');
  store = require('./postgresStore');
} else {
  console.log('[db] No DATABASE_URL set — using the local JSON store (fine for dev, not for production)');
  store = require('./jsonStore');
}

module.exports = store;
