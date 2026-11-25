process.env.NODE_ENV = 'test';
process.env.ENABLE_TAMPER_DEMO = 'true';
// Defaults to the in-memory DB. Set TEST_DATABASE_URL to run against a real (empty) PostgreSQL database.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || '';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/db');
const { createApp } = require('../src/app');
const { seedDemo, DEMO_PASSWORD } = require('../src/seed');

let app;
const tokens = {};

async function login(username, password = DEMO_PASSWORD) {
  const r = await request(app).post('/api/auth/login').send({ username, password });
  return r;
}
const as = (u) => ({ Authorization: 'Bearer ' + tokens[u] });

beforeAll(async () => {
  await db.init();
  await seedDemo();
  app = createApp();
  for (const u of ['admin', 'mine_solwezi', 'mine_mufulira', 'trans_copperbelt', 'wb_kitwe', 'insp_ndola', 'reg_zra', 'buyer_alpine', 'buyer_shenzhen', 'border_katima', 'wb_katima', 'port_walvis']) {
    const r = await login(u);
    expect(r.status).toBe(200);
    tokens[u] = r.body.token;
  }
});
afterAll(async () => { await db.close(); });

describe('authentication (JWT)', () => {
  test('wrong password rejected with generic message', async () => {
    const r = await login('admin', 'nope');
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('Invalid username or password');
  });
  test('no token -> 401', async () => {
    expect((await request(app).get('/api/batches')).status).toBe(401);
  });
  test('garbage token -> 401', async () => {
    expect((await request(app).get('/api/batches').set('Authorization', 'Bearer abc.def.ghi')).status).toBe(401);
  });
  test('token signed with the wrong secret -> 401', async () => {
    const bad = jwt.sign({ role: 'admin' }, 'x'.repeat(40), { algorithm: 'HS256', issuer: config.jwtIssuer, audience: config.jwtAudience, subject: '1' });
    expect((await request(app).get('/api/batches').set('Authorization', 'Bearer ' + bad)).status).toBe(401);
  });
  test('alg=none token -> 401', async () => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: '1', iss: config.jwtIssuer, aud: config.jwtAudience, exp: 9999999999 })}.`;
    expect((await request(app).get('/api/batches').set('Authorization', 'Bearer ' + none)).status).toBe(401);
  });
  test('wrong audience / issuer -> 401', async () => {
    const t1 = jwt.sign({}, config.jwtSecret, { algorithm: 'HS256', issuer: 'evil', audience: config.jwtAudience, subject: '1' });
    const t2 = jwt.sign({}, config.jwtSecret, { algorithm: 'HS256', issuer: config.jwtIssuer, audience: 'other', subject: '1' });
    expect((await request(app).get('/api/batches').set('Authorization', 'Bearer ' + t1)).status).toBe(401);
    expect((await request(app).get('/api/batches').set('Authorization', 'Bearer ' + t2)).status).toBe(401);
  });
  test('expired token -> 401', async () => {
    const t = jwt.sign({}, config.jwtSecret, { algorithm: 'HS256', issuer: config.jwtIssuer, audience: config.jwtAudience, subject: '1', expiresIn: -10 });
    expect((await request(app).get('/api/batches').set('Authorization', 'Bearer ' + t)).status).toBe(401);
  });
  test('passwords are stored hashed, never returned', async () => {
    const r = await request(app).get('/api/users').set(as('admin'));
    expect(JSON.stringify(r.body)).not.toMatch(/password/i);
  });
});

describe('role-based access control', () => {
  test('mine sees only own batches; buyer only consigned ones; regulator sees all', async () => {
    const mine = (await request(app).get('/api/batches').set(as('mine_solwezi'))).body.batches;
    const reg = (await request(app).get('/api/batches').set(as('reg_zra'))).body.batches;
    const buyer = (await request(app).get('/api/batches').set(as('buyer_alpine'))).body.batches;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((b) => b.producer_org.includes('Solwezi'))).toBe(true);
    expect(reg.length).toBe(8);
    expect(buyer.length).toBeGreaterThan(0);
    expect(buyer.every((b) => b.buyer_org.includes('Alpine'))).toBe(true);
  });
  test('object-level authorization: another mine cannot read or write my batch', async () => {
    const own = (await request(app).get('/api/batches').set(as('mine_solwezi'))).body.batches[0].batch_code;
    expect((await request(app).get('/api/batches/' + own).set(as('mine_mufulira'))).status).toBe(404);
    const w = await request(app).post(`/api/batches/${own}/events`).set(as('mine_mufulira')).send({ event_type: 'PROCESSED', location: 'x' });
    expect(w.status).toBe(404);
  });
  test('only mines can register batches', async () => {
    const r = await request(app).post('/api/batches').set(as('trans_copperbelt')).send({ mineral: 'Gold', mine_site: 'x', declared_weight_kg: 1 });
    expect(r.status).toBe(403);
  });
  test('only regulator/admin can audit; only admin manages users', async () => {
    expect((await request(app).get('/api/audit/verify').set(as('mine_solwezi'))).status).toBe(403);
    expect((await request(app).get('/api/audit/verify').set(as('buyer_alpine'))).status).toBe(403);
    expect((await request(app).get('/api/users').set(as('reg_zra'))).status).toBe(403);
    expect((await request(app).get('/api/audit/verify').set(as('reg_zra'))).status).toBe(200);
  });
  test('transporter cannot issue export permits; inspector cannot record weight', async () => {
    const reg = (await request(app).get('/api/batches?status=inspected').set(as('reg_zra'))).body.batches[0].batch_code;
    const a = await request(app).post(`/api/batches/${reg}/events`).set(as('trans_copperbelt')).send({ event_type: 'EXPORT_APPROVED', location: 'x' });
    expect(a.status).toBe(403);
    const b = await request(app).post(`/api/batches/${reg}/events`).set(as('insp_ndola')).send({ event_type: 'WEIGHBRIDGE', location: 'x', weight_kg: 5 });
    expect(b.status).toBe(403);
  });
  test('buyer is read-only: cannot record custody events, and RECEIVED is refused before export', async () => {
    const code = (await request(app).get('/api/batches?status=in_transit').set(as('buyer_alpine'))).body.batches[0].batch_code;
    const a = await request(app).post(`/api/batches/${code}/events`).set(as('buyer_alpine')).send({ event_type: 'INSPECTED', location: 'x' });
    expect(a.status).toBe(403);
    const b = await request(app).post(`/api/batches/${code}/events`).set(as('buyer_alpine')).send({ event_type: 'RECEIVED', location: 'x' });
    expect(b.status).toBe(409);
  });
});

describe('batch lifecycle and hash chain via the API', () => {
  let code;
  test('mine registers a batch -> REGISTERED event, valid chain, QR', async () => {
    const r = await request(app).post('/api/batches').set(as('mine_solwezi')).send({
      mineral: 'Copper cathode', mine_site: 'Solwezi', province: 'North-Western', declared_weight_kg: 25000, grade: 'A', destination: 'Switzerland',
    });
    expect(r.status).toBe(201);
    code = r.body.batch.batch_code;
    expect(r.body.events).toHaveLength(1);
    expect(r.body.integrity.valid).toBe(true);
    const d = await request(app).get('/api/batches/' + code).set(as('mine_solwezi'));
    expect(d.body.qr.token).toMatch(/^v1\./);
    const png = await request(app).get(`/api/batches/${code}/qr`).set(as('mine_solwezi'));
    expect(png.status).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
  });
  test('state machine blocks out-of-order steps', async () => {
    const r = await request(app).post(`/api/batches/${code}/events`).set(as('reg_zra')).send({ event_type: 'EXPORTED', location: 'x' });
    expect(r.status).toBe(409);
  });
  test('weighbridge reading within tolerance is not flagged; beyond tolerance is', async () => {
    let r = await request(app).post(`/api/batches/${code}/events`).set(as('wb_kitwe')).send({ event_type: 'WEIGHBRIDGE', location: 'Kitwe', weight_kg: 25100 });
    expect(r.status).toBe(201);
    expect(r.body.flagged).toBe(false);
    r = await request(app).post(`/api/batches/${code}/events`).set(as('wb_kitwe')).send({ event_type: 'WEIGHBRIDGE', location: 'Kitwe', weight_kg: 20000 });
    expect(r.status).toBe(201);
    expect(r.body.flagged).toBe(true);
    expect(r.body.event.details.weight_discrepancy).toBe(true);
  });
  test('full journey to RECEIVED then chain is closed', async () => {
    const steps = [
      ['mine_solwezi', 'DISPATCHED'], ['insp_ndola', 'INSPECTED'], ['reg_zra', 'EXPORT_APPROVED'], ['reg_zra', 'EXPORTED'], ['buyer_alpine', 'RECEIVED'],
    ];
    // This batch has no buyer assigned, so only the first four steps are exercised here.
    for (const [u, t] of steps.slice(0, 4)) {
      const r = await request(app).post(`/api/batches/${code}/events`).set(as(u)).send({ event_type: t, location: 'Somewhere' });
      expect(r.status).toBe(201);
    }
    const d = await request(app).get('/api/batches/' + code).set(as('reg_zra'));
    expect(d.body.batch.status).toBe('exported');
    expect(d.body.integrity.valid).toBe(true);
    expect(d.body.events.length).toBe(7); // registered + 2 weighbridge + dispatched/inspected/approved/exported
  });
  test('input validation', async () => {
    const bad = await request(app).post('/api/batches').set(as('mine_solwezi')).send({ mineral: 'Unobtainium', mine_site: 'x', declared_weight_kg: 5 });
    expect(bad.status).toBe(400);
    const neg = await request(app).post('/api/batches').set(as('mine_solwezi')).send({ mineral: 'Gold', mine_site: 'x', declared_weight_kg: -5 });
    expect(neg.status).toBe(400);
    const fut = await request(app).post(`/api/batches/${code}/events`).set(as('reg_zra')).send({ event_type: 'CHECKPOINT', location: 'x', occurred_at: '2099-01-01' });
    expect(fut.status).toBe(400); // CHECKPOINT is valid after export, so the future date is what is rejected
  });
});

describe('offline sync (risk R1)', () => {
  test('queued events sync idempotently by client_ref', async () => {
    const code = (await request(app).post('/api/batches').set(as('mine_mufulira')).send({ mineral: 'Gold', mine_site: 'Mufulira', declared_weight_kg: 10 })).body.batch.batch_code;
    const ev = { batch_code: code, event_type: 'PROCESSED', location: 'Mufulira', client_ref: 'ref-123', occurred_at: new Date(Date.now() - 60000).toISOString() };
    const first = await request(app).post('/api/events/sync').set(as('mine_mufulira')).send({ events: [ev] });
    expect(first.body.results[0]).toMatchObject({ ok: true, duplicate: false });
    const again = await request(app).post('/api/events/sync').set(as('mine_mufulira')).send({ events: [ev] });
    expect(again.body.results[0]).toMatchObject({ ok: true, duplicate: true });
    const d = await request(app).get('/api/batches/' + code).set(as('mine_mufulira'));
    expect(d.body.events.filter((e) => e.event_type === 'PROCESSED')).toHaveLength(1);
    expect(d.body.events[1].offline).toBe(true);
    expect(d.body.integrity.valid).toBe(true);
  });
});

describe('signed QR codes and public portal (risk R3)', () => {
  let token; let code;
  beforeAll(async () => {
    code = (await request(app).get('/api/batches').set(as('reg_zra'))).body.batches[0].batch_code;
    token = (await request(app).get('/api/batches/' + code).set(as('reg_zra'))).body.qr.token;
  });
  test('genuine token verifies publicly without login and hides sensitive data', async () => {
    const r = await request(app).get('/api/public/verify').query({ t: token });
    expect(r.status).toBe(200);
    expect(r.body.genuine).toBe(true);
    expect(r.body.chain.valid).toBe(true);
    const s = JSON.stringify(r.body);
    expect(s).not.toMatch(/weight_kg|declared_weight|buyer|notes/);
  });
  test('full scanned URL is accepted', async () => {
    const r = await request(app).get('/api/public/verify').query({ t: `https://x.example/verify.html?t=${encodeURIComponent(token)}` });
    expect(r.status).toBe(200);
  });
  test('forged signature rejected', async () => {
    const forged = token.slice(0, -3) + (token.endsWith('aaa') ? 'bbb' : 'aaa');
    expect((await request(app).get('/api/public/verify').query({ t: forged })).status).toBe(404);
  });
  test('valid-looking code for a non-existent batch rejected (cannot mint QR codes)', async () => {
    expect((await request(app).get('/api/public/verify').query({ t: 'v1.ZM-CU-2026-9999.AAAAAAAAAAAAAAAAAAAAAA' })).status).toBe(404);
  });
  test('token of one batch cannot be re-pointed at another', async () => {
    const swapped = token.replace(code, 'ZM-CU-2026-0002');
    expect((await request(app).get('/api/public/verify').query({ t: swapped })).status).toBe(404);
  });
});

