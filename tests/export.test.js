process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || '';

const request = require('supertest');
const db = require('../src/db');
const { createApp } = require('../src/app');
const { seedDemo, DEMO_PASSWORD } = require('../src/seed');

let app;
let producerId;
const tokens = {};
const USERS = ['admin', 'mine_solwezi', 'trans_copperbelt', 'wb_kitwe', 'insp_ndola', 'reg_zra', 'buyer_alpine', 'border_katima', 'port_walvis'];
const as = (u) => ({ Authorization: 'Bearer ' + tokens[u] });
const ev = (u, code, body) => request(app).post(`/api/batches/${code}/events`).set(as(u)).send({ location: 'Lusaka', ...body });
const detail = async (u, code) => (await request(app).get('/api/batches/' + code).set(as(u))).body;
const status = async (code) => (await detail('admin', code)).batch.status;

/** A fresh in-transit batch, optionally already inspected (the point at which a permit decision is made). */
async function newBatch(inspected = true) {
  const r = await request(app).post('/api/batches').set(as('admin')).send({ producer_id: producerId, mineral: 'Gold', mine_site: 'Solwezi', declared_weight_kg: 10 });
  const code = r.body.batch.batch_code;
  await ev('admin', code, { event_type: 'DISPATCHED', location: 'Solwezi' });
  if (inspected) expect((await ev('insp_ndola', code, { event_type: 'INSPECTED', notes: 'ok' })).status).toBe(201);
  return code;
}
const grant = (u, code, notes = 'Permit ZRA/EX/1') => ev(u, code, { event_type: 'EXPORT_APPROVED', notes });
const refuse = (u, code, notes = 'Export licence has expired') => ev(u, code, { event_type: 'EXPORT_REJECTED', notes });

beforeAll(async () => {
  await db.init();
  await seedDemo();
  app = createApp();
  for (const u of USERS) {
    const r = await request(app).post('/api/auth/login').send({ username: u, password: DEMO_PASSWORD });
    tokens[u] = r.body.token;
  }
  producerId = (await request(app).get('/api/users').set(as('admin'))).body.users.find((u) => u.username === 'mine_solwezi').id;
});
afterAll(async () => { await db.close(); });

describe('who decides on export permits', () => {
  test.each(['reg_zra', 'admin'])('%s can grant or reject a permit', async (u) => {
    const a = await newBatch(); expect((await grant(u, a)).status).toBe(201); expect(await status(a)).toBe('export_approved');
    const b = await newBatch(); expect((await refuse(u, b)).status).toBe(201); expect(await status(b)).toBe('export_rejected');
  });

  test.each(['insp_ndola', 'border_katima', 'wb_kitwe', 'port_walvis', 'trans_copperbelt', 'mine_solwezi'])('%s cannot grant or reject a permit', async (u) => {
    const code = await newBatch();
    expect((await grant(u, code)).status).toBe(403);
    expect((await refuse(u, code)).status).toBe(403);
    expect(await status(code)).toBe('inspected');
  });

  test('the UI is told who gets the permit panel', async () => {
    const meta = async (u) => (await request(app).get('/api/meta').set(as(u))).body;
    expect((await meta('reg_zra')).can_decide_export).toBe(true);
    expect((await meta('admin')).can_decide_export).toBe(true);
    for (const u of ['insp_ndola', 'border_katima', 'wb_kitwe', 'buyer_alpine']) expect((await meta(u)).can_decide_export).toBe(false);
    const types = (await meta('reg_zra')).event_types.map((t) => t.type);
    expect(types).toEqual(expect.arrayContaining(['EXPORT_APPROVED', 'EXPORT_REJECTED']));
  });
});

