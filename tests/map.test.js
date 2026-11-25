process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || '';

const request = require('supertest');
const db = require('../src/db');
const geo = require('../src/geo');
const { createApp } = require('../src/app');
const { seedDemo, DEMO_PASSWORD } = require('../src/seed');

let app;
const tokens = {};
const as = (u) => ({ Authorization: 'Bearer ' + tokens[u] });
const map = async (u) => (await request(app).get('/api/map/consignments').set(as(u))).body;

beforeAll(async () => {
  await db.init();
  await seedDemo();
  app = createApp();
  for (const u of ['admin', 'mine_solwezi', 'buyer_alpine', 'border_katima']) {
    const r = await request(app).post('/api/auth/login').send({ username: u, password: DEMO_PASSWORD });
    tokens[u] = r.body.token;
  }
});
afterAll(async () => { await db.close(); });

describe('security headers', () => {
  test('CSP lets the map load OpenStreetMap tiles (bare host) but nothing else external for images', async () => {
    const csp = (await request(app).get('/')).headers['content-security-policy'];
    const img = csp.split(';').map((x) => x.trim()).find((x) => x.startsWith('img-src'));
    expect(img).toContain('https://tile.openstreetmap.org');
    expect(img).not.toMatch(/\*(?!\.tile)/); // no wildcard source
    expect(csp).toMatch(/script-src 'self' https:\/\/unpkg.com/);
  });
});

describe('geo helpers', () => {
  test('a stop with coordinates wins over the gazetteer; free text falls back to it', () => {
    const r = geo.makeResolver([{ name: 'Kitwe Weighbridge', latitude: -1, longitude: 2 }]);
    expect(r('Kitwe Weighbridge')).toMatchObject({ lat: -1, lng: 2 });
    expect(r('Kitwe Weighbridge, Copperbelt')).toMatchObject({ lat: -1, lng: 2 });
    expect(r('ZRA Head Office, Lusaka').name).toBe('Lusaka');
    expect(r('Katima Mulilo Border Post').name).toBe('Katima Mulilo Border Post'); // not just "Katima Mulilo"
    expect(r('Somewhere unknown')).toBeNull();
    expect(r('')).toBeNull();
  });
  test('coordinate input is validated', () => {
    expect(geo.parseCoords('', '')).toBeNull();
    expect(geo.parseCoords('-12.5', '28.2')).toEqual({ latitude: -12.5, longitude: 28.2 });
    expect(() => geo.parseCoords('-12.5', '')).toThrow(/both/);
    expect(() => geo.parseCoords('95', '10')).toThrow();
    expect(() => geo.parseCoords('abc', '10')).toThrow();
  });
});

describe('GET /api/map/consignments', () => {
  test('requires a login', async () => {
    expect((await request(app).get('/api/map/consignments')).status).toBe(401);
  });

  test('admin sees every consignment with its route in order of custody', async () => {
    const d = await map('admin');
    expect(d.consignments).toHaveLength(8);
    const received = d.consignments.find((c) => c.status === 'received');
    const places = received.waypoints.map((w) => w.place);
    expect(places[0]).toBe('Solwezi Copper Mine');
    expect(places).toContain('Walvis Bay Port');
    expect(places[places.length - 1]).toMatch(/Switzerland/);
    expect(received.current.place).toMatch(/Switzerland/);
    // waypoints keep the event order and merge consecutive events at one place
    const seqs = received.waypoints.map((w) => w.first_seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    const atMine = received.waypoints[0];
    expect(atMine.events.length).toBeGreaterThan(1);
    expect(d.consignments.every((c) => c.unmapped.length === 0)).toBe(true);
    expect(d.consignments.find((c) => c.flagged)).toBeTruthy(); // the under-declared cobalt batch
  });

  test('visibility is identical to the batch list (buyer: own shipments; border post: only on the move)', async () => {
    for (const u of ['mine_solwezi', 'buyer_alpine', 'border_katima']) {
      const list = (await request(app).get('/api/batches').set(as(u))).body.batches.map((b) => b.batch_code).sort();
      const onMap = (await map(u)).consignments.map((c) => c.batch_code).sort();
      expect(onMap).toEqual(list);
    }
    const border = (await map('border_katima')).consignments;
    expect(border.some((c) => c.status === 'registered' || c.status === 'processed')).toBe(false);
  });

  test('places that cannot be located are listed as unmapped, not guessed', async () => {
    const producer = (await request(app).get('/api/users').set(as('admin'))).body.users.find((u) => u.username === 'mine_solwezi').id;
    const code = (await request(app).post('/api/batches').set(as('admin')).send({ producer_id: producer, mineral: 'Gold', mine_site: 'Solwezi', declared_weight_kg: 3 })).body.batch.batch_code;
    const ev = await request(app).post(`/api/batches/${code}/events`).set(as('admin')).send({ event_type: 'DISPATCHED', location: 'Nowhereville Depot' });
    expect(ev.status).toBe(201);
    const c = (await map('admin')).consignments.find((x) => x.batch_code === code);
    expect(c.unmapped).toEqual(['Nowhereville Depot']);
    expect(c.waypoints).toHaveLength(1); // only the mine; the unknown place is not plotted
  });
});

describe('stop coordinates', () => {
  const mk = (b) => request(app).post('/api/stops').set(as('admin')).send({ country: 'Zambia', stop_type: 'depot', ...b });

  test('an admin can place a new stop, and events there appear at those coordinates', async () => {
    const r = await mk({ name: 'Test Depot Alpha', latitude: '-10.5', longitude: '30.25' });
    expect(r.status).toBe(201);
    expect(r.body.stop).toMatchObject({ latitude: -10.5, longitude: 30.25 });
    const producer = (await request(app).get('/api/users').set(as('admin'))).body.users.find((u) => u.username === 'mine_solwezi').id;
    const code = (await request(app).post('/api/batches').set(as('admin')).send({ producer_id: producer, mineral: 'Gold', mine_site: 'Solwezi', declared_weight_kg: 2 })).body.batch.batch_code;
    await request(app).post(`/api/batches/${code}/events`).set(as('admin')).send({ event_type: 'DISPATCHED', location: 'Test Depot Alpha' });
    const c = (await map('admin')).consignments.find((x) => x.batch_code === code);
    expect(c.current).toMatchObject({ place: 'Test Depot Alpha', lat: -10.5, lng: 30.25 });
  });

  test('a well-known place name is located automatically', async () => {
    const r = await mk({ name: 'Livingstone' });
    expect(r.status).toBe(201);
    expect(r.body.stop.latitude).toBeCloseTo(-17.84, 1);
  });

  test('bad or half-filled coordinates are rejected; an unknown name without any is allowed but unplaced', async () => {
    expect((await mk({ name: 'Bad One', latitude: '120', longitude: '10' })).status).toBe(400);
    expect((await mk({ name: 'Half One', latitude: '10' })).status).toBe(400);
    const r = await mk({ name: 'Mystery Yard' });
    expect(r.status).toBe(201);
    expect(r.body.stop.latitude).toBeNull();
  });
});
