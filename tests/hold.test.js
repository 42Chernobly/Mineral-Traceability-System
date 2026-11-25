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
const ev = (u, code, body) => request(app).post(`/api/batches/${code}/events`).set(as(u)).send(body);
const detail = async (u, code) => (await request(app).get('/api/batches/' + code).set(as(u))).body;

/** A fresh batch registered by admin; with `dispatched` it is moved to in_transit. */
async function newBatch(dispatched = true) {
  const r = await request(app).post('/api/batches').set(as('admin')).send({ producer_id: producerId, mineral: 'Gold', mine_site: 'Solwezi', declared_weight_kg: 10 });
  const code = r.body.batch.batch_code;
  if (dispatched) expect((await ev('admin', code, { event_type: 'DISPATCHED', location: 'Solwezi' })).status).toBe(201);
  return code;
}
const reject = (u, code, notes = 'Container seal broken on arrival') => ev(u, code, { event_type: 'REJECTED', location: 'Checkpoint', notes });

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

describe('who may stop and resume a consignment', () => {
  test.each(['admin', 'insp_ndola', 'border_katima', 'wb_kitwe'])('%s can reject a consignment', async (u) => {
    const code = await newBatch();
    const r = await reject(u, code);
    expect(r.status).toBe(201);
    expect((await detail('admin', code)).batch.status).toBe('rejected');
  });

  test.each(['admin', 'insp_ndola', 'border_katima', 'wb_kitwe'])('%s can place on hold and resume', async (u) => {
    const code = await newBatch();
    expect((await ev(u, code, { event_type: 'HOLD', location: 'Checkpoint', notes: 'Paperwork query' })).status).toBe(201);
    expect((await detail('admin', code)).batch.status).toBe('on_hold');
    expect((await ev(u, code, { event_type: 'RESUMED', location: 'Checkpoint', notes: 'Paperwork supplied' })).status).toBe(201);
    expect((await detail('admin', code)).batch.status).toBe('in_transit');
  });

  test.each(['mine_solwezi', 'trans_copperbelt', 'reg_zra', 'port_walvis', 'buyer_alpine'])('%s cannot reject, hold or resume', async (u) => {
    const code = await newBatch();
    for (const type of ['REJECTED', 'HOLD', 'RESUMED']) {
      const r = await ev(u, code, { event_type: type, location: 'Anywhere', notes: 'Trying it on' });
      expect([403, 404]).toContain(r.status); // 404 when the role cannot even see the batch
    }
    expect((await detail('admin', code)).batch.status).toBe('in_transit');
  });

  test('the UI is told who gets the controls, and they are not in the ordinary event list', async () => {
    const meta = async (u) => (await request(app).get('/api/meta').set(as(u))).body;
    for (const u of ['admin', 'insp_ndola', 'border_katima', 'wb_kitwe']) expect((await meta(u)).can_hold).toBe(true);
    for (const u of ['mine_solwezi', 'trans_copperbelt', 'reg_zra', 'port_walvis', 'buyer_alpine']) expect((await meta(u)).can_hold).toBe(false);
    const types = (await meta('admin')).event_types.map((t) => t.type);
    expect(types).not.toEqual(expect.arrayContaining(['HOLD']));
    expect(types).not.toContain('REJECTED');
    expect(types).not.toContain('RESUMED');
  });
});

describe('a stopped consignment cannot go any further', () => {
  test('every other event is refused, for every role including admin', async () => {
    const code = await newBatch();
    await reject('wb_kitwe', code);
    const attempts = [
      ['admin', { event_type: 'INSPECTED' }], ['admin', { event_type: 'CHECKPOINT' }], ['admin', { event_type: 'DISPATCHED' }],
      ['admin', { event_type: 'WEIGHBRIDGE', weight_kg: 10 }], ['insp_ndola', { event_type: 'INSPECTED' }],
      ['reg_zra', { event_type: 'EXPORT_APPROVED' }], ['border_katima', { event_type: 'CHECKPOINT' }],
    ];
    for (const [u, body] of attempts) {
      const r = await ev(u, code, { location: 'Somewhere', ...body });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/REJECTED/);
    }
    expect((await detail('admin', code)).batch.event_count).toBe(3); // registered, dispatched, rejected: nothing slipped in
  });

  test('a stop or a resume needs a written reason', async () => {
    const code = await newBatch();
    expect((await ev('admin', code, { event_type: 'REJECTED', location: 'X' })).status).toBe(400);
    expect((await ev('admin', code, { event_type: 'REJECTED', location: 'X', notes: 'no' })).status).toBe(400);
    await reject('admin', code);
    expect((await ev('admin', code, { event_type: 'RESUMED', location: 'X', notes: '   ' })).status).toBe(400);
    expect((await detail('admin', code)).batch.status).toBe('rejected');
  });

  test('cannot resume something that is not stopped, or stop something already received', async () => {
    const code = await newBatch();
    expect((await ev('admin', code, { event_type: 'RESUMED', location: 'X', notes: 'Nothing to resume' })).status).toBe(409);
    expect((await ev('admin', 'ZM-CU-2026-0001', { event_type: 'HOLD', location: 'X', notes: 'Already received' })).status).toBe(409); // received in the demo data
    expect((await ev('admin', 'ZM-CU-2026-0001', { event_type: 'REJECTED', location: 'X', notes: 'Already received' })).status).toBe(409);
  });

  test('a stop-bound officer cannot change the location of the control event', async () => {
    const code = await newBatch();
    await reject('wb_kitwe', code);
    const events = (await detail('admin', code)).events;
    expect(events[events.length - 1].location).toBe('Kitwe Weighbridge');
  });
});

