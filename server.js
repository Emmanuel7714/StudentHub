// StudentHub — backend server
// This file is intentionally thin: it wires up the HTTP server, the route
// table, and static file serving. All actual route logic lives in
// routes/auth.js, routes/legacyPurchases.js, and routes/library.js — see
// PRODUCTION_READINESS.md for the audit that led to this split.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { PUBLIC_DIR, sendJSON, sendServerError } = require('./lib/core');
const { registerAuthRoutes } = require('./routes/auth');
const { registerLegacyPurchaseRoutes } = require('./routes/legacyPurchases');
const { registerLibraryRoutes } = require('./routes/library');
const { registerPaymentRoutes } = require('./routes/payments');

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------
const routes = [];
function route(method, matcher, handler) { routes.push({ method, matcher, handler }); }

registerAuthRoutes(route);
registerLegacyPurchaseRoutes(route); // deprecated — see that file's header comment
registerLibraryRoutes(route);
registerPaymentRoutes(route);

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
        // Previously this sent e.message straight to the client, which can
        // leak internal details for a genuine bug (as opposed to a
        // deliberate validation error, which routes already send via
        // sendJSON directly with a safe message and never reach this catch).
        catch (e) { return sendServerError(res, e, `${req.method} ${pathname}`); }
      }
    }
    return sendJSON(res, 404, { error: 'No such API route.' });
  }

  return serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`StudentHub server running at http://localhost:${PORT}`);
});