describe('tamper detection (database edited behind the API)', () => {
  test('audit detects a forged weight, then passes again after restore', async () => {
    const clean = await request(app).get('/api/audit/verify').set(as('reg_zra'));
    expect(clean.body.batches_tampered).toBe(0);

    const target = 'ZM-CU-2026-0001';
    const t = await request(app).post('/api/admin/demo/tamper').set(as('admin')).send({ batch_code: target });
    expect(t.status).toBe(200);

    const audit = await request(app).get('/api/audit/verify').set(as('reg_zra'));
    expect(audit.body.batches_tampered).toBe(1);
    const bad = audit.body.results.find((r) => !r.valid);
    expect(bad.batch_code).toBe(target);

    const pub = await request(app).get('/api/public/verify').query({ t: (await request(app).get('/api/batches/' + target).set(as('admin'))).body.qr.token });
    expect(pub.body.chain.valid).toBe(false);

    await request(app).post('/api/admin/demo/restore').set(as('admin')).send({ batch_code: target });
    expect((await request(app).get('/api/audit/verify').set(as('reg_zra'))).body.batches_tampered).toBe(0);
  });
  test('tamper endpoints are admin-only', async () => {
    expect((await request(app).post('/api/admin/demo/tamper').set(as('mine_solwezi')).send({ batch_code: 'ZM-CU-2026-0001' })).status).toBe(403);
  });
});

