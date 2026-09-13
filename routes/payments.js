// routes/payments.js
// Payment architecture for the Library/Marketplace feature. Built around
// Paystack, using real HTTPS calls to Paystack's API and real webhook
// signature verification — NOT faked. See PRODUCTION_READINESS.md for
// exactly what could and couldn't be verified in this environment (no
// network access here, so nothing that requires reaching Paystack's
// servers has been exercised against the real thing).
//
// Flow:
//   1. Client calls POST /api/resources/:id/purchase-intent
//   2. If PAYSTACK_SECRET_KEY is configured, this calls Paystack's
//      "initialize transaction" endpoint and returns the authorization_url
//      for the client to redirect to. If not configured, it behaves as
//      before: creates a 'pending' purchase and says payment isn't wired
//      up yet — access stays locked either way.
//   3. Student pays on Paystack's hosted checkout.
//   4. Paystack calls POST /api/webhooks/paystack (server-to-server).
//      The signature is verified using PAYSTACK_SECRET_KEY. Only after
//      verifying the signature AND independently calling Paystack's
//      "verify transaction" endpoint does a purchase get marked 'success'.
//   5. GET /api/resources/:id/access (routes/library.js) already checks
//      for a 'success' purchase — no changes needed there.
//
// Idempotency: findOrCreatePurchase (db/store.js) prevents duplicate
// purchase rows for the same user+resource at the data layer (atomic in
// both the JSON store and, more robustly, via a real unique constraint in
// Postgres). The webhook handler additionally checks providerReference
// and short-circuits if that reference was already processed, so a
// retried/duplicate webhook delivery (which Paystack explicitly says can
// happen) never double-processes a payment.

const crypto = require('crypto');
const {
  readDB, requireAuth, sendJSON, sendServerError, readBody, readRawBody, requireRateLimit
} = require('../lib/core');
const store = require('../db/store');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || null;
const PAYSTACK_BASE_URL = 'https://api.paystack.co';

function verifyPaystackSignature(rawBody, signatureHeader) {
  if (!PAYSTACK_SECRET_KEY || !signatureHeader) return false;
  const expected = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(signatureHeader), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Real HTTPS calls to Paystack. Both are only ever invoked when
// PAYSTACK_SECRET_KEY is set — neither has been exercised against
// Paystack's actual servers in this environment (no network access here).
async function paystackInitialize({ email, amountKobo, reference, metadata }) {
  const res = await fetch(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email, amount: amountKobo, reference, metadata })
  });
  const data = await res.json();
  if (!res.ok || !data.status) throw new Error(data.message || 'Paystack initialize failed');
  return data.data; // { authorization_url, access_code, reference }
}
async function paystackVerify(reference) {
  const res = await fetch(`${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}` }
  });
  const data = await res.json();
  if (!res.ok || !data.status) throw new Error(data.message || 'Paystack verify failed');
  return data.data; // { status: 'success'|'failed'|..., amount, reference, ... }
}

