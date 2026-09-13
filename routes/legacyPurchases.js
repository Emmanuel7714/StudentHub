// routes/legacyPurchases.js
// The ORIGINAL demo purchase flow, extracted from server.js unchanged in
// behavior (still simulates instant payment success against the hardcoded
// data/seed.json resources). This predates the real Library/Marketplace
// feature (routes/library.js + db/store.js) and is kept only so the
// original prototype's "Unlock"/"My Library" UI keeps working.
//
// THIS IS DEPRECATED. See PRODUCTION_READINESS.md for the consolidation
// plan — the short version: once real Paystack payments are wired into
// the Library feature, migrate any real purchase data (if this ever ran
// with real users) into the `purchases` table/store and remove this file
// and its two routes + the "My Library" nav item entirely. Not done yet
// because migrating live data blindly, with no real users to migrate in
// this environment, isn't something to do speculatively — see the plan
// for the actual steps to take when this matters.

const crypto = require('crypto');
const { SEED, readDB, writeDB, getSessionUser, sendJSON, readBody } = require('../lib/core');

function registerLegacyPurchaseRoutes(route) {
  route('POST', '/api/purchases', async (req, res) => {
    const db = readDB();
    const user = getSessionUser(req, db);
    if (!user) return sendJSON(res, 401, { error: 'Log in to unlock resources.' });

    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJSON(res, 413, { error: e.message }, { 'Connection': 'close' }); }
    const resource = SEED.resources.find(r => r.id === body.resourceId);
    if (!resource) return sendJSON(res, 404, { error: 'Resource not found.' });

    const existing = db.purchases.find(p => p.userId === user.id && p.resourceId === resource.id);
    if (existing) return sendJSON(res, 200, { purchase: existing, alreadyOwned: true });

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
}

module.exports = { registerLegacyPurchaseRoutes };