describe('user management', () => {
  test('admin creates a user, who can log in; disabled users are locked out', async () => {
    const c = await request(app).post('/api/users').set(as('admin')).send({ username: 'new.weigh', password: 'Str0ngPass!', role: 'weighbridge', full_name: 'New Weigh', organisation: 'Test WB' });
    expect(c.status).toBe(201);
    const l = await login('new.weigh', 'Str0ngPass!');
    expect(l.status).toBe(200);
    const off = await request(app).patch(`/api/users/${c.body.user.id}/active`).set(as('admin')).send({ active: false });
    expect(off.status).toBe(200);
    expect((await request(app).get('/api/batches').set({ Authorization: 'Bearer ' + l.body.token })).status).toBe(401);
    expect((await login('new.weigh', 'Str0ngPass!')).status).toBe(401);
  });
  test('weak password / bad role rejected', async () => {
    expect((await request(app).post('/api/users').set(as('admin')).send({ username: 'abc', password: 'short', role: 'mine', full_name: 'a', organisation: 'b' })).status).toBe(400);
    expect((await request(app).post('/api/users').set(as('admin')).send({ username: 'abc', password: 'longenough1', role: 'god', full_name: 'a', organisation: 'b' })).status).toBe(400);
  });
});

describe('security headers', () => {
  test('helmet CSP and no x-powered-by', async () => {
    const r = await request(app).get('/api/health');
    expect(r.headers['content-security-policy']).toBeDefined();
    expect(r.headers['x-powered-by']).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------------------------
// Stops, sign-up requests and approval
// ---------------------------------------------------------------------------------------------
describe('stops and sign-up at each stop', () => {
  const stopId = async (name) => (await request(app).get('/api/public/stops')).body.stops.find((x) => x.name === name).id;
  const signup = (body) => request(app).post('/api/auth/signup').send(body);
  const base = { password: 'Sup3rSecret!', full_name: 'Test Person', organisation: 'Test Org (Demo)' };

  async function signupApprove(username, stopName) {
    const r = await signup({ ...base, username, stop_id: await stopId(stopName) });
    expect(r.status).toBe(201);
    const list = (await request(app).get('/api/users').set(as('admin'))).body.users;
    const id = list.find((u) => u.username === username).id;
    expect((await request(app).post(`/api/users/${id}/approve`).set(as('admin'))).status).toBe(200);
    const l = await login(username, base.password);
    expect(l.status).toBe(200);
    tokens[username] = l.body.token;
    return { id, role: l.body.user.role };
  }

  test('public stops list needs no login and shows the role each stop gets', async () => {
    const r = await request(app).get('/api/public/stops');
    expect(r.status).toBe(200);
    const walvis = r.body.stops.find((x) => x.name === 'Walvis Bay Port');
    expect(walvis).toMatchObject({ country: 'Namibia', stop_type: 'port', role: 'port' });
    expect(r.body.stops.find((x) => x.name === 'Katima Mulilo Border Post').role).toBe('border');
    expect(r.body.stops.find((x) => x.name === 'Katima Mulilo Weighbridge').role).toBe('weighbridge');
    expect(r.body.stops.find((x) => x.name === 'Solwezi Copper Mine').role).toBe('mine');
  });

  test('sign-up creates a pending account that cannot sign in until approved', async () => {
    const r = await signup({ ...base, username: 'walvis.new', stop_id: await stopId('Walvis Bay Port') });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('pending');
    expect(r.body.role).toBe('port');
    expect(JSON.stringify(r.body)).not.toMatch(/password/i);
    const l = await login('walvis.new', base.password);
    expect(l.status).toBe(403);
    expect(l.body.error).toMatch(/waiting for administrator approval/i);
    expect(l.body.token).toBeUndefined();
    // a wrong password must not reveal that the account exists or is pending
    expect((await login('walvis.new', 'wrong-password')).status).toBe(401);
  });

  test('applicant cannot choose their role: privileged roles are ignored', async () => {
    const r = await signup({ ...base, username: 'wants.admin', role: 'admin', stop_id: await stopId('Kitwe Weighbridge') });
    expect(r.status).toBe(201);
    expect(r.body.role).toBe('weighbridge');
    const none = await signup({ ...base, username: 'no.stop', role: 'regulator' });
    expect(none.status).toBe(400); // a stop is mandatory, so there is no way to self-register as regulator
  });

  test('sign-up validation: duplicate username, weak password, bad / inactive stop', async () => {
    const id = await stopId('Walvis Bay Port');
    expect((await signup({ ...base, username: 'walvis.new', stop_id: id })).status).toBe(409);
    expect((await signup({ ...base, username: 'weakpw', password: 'short', stop_id: id })).status).toBe(400);
    expect((await signup({ ...base, username: 'bad stop', stop_id: id })).status).toBe(400);
    expect((await signup({ ...base, username: 'ghost.stop', stop_id: 99999 })).status).toBe(400);
    expect((await signup({ ...base, username: 'nofull', full_name: '', stop_id: id })).status).toBe(400);
  });

  test('only an admin can approve or reject; approval enables sign-in and attaches the stop', async () => {
    const list = (await request(app).get('/api/users').set(as('admin'))).body.users;
    const pending = list.find((u) => u.username === 'walvis.new');
    expect(pending.status).toBe('pending');
    expect(pending.stop_name).toBe('Walvis Bay Port');
    expect((await request(app).post(`/api/users/${pending.id}/approve`).set(as('reg_zra'))).status).toBe(403);
    expect((await request(app).post(`/api/users/${pending.id}/approve`)).status).toBe(401);
    expect((await request(app).post(`/api/users/${pending.id}/approve`).set(as('admin'))).status).toBe(200);
    expect((await request(app).post(`/api/users/${pending.id}/approve`).set(as('admin'))).status).toBe(409);
    const l = await login('walvis.new', base.password);
    expect(l.status).toBe(200);
    const me = await request(app).get('/api/auth/me').set({ Authorization: 'Bearer ' + l.body.token });
    expect(me.body.stop).toMatchObject({ name: 'Walvis Bay Port', country: 'Namibia' });
    expect(me.body.user.role).toBe('port');
  });

  test('rejected requests cannot sign in', async () => {
    await signup({ ...base, username: 'to.reject', stop_id: await stopId('Kasumbalesa Border Post') });
    const id = (await request(app).get('/api/users').set(as('admin'))).body.users.find((u) => u.username === 'to.reject').id;
    expect((await request(app).post(`/api/users/${id}/reject`).set(as('admin'))).status).toBe(200);
    const l = await login('to.reject', base.password);
    expect(l.status).toBe(403);
    expect(l.body.error).toMatch(/not approved/i);
  });

  test('a pending token cannot be used even if one existed (status is checked on every request)', async () => {
    await signup({ ...base, username: 'sneaky', stop_id: await stopId('Walvis Bay Port') });
    const id = (await request(app).get('/api/users').set(as('admin'))).body.users.find((u) => u.username === 'sneaky').id;
    const forged = jwt.sign({}, config.jwtSecret, { algorithm: 'HS256', issuer: config.jwtIssuer, audience: config.jwtAudience, subject: String(id) });
    expect((await request(app).get('/api/batches').set('Authorization', 'Bearer ' + forged)).status).toBe(401);
  });

  describe('operators at the Zambia -> Namibia -> Walvis Bay route', () => {
    let code;
    beforeAll(async () => {
      code = (await request(app).post('/api/batches').set(as('mine_solwezi')).send({
        mineral: 'Copper cathode', mine_site: 'Typed Over Site', province: 'Typed Over', declared_weight_kg: 25000, destination: 'Switzerland',
      })).body.batch.batch_code;
    });

    test('mine operator registers at their own mine; typed site is replaced by the stop', async () => {
      const d = (await request(app).get('/api/batches/' + code).set(as('mine_solwezi'))).body;
      expect(d.batch.mine_site).toBe('Solwezi Copper Mine');
      expect(d.batch.province).toBe('North-Western');
      expect(d.events[0].location).toBe('Solwezi Copper Mine');
    });

    test('mine operator declares a processed consignment ready for export (and nobody else can)', async () => {
      const early = await request(app).post(`/api/batches/${code}/events`).set(as('mine_solwezi')).send({ event_type: 'EXPORT_READY' });
      expect(early.status).toBe(409); // must be processed first
      expect((await request(app).post(`/api/batches/${code}/events`).set(as('mine_solwezi')).send({ event_type: 'PROCESSED' })).status).toBe(201);
      expect((await request(app).post(`/api/batches/${code}/events`).set(as('trans_copperbelt')).send({ event_type: 'EXPORT_READY', location: 'x' })).status).toBe(403);
      const ok = await request(app).post(`/api/batches/${code}/events`).set(as('mine_solwezi')).send({ event_type: 'EXPORT_READY', notes: 'Sealed' });
      expect(ok.status).toBe(201);
      expect(ok.body.event.label).toBe('Declared ready for export');
      expect(ok.body.status).toBe('processed'); // readiness does not change the status
    });

    test('foreign stops cannot see a consignment that is still at the mine', async () => {
      const border = await signupApprove('katima.officer2', 'Katima Mulilo Border Post');
      expect(border.role).toBe('border');
      expect((await request(app).get('/api/batches/' + code).set(as('katima.officer2'))).status).toBe(404);
      const list = (await request(app).get('/api/batches').set(as('border_katima'))).body.batches;
      expect(list.every((b) => ['in_transit', 'inspected', 'export_approved', 'exported', 'shipped', 'received'].includes(b.status))).toBe(true);
      expect(list.find((b) => b.batch_code === code)).toBeUndefined();
    });

    test('consignment travels out of Zambia; each new stop operator records at their own stop', async () => {
      const steps = [
        ['mine_solwezi', 'DISPATCHED'], ['insp_ndola', 'INSPECTED'], ['reg_zra', 'EXPORT_APPROVED'], ['reg_zra', 'EXPORTED'],
      ];
      for (const [u, t] of steps) {
        expect((await request(app).post(`/api/batches/${code}/events`).set(as(u)).send({ event_type: t, location: 'Somewhere' })).status).toBe(201);
      }
      // Namibian border: location typed by the client is ignored
      const cp = await request(app).post(`/api/batches/${code}/events`).set(as('border_katima')).send({ event_type: 'CHECKPOINT', location: 'Somewhere Else', notes: 'Seals intact' });
      expect(cp.status).toBe(201);
      expect(cp.body.event.location).toBe('Katima Mulilo Border Post');
      expect(cp.body.event.actor_role).toBe('border');
      // Namibian weighbridge
      const wb = await request(app).post(`/api/batches/${code}/events`).set(as('wb_katima')).send({ event_type: 'WEIGHBRIDGE', weight_kg: 25010 });
      expect(wb.status).toBe(201);
      expect(wb.body.event.location).toBe('Katima Mulilo Weighbridge');
      expect(wb.body.flagged).toBe(false);
      // Port: a new operator signs up at Walvis Bay, is approved, and ships the consignment
      const port = await signupApprove('walvis.op2', 'Walvis Bay Port');
      expect(port.role).toBe('port');
      const early = await request(app).post(`/api/batches/${code}/events`).set(as('walvis.op2')).send({ event_type: 'EXPORT_APPROVED' });
      expect(early.status).toBe(403); // a port operator cannot issue export permits
      const ship = await request(app).post(`/api/batches/${code}/events`).set(as('walvis.op2')).send({ event_type: 'SHIPPED', location: 'Not Walvis Bay', notes: 'Loaded on MV Test' });
      expect(ship.status).toBe(201);
      expect(ship.body.event.location).toBe('Walvis Bay Port');
      expect(ship.body.status).toBe('shipped');

      const d = (await request(app).get('/api/batches/' + code).set(as('reg_zra'))).body;
      expect(d.integrity.valid).toBe(true);
      expect(d.batch.status).toBe('shipped');
      expect(d.events.map((e) => e.location).slice(-3)).toEqual(['Katima Mulilo Border Post', 'Katima Mulilo Weighbridge', 'Walvis Bay Port']);
    });

    test('a shipped consignment cannot be shipped twice or have a border event out of order', async () => {
      expect((await request(app).post(`/api/batches/${code}/events`).set(as('walvis.op2')).send({ event_type: 'SHIPPED' })).status).toBe(409);
      expect((await request(app).post(`/api/batches/${code}/events`).set(as('border_katima')).send({ event_type: 'PROCESSED' })).status).toBe(403);
    });

    test('the public portal shows the new stops without exposing who the operators are', async () => {
      const token = (await request(app).get('/api/batches/' + code).set(as('reg_zra'))).body.qr.token;
      const r = await request(app).get('/api/public/verify').query({ t: token });
      expect(r.body.chain.valid).toBe(true);
      expect(r.body.timeline.map((e) => e.location)).toContain('Walvis Bay Port');
      expect(JSON.stringify(r.body)).not.toMatch(/username|password|contact/);
    });
  });

  describe('several operators per mine, each mine isolated', () => {
    test('a second operator at Solwezi shares Solwezi batches but not Mufulira ones', async () => {
      const op2 = await signupApprove('solwezi.op2', 'Solwezi Copper Mine');
      expect(op2.role).toBe('mine');
      const mine = (await request(app).get('/api/batches').set(as('solwezi.op2'))).body.batches;
      const first = (await request(app).get('/api/batches').set(as('mine_solwezi'))).body.batches;
      expect(mine.map((b) => b.batch_code).sort()).toEqual(first.map((b) => b.batch_code).sort());
      expect(mine.every((b) => b.producer_org.includes('Solwezi'))).toBe(true);
      const mufulira = (await request(app).get('/api/batches').set(as('mine_mufulira'))).body.batches[0].batch_code;
      expect((await request(app).get('/api/batches/' + mufulira).set(as('solwezi.op2'))).status).toBe(404);
    });

    test('the colleague can add information to a batch their colleague registered', async () => {
      const code = (await request(app).post('/api/batches').set(as('mine_solwezi')).send({ mineral: 'Gold', declared_weight_kg: 5 })).body.batch.batch_code;
      const r = await request(app).post(`/api/batches/${code}/events`).set(as('solwezi.op2')).send({ event_type: 'PROCESSED', notes: 'Second shift' });
      expect(r.status).toBe(201);
      expect(r.body.event.actor_org).toMatch(/Test Org/);
      expect(r.body.event.location).toBe('Solwezi Copper Mine');
    });

    test('a new mine added by the admin gets its own operator, isolated from the others', async () => {
      const mk = await request(app).post('/api/stops').set(as('admin')).send({ name: 'Lumwana Copper Mine', country: 'Zambia', region: 'North-Western', stop_type: 'mine' });
      expect(mk.status).toBe(201);
      const lumwana = await signupApprove('lumwana.op', 'Lumwana Copper Mine');
      expect(lumwana.role).toBe('mine');
      const reg = await request(app).post('/api/batches').set(as('lumwana.op')).send({ mineral: 'Copper concentrate', declared_weight_kg: 30000 });
      expect(reg.status).toBe(201);
      expect(reg.body.batch.mine_site).toBe('Lumwana Copper Mine');
      expect((await request(app).get('/api/batches/' + reg.body.batch.batch_code).set(as('mine_solwezi'))).status).toBe(404);
      expect((await request(app).get('/api/batches').set(as('lumwana.op'))).body.batches).toHaveLength(1);
    });
  });

  describe('managing stops and accounts (admin)', () => {
    test('only admins manage stops; duplicates and bad types are rejected', async () => {
      const body = { name: 'Tunduma Border Post', country: 'Tanzania', region: 'Songwe', stop_type: 'border' };
      expect((await request(app).post('/api/stops').set(as('mine_solwezi')).send(body)).status).toBe(403);
      expect((await request(app).post('/api/stops').set(as('admin')).send(body)).status).toBe(201);
      expect((await request(app).post('/api/stops').set(as('admin')).send(body)).status).toBe(409);
      expect((await request(app).post('/api/stops').set(as('admin')).send({ ...body, name: 'X', stop_type: 'regulator' })).status).toBe(400);
      expect((await request(app).get('/api/stops').set(as('reg_zra'))).status).toBe(403);
    });

    test('a deactivated stop disappears from the public sign-up list and rejects new requests', async () => {
      const id = await stopId('Tunduma Border Post');
      expect((await request(app).patch(`/api/stops/${id}/active`).set(as('admin')).send({ active: false })).status).toBe(200);
      expect((await request(app).get('/api/public/stops')).body.stops.find((x) => x.id === id)).toBeUndefined();
      expect((await signup({ ...base, username: 'tunduma.op', stop_id: id })).status).toBe(400);
    });

    test('admin-created user at a stop gets the stop role and is active immediately', async () => {
      const r = await request(app).post('/api/users').set(as('admin')).send({
        username: 'direct.port', password: 'Str0ngPass!', full_name: 'Direct', organisation: 'Port Ltd', role: 'admin', stop_id: await stopId('Walvis Bay Port'),
      });
      expect(r.status).toBe(201);
      expect(r.body.user.role).toBe('port'); // the stop decides, not the requested role
      expect((await login('direct.port', 'Str0ngPass!')).status).toBe(200);
    });
  });
});