function registerPaymentRoutes(route) {
  route('POST', '/api/resources/:id/purchase-intent', async (req, res, params) => {
    if (!requireRateLimit(req, res, 'purchase-intent', 20, 10 * 60 * 1000)) return;

    const db = readDB();
    const user = requireAuth(req, res, db);
    if (!user) return;

    const resource = await store.getResource(params.id);
    if (!resource) return sendJSON(res, 404, { error: 'Resource not found.' });
    if (resource.accessType === 'free') return sendJSON(res, 400, { error: 'This resource is free — no purchase needed.' });

    // Atomic: see db/jsonStore.js / db/postgresStore.js findOrCreatePurchase
    // for why this is one call instead of a separate find-then-create
    // (the latter was a confirmed race — two near-simultaneous requests
    // could create two purchase rows before the fix).
    const { purchase, created } = await store.findOrCreatePurchase({
      userId: user.id, resourceId: resource.id, status: 'pending',
      provider: PAYSTACK_SECRET_KEY ? 'paystack' : null,
      amountKobo: resource.priceKobo
    });

    if (purchase.status === 'success') {
      return sendJSON(res, 200, { purchase, alreadyOwned: true });
    }

    if (!PAYSTACK_SECRET_KEY) {
      return sendJSON(res, 202, {
        purchase,
        message: 'Payment integration is not connected yet (PAYSTACK_SECRET_KEY not set). This resource cannot be unlocked until Paystack is configured — see README.md.'
      });
    }

    // Real integration path — UNTESTED against Paystack's live servers in
    // the environment this was built in (no network access there).
    try {
      const reference = purchase.providerReference || `sh_${purchase.id}`;
      const init = await paystackInitialize({
        email: user.email,
        amountKobo: resource.priceKobo,
        reference,
        metadata: { purchaseId: purchase.id, resourceId: resource.id, userId: user.id }
      });
      await store.updatePurchaseStatus(purchase.id, 'pending', { providerReference: reference });
      sendJSON(res, 200, { purchase: { ...purchase, providerReference: reference }, authorizationUrl: init.authorization_url });
    } catch (e) {
      sendServerError(res, e, 'paystack-initialize');
    }
  });

  // Paystack calls this server-to-server. It is NOT authenticated with a
  // session cookie (Paystack has no session) — authenticity instead comes
  // entirely from the signature check below. This is why the raw body is
  // needed (see lib/core.js's readRawBody) rather than the already-parsed
  // readBody: the signature is computed over the exact bytes Paystack sent.
  route('POST', '/api/webhooks/paystack', async (req, res) => {
    let rawBody;
    try { rawBody = await readRawBody(req, 1024 * 1024); }
    catch (e) { return sendJSON(res, 413, { error: 'Payload too large' }); }

    const signature = req.headers['x-paystack-signature'];
    if (!verifyPaystackSignature(rawBody, signature)) {
      // Deliberately vague — do not tell a forged caller which part failed.
      return sendJSON(res, 401, { error: 'Invalid signature.' });
    }

    let event;
    try { event = JSON.parse(rawBody.toString('utf8')); }
    catch (e) { return sendJSON(res, 400, { error: 'Invalid JSON.' }); }

    if (event.event !== 'charge.success') {
      // Acknowledge and ignore anything we don't act on — Paystack expects a 200.
      return sendJSON(res, 200, { received: true });
    }

    const reference = event.data?.reference;
    if (!reference) return sendJSON(res, 400, { error: 'Missing reference.' });

    // Idempotency: if this reference was already processed to success,
    // acknowledge without doing anything else. Paystack explicitly
    // documents that webhooks can be delivered more than once.
    const existing = await store.findPurchaseByProviderReference(reference);
    if (existing && existing.status === 'success') {
      return sendJSON(res, 200, { received: true, alreadyProcessed: true });
    }

    try {
      // Never trust the webhook payload's own "it succeeded" claim alone —
      // independently ask Paystack to confirm via the verify endpoint.
      const verified = await paystackVerify(reference);
      if (verified.status !== 'success') {
        if (existing) await store.updatePurchaseStatus(existing.id, 'failed');
        return sendJSON(res, 200, { received: true, verified: false });
      }
      const purchaseId = event.data?.metadata?.purchaseId;
      if (existing) {
        await store.updatePurchaseStatus(existing.id, 'success', { providerReference: reference });
      } else if (purchaseId) {
        await store.updatePurchaseStatus(purchaseId, 'success', { providerReference: reference });
      }
      sendJSON(res, 200, { received: true, verified: true });
    } catch (e) {
      // Log server-side; return a non-2xx so Paystack retries — verification
      // failing due to a transient network error SHOULD be retried, unlike
      // an invalid signature (which we deliberately don't retry-encourage).
      console.error('[paystack-webhook] verify failed', e);
      sendJSON(res, 502, { error: 'Could not verify with Paystack, please retry.' });
    }
  });
}

module.exports = { registerPaymentRoutes };
