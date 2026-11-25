const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const svc = require('./service');
const accounts = require('./accounts');
const qr = require('./qr');
const chain = require('./hashchain');
const P = require('./permissions');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Render / Railway / AWS load balancer (TLS terminates there)

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://unpkg.com'],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:', 'blob:', ...config.map.imgOrigins], // basemap tiles come from the configured provider only
          connectSrc: ["'self'"],
          mediaSrc: ["'self'", 'blob:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.isProd ? [] : null,
        },
      },
      // Tile providers expect to see which site is asking; Helmet's default (no-referrer) hides that.
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      hsts: config.isProd ? undefined : false, // HSTS only when served over HTTPS in production
    })
  );
  app.use(express.json({ limit: '100kb' }));

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test',
    message: { error: 'Too many login attempts, try again later' },
  });
  const publicLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test',
    message: { error: 'Too many requests, slow down' },
  });

  // ---------- Health ----------
  app.get('/api/health', wrap(async (req, res) => {
    await db.query('SELECT 1');
    res.json({ status: 'ok', database: db.getMode(), time: new Date().toISOString() });
  }));

  // ---------- Auth ----------
  app.post('/api/auth/login', loginLimiter, wrap(async (req, res) => {
    const username = String((req.body || {}).username || '').trim().toLowerCase();
    const password = String((req.body || {}).password || '');
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
    const { rows } = await db.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    // Same response for unknown user / wrong password / disabled account
    const passwordOk = user && (await auth.checkPassword(password, user.password_hash));
    if (passwordOk && user.active && user.status === 'pending') {
      return res.status(403).json({ error: 'Your access request is still waiting for administrator approval.' });
    }
    if (passwordOk && user.active && user.status === 'rejected') {
      return res.status(403).json({ error: 'Your access request was not approved. Contact the administrator.' });
    }
    const ok = passwordOk && user.active && user.status === 'active';
    if (!ok) return res.status(401).json({ error: 'Invalid username or password' });
    res.json({
      token: auth.signToken(user),
      user: { id: user.id, username: user.username, full_name: user.full_name, organisation: user.organisation, role: user.role },
    });
  }));

  // ---------- Sign-up at a stop (public; the account stays pending until an admin approves it) ----------
  const signupLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test',
    message: { error: 'Too many sign-up requests from this address, try again later' },
  });

  app.get('/api/public/stops', publicLimiter, wrap(async (req, res) => {
    res.json({ stops: await accounts.listStops({ onlyActive: true }) });
  }));

  app.post('/api/auth/signup', signupLimiter, wrap(async (req, res) => {
    const out = await accounts.signup(req.body || {});
    res.status(201).json({
      message: 'Request received. An administrator must approve it before you can sign in.',
      status: 'pending',
      role: out.user.role,
      role_label: P.ROLE_LABELS[out.user.role],
      stop: out.stop.name,
    });
  }));

  // ---------- Public verification portal (no login, limited data) ----------
  app.get('/api/public/verify', publicLimiter, wrap(async (req, res) => {
    const code = qr.parseToken(req.query.t);
    if (!code) {
      return res.status(404).json({ genuine: false, error: 'This QR code is not a genuine, signed batch identifier' });
    }
    const batch = await svc.getBatchRow(code);
    if (!batch) return res.status(404).json({ genuine: false, error: 'No such batch is registered' });
    const events = await svc.getEvents(batch.id);
    const integrity = chain.verifyChain(code, events, batch);
    // Commercially sensitive data (weights, notes, buyer, details) is NOT exposed publicly
    res.json({
      genuine: true,
      batch: {
        batch_code: batch.batch_code,
        mineral: batch.mineral,
        origin_mine: batch.mine_site,
        province: batch.province,
        producer: batch.producer_org,
        status: batch.status,
        flagged: batch.flagged,
        registered_at: batch.created_at,
      },
      chain: { valid: integrity.valid, events_checked: integrity.checked, reason: integrity.reason, head_hash: batch.head_hash },
      timeline: events.map((e) => ({
        seq: e.seq,
        label: P.EVENT_RULES[e.event_type].label,
        location: e.location,
        organisation: e.actor_org,
        occurred_at: e.occurred_at,
        hash: e.hash,
      })),
    });
  }));

  // ---------- Everything below needs a valid JWT ----------
  app.use('/api', auth.authenticate);

  app.get('/api/auth/me', (req, res) => res.json({
    user: req.user,
    role_label: P.ROLE_LABELS[req.user.role],
    stop: req.user.stop_name ? { name: req.user.stop_name, country: req.user.stop_country, region: req.user.stop_region } : null,
  }));

  app.get('/api/meta', wrap(async (req, res) => {
    const eventTypes = P.EVENT_TYPES.filter((t) => t !== 'REGISTERED' && !P.CONTROL_EVENTS.includes(t) && P.EVENT_RULES[t].roles.includes(req.user.role))
      .map((t) => ({ type: t, label: P.EVENT_RULES[t].label }));
    let buyers = [];
    if (['mine', 'admin'].includes(req.user.role)) {
      buyers = (await db.query("SELECT id, organisation FROM users WHERE role='buyer' AND active ORDER BY organisation")).rows;
    }
    res.json({
      role: req.user.role,
      role_label: P.ROLE_LABELS[req.user.role],
      event_types: eventTypes,
      minerals: svc.MINERALS,
      buyers,
      can_register: ['mine', 'admin'].includes(req.user.role),
      can_audit: ['regulator', 'admin'].includes(req.user.role),
      can_hold: P.HOLD_ROLES.includes(req.user.role),
      tamper_demo: config.enableTamperDemo && req.user.role === 'admin',
      map: { tile_url: config.map.tileUrl, tile_url_dark: config.map.tileUrlDark, attribution: config.map.attribution, subdomains: config.map.subdomains },
      stop: req.user.stop_name ? { name: req.user.stop_name, country: req.user.stop_country, region: req.user.stop_region } : null,
    });
  }));

  app.get('/api/stats', wrap(async (req, res) => res.json(await svc.stats(req.user))));

  // Consignment movement for the dashboard map (same visibility rules as the batch list)
  app.get('/api/map/consignments', wrap(async (req, res) => res.json(await svc.mapData(req.user))));

  // ---------- Batches ----------
  app.get('/api/batches', wrap(async (req, res) => {
    res.json({ batches: await svc.listBatches(req.user, { status: req.query.status, q: req.query.q }) });
  }));

  app.post('/api/batches', auth.requireRole('mine', 'admin'), wrap(async (req, res) => {
    const detail = await svc.createBatch(req.user, req.body || {});
    res.status(201).json(detail);
  }));

  app.get('/api/batches/:code', wrap(async (req, res) => {
    const detail = await svc.getBatchDetail(req.user, req.params.code.toUpperCase());
    detail.qr = { token: qr.makeToken(detail.batch.batch_code), url: qr.verifyUrl(qr.makeToken(detail.batch.batch_code), req) };
    res.json(detail);
  }));

  app.get('/api/batches/:code/qr', wrap(async (req, res) => {
    const code = req.params.code.toUpperCase();
    const batch = await svc.getBatchRow(code);
    if (!batch || !svc.canView(req.user, batch)) throw new svc.HttpError(404, 'Batch not found');
    const png = await qr.qrPngBuffer(qr.verifyUrl(qr.makeToken(code), req));
    res.set('Content-Type', 'image/png').set('Cache-Control', 'private, max-age=300').send(png);
  }));

  app.post('/api/batches/:code/events', wrap(async (req, res) => {
    const out = await svc.addEvent(req.user, req.params.code.toUpperCase(), req.body || {});
    res.status(out.duplicate ? 200 : 201).json(out);
  }));

  // Offline queue sync: scans captured without connectivity are submitted later
  app.post('/api/events/sync', wrap(async (req, res) => {
    const items = Array.isArray((req.body || {}).events) ? req.body.events.slice(0, 100) : null;
    if (!items) return res.status(400).json({ error: 'events array is required' });
    const results = [];
    for (const it of items) {
      try {
        const out = await svc.addEvent(req.user, String(it.batch_code || '').toUpperCase(), it, { offline: true });
        results.push({ client_ref: it.client_ref || null, ok: true, duplicate: out.duplicate, seq: out.event.seq });
      } catch (err) {
        if (err instanceof svc.HttpError) {
          results.push({ client_ref: it.client_ref || null, ok: false, status: err.status, error: err.message });
        } else throw err;
      }
    }
    res.json({ results });
  }));

  // Authenticated scan: validates the signed QR token and returns the batch
  app.post('/api/scan/resolve', wrap(async (req, res) => {
    const code = qr.parseToken((req.body || {}).token);
    if (!code) return res.status(400).json({ error: 'QR code is not a genuine, signed batch identifier' });
    const detail = await svc.getBatchDetail(req.user, code);
    res.json(detail);
  }));

  // ---------- Audit (regulator / admin) ----------
  app.get('/api/audit/verify', auth.requireRole('regulator', 'admin'), wrap(async (req, res) => {
    res.json(await svc.verifyAll());
  }));

  // ---------- Users (admin) ----------
  app.get('/api/users', auth.requireRole('admin'), wrap(async (req, res) => {
    res.json({ users: await accounts.listUsers() });
  }));

  app.post('/api/users', auth.requireRole('admin'), wrap(async (req, res) => {
    res.status(201).json({ user: await accounts.adminCreateUser(req.body || {}) });
  }));

  app.post('/api/users/:id/approve', auth.requireRole('admin'), wrap(async (req, res) => {
    res.json({ user: await accounts.approve(req.params.id) });
  }));

  app.post('/api/users/:id/reject', auth.requireRole('admin'), wrap(async (req, res) => {
    res.json({ user: await accounts.reject(req.params.id) });
  }));

  // ---------- Stops (admin manages the places people can sign up at) ----------
  app.get('/api/stops', auth.requireRole('admin'), wrap(async (req, res) => {
    res.json({ stops: await accounts.listStops(), types: P.STOP_TYPES });
  }));

  app.post('/api/stops', auth.requireRole('admin'), wrap(async (req, res) => {
    res.status(201).json({ stop: await accounts.createStop(req.body || {}) });
  }));

  app.patch('/api/stops/:id/active', auth.requireRole('admin'), wrap(async (req, res) => {
    res.json({ stop: await accounts.setStopActive(req.params.id, (req.body || {}).active) });
  }));

  app.patch('/api/users/:id/active', auth.requireRole('admin'), wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) throw new svc.HttpError(400, 'You cannot disable your own account');
    const { rows } = await db.query('UPDATE users SET active=$1 WHERE id=$2 RETURNING id, username, active', [!!(req.body || {}).active, id]);
    if (!rows.length) throw new svc.HttpError(404, 'User not found');
    res.json({ user: rows[0] });
  }));

  // ---------- Tamper demonstration (disabled unless ENABLE_TAMPER_DEMO=true) ----------
  // Simulates an insider editing the database directly, to show detection by the hash chain.
  const originals = new Map();
  if (config.enableTamperDemo) {
    app.post('/api/admin/demo/tamper', auth.requireRole('admin'), wrap(async (req, res) => {
      const code = String((req.body || {}).batch_code || '').toUpperCase();
      const batch = await svc.getBatchRow(code);
      if (!batch) throw new svc.HttpError(404, 'Batch not found');
      const { rows } = await db.query('SELECT id, weight_kg FROM events WHERE batch_id=$1 AND weight_kg IS NOT NULL ORDER BY seq LIMIT 1', [batch.id]);
      if (!rows.length) throw new svc.HttpError(400, 'Batch has no weighted event to tamper with');
      originals.set(code, { id: rows[0].id, weight: rows[0].weight_kg });
      const forged = (Number(rows[0].weight_kg) * 0.8).toFixed(3);
      await db.query('UPDATE events SET weight_kg=$1 WHERE id=$2', [forged, rows[0].id]); // bypasses the API on purpose
      res.json({ tampered: true, event_id: rows[0].id, original_weight_kg: Number(rows[0].weight_kg), forged_weight_kg: Number(forged) });
    }));
    app.post('/api/admin/demo/restore', auth.requireRole('admin'), wrap(async (req, res) => {
      const code = String((req.body || {}).batch_code || '').toUpperCase();
      const o = originals.get(code);
      if (!o) throw new svc.HttpError(404, 'Nothing to restore for this batch');
      await db.query('UPDATE events SET weight_kg=$1 WHERE id=$2', [o.weight, o.id]);
      originals.delete(code);
      res.json({ restored: true });
    }));
  }

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // ---------- Static frontend ----------
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  // ---------- Error handler ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof svc.HttpError || err instanceof accounts.AccountError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