describe('rejecting a permit', () => {
  test('needs a written reason', async () => {
    const code = await newBatch();
    expect((await ev('reg_zra', code, { event_type: 'EXPORT_REJECTED' })).status).toBe(400);
    expect((await ev('reg_zra', code, { event_type: 'EXPORT_REJECTED', notes: 'no' })).status).toBe(400);
    expect(await status(code)).toBe('inspected');
  });

  test('a permit can only be decided on an inspected consignment', async () => {
    const code = await newBatch(false); // in transit, not yet inspected
    expect((await refuse('reg_zra', code)).status).toBe(409);
    expect((await grant('reg_zra', code)).status).toBe(409);
  });

  test('a rejected consignment cannot be exported or shipped, but can be re-inspected and granted later', async () => {
    const code = await newBatch();
    await refuse('reg_zra', code);
    for (const type of ['EXPORTED', 'SHIPPED', 'RECEIVED', 'CHECKPOINT']) {
      const r = await ev('admin', code, { event_type: type });
      expect(r.status).toBe(409);
    }
    expect((await ev('admin', code, { event_type: 'EXPORTED' })).body.error).toMatch(/REJECTED/);
    // issue resolved: re-inspect, then grant, then it can be exported
    expect((await ev('insp_ndola', code, { event_type: 'INSPECTED', notes: 'Re-inspected, documents in order' })).status).toBe(201);
    expect((await grant('reg_zra', code, 'Permit ZRA/EX/2')).status).toBe(201);
    expect((await ev('reg_zra', code, { event_type: 'EXPORTED' })).status).toBe(201);
    expect(await status(code)).toBe('exported');
  });

  test('a granted permit can still be withdrawn before export, but not after', async () => {
    const code = await newBatch();
    await grant('reg_zra', code);
    expect((await refuse('reg_zra', code, 'Permit withdrawn: false declaration found')).status).toBe(201);
    expect(await status(code)).toBe('export_rejected');
    expect((await ev('reg_zra', code, { event_type: 'EXPORTED' })).status).toBe(409);
    // once exported the permit can no longer be withdrawn
    const done = await newBatch(); await grant('reg_zra', done); await ev('reg_zra', done, { event_type: 'EXPORTED' });
    expect((await refuse('reg_zra', done)).status).toBe(409);
  });

  test('is recorded in the chain, attributed, with the chain still valid', async () => {
    const code = await newBatch();
    await refuse('reg_zra', code, 'Mineral origin certificate missing');
    const d = await detail('admin', code);
    const last = d.events[d.events.length - 1];
    expect(last).toMatchObject({ event_type: 'EXPORT_REJECTED', label: 'Export permit rejected', actor_role: 'regulator', notes: 'Mineral origin certificate missing' });
    expect(d.integrity.valid).toBe(true);
  });
});

describe('interaction with the rest of the system', () => {
  test('a rejected permit can be put on hold and resumes back to "export permit rejected"', async () => {
    const code = await newBatch();
    await refuse('reg_zra', code);
    expect((await ev('wb_kitwe', code, { event_type: 'HOLD', notes: 'Weight check pending' })).status).toBe(201);
    expect(await status(code)).toBe('on_hold');
    await ev('wb_kitwe', code, { event_type: 'RESUMED', notes: 'Weight verified' });
    expect(await status(code)).toBe('export_rejected');
  });

  test('border posts still see a consignment whose permit was rejected', async () => {
    const code = await newBatch();
    await refuse('reg_zra', code);
    const list = (await request(app).get('/api/batches').set(as('border_katima'))).body.batches.map((b) => b.batch_code);
    expect(list).toContain(code);
  });

  test('the public portal shows the status but not the reason; the map and stats include it', async () => {
    const code = await newBatch();
    await refuse('reg_zra', code, 'Confidential licence issue');
    const token = (await detail('admin', code)).qr.token;
    const pub = await request(app).get('/api/public/verify').query({ t: token });
    expect(pub.body.batch.status).toBe('export_rejected');
    expect(pub.body.timeline.map((t) => t.label)).toContain('Export permit rejected');
    expect(JSON.stringify(pub.body)).not.toMatch(/Confidential/);
    const m = (await request(app).get('/api/map/consignments').set(as('reg_zra'))).body.consignments.find((c) => c.batch_code === code);
    expect(m.status).toBe('export_rejected');
    expect((await request(app).get('/api/stats').set(as('reg_zra'))).body.by_status.export_rejected).toBeGreaterThan(0);
  });
});