describe('resume goes back to where the consignment was', () => {
  test('inspected -> reject -> resume continues from inspected, and the chain stays valid', async () => {
    const code = await newBatch();
    expect((await ev('insp_ndola', code, { event_type: 'INSPECTED', location: 'Ndola', notes: 'ok' })).status).toBe(201);
    expect((await reject('border_katima', code)).status).toBe(201);
    let d = await detail('admin', code);
    expect(d.batch.status).toBe('rejected');
    expect(d.batch.resume_status).toBe('inspected');
    expect(d.integrity.valid).toBe(true);
    expect((await ev('wb_kitwe', code, { event_type: 'RESUMED', location: 'X', notes: 'Investigation closed, seals verified' })).status).toBe(201);
    d = await detail('admin', code);
    expect(d.batch.status).toBe('inspected');
    expect(d.batch.resume_status).toBeNull();
    expect(d.integrity.valid).toBe(true);
    // and it really can move on again
    expect((await ev('reg_zra', code, { event_type: 'EXPORT_APPROVED', location: 'Lusaka', notes: 'permit' })).status).toBe(201);
  });

  test('hold then reject then resume still returns to the original stage', async () => {
    const code = await newBatch();
    await ev('wb_kitwe', code, { event_type: 'HOLD', location: 'X', notes: 'Weight query' });
    await reject('insp_ndola', code, 'Seal tampered, escalating');
    expect((await detail('admin', code)).batch.status).toBe('rejected');
    await ev('admin', code, { event_type: 'RESUMED', location: 'X', notes: 'All cleared by inspectorate' });
    expect((await detail('admin', code)).batch.status).toBe('in_transit');
  });

  test('every stop and release is a permanent, attributed event in the chain', async () => {
    const code = await newBatch();
    await reject('border_katima', code, 'Broken container seal');
    await ev('admin', code, { event_type: 'RESUMED', location: 'Lusaka', notes: 'Cleared after re-seal' });
    const d = await detail('admin', code);
    const [, , rej, res] = d.events;
    expect(rej).toMatchObject({ event_type: 'REJECTED', actor_role: 'border', notes: 'Broken container seal', details: { resume_status: 'in_transit' } });
    expect(res).toMatchObject({ event_type: 'RESUMED', actor_role: 'admin', details: { resumed_to: 'in_transit' } });
    expect(res.prev_hash).toBe(rej.hash);
  });

  test('forging the "return to" stage in the database is detected', async () => {
    const code = await newBatch();
    await reject('admin', code);
    await db.query("UPDATE events SET details = '{\"resume_status\":\"exported\"}' WHERE event_type='REJECTED' AND batch_id = (SELECT id FROM batches WHERE batch_code=$1)", [code]);
    expect((await detail('admin', code)).integrity.valid).toBe(false);
  });
});

describe('who can see a stopped consignment', () => {
  test('border posts only see stopped consignments that were already on the move', async () => {
    const early = await newBatch(false); // still at the mine
    const moving = await newBatch(true);
    await ev('admin', early, { event_type: 'HOLD', location: 'Solwezi', notes: 'Paperwork query at the mine' });
    await ev('admin', moving, { event_type: 'HOLD', location: 'Solwezi', notes: 'Paperwork query en route' });
    const list = (await request(app).get('/api/batches').set(as('border_katima'))).body.batches.map((b) => b.batch_code);
    expect(list).toContain(moving);
    expect(list).not.toContain(early);
    expect((await request(app).get('/api/batches/' + early).set(as('border_katima'))).status).toBe(404);
    expect((await request(app).get('/api/batches/' + moving).set(as('border_katima'))).status).toBe(200);
  });

  test('the public portal shows the stop but not the reason', async () => {
    const code = await newBatch();
    await reject('admin', code, 'Confidential investigation detail');
    const token = (await detail('admin', code)).qr.token;
    const r = await request(app).get('/api/public/verify').query({ t: token });
    expect(r.body.batch.status).toBe('rejected');
    expect(r.body.chain.valid).toBe(true);
    expect(r.body.timeline.map((t) => t.label)).toContain('Rejected – pending investigation');
    expect(JSON.stringify(r.body)).not.toMatch(/Confidential/);
  });

  test('the dashboard map and stats include stopped consignments', async () => {
    const code = await newBatch();
    await reject('admin', code);
    const m = (await request(app).get('/api/map/consignments').set(as('admin'))).body.consignments.find((c) => c.batch_code === code);
    expect(m.status).toBe('rejected');
    const s = (await request(app).get('/api/stats').set(as('admin'))).body;
    expect(s.by_status.rejected).toBeGreaterThan(0);
  });
});
