/**
 * Demo data. ALL organisations, people and batches are SIMULATED. Volumes, minerals and
 * destinations are modelled on public Zambian figures (copper cathode to Switzerland /
 * China / Singapore / UAE, Copperbelt & North-Western province mines and checkpoints).
 */
const db = require('./db');
const auth = require('./auth');
const svc = require('./service');
const geo = require('./geo');

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Demo@12345';

// [username, full name, organisation, role, stop name]
const USERS = [
  ['admin', 'System Administrator', 'Traceability Platform Admin', 'admin', null],
  ['mine_solwezi', 'Mwansa Chilufya', 'Solwezi Copper Mine (Demo)', 'mine', 'Solwezi Copper Mine'],
  ['mine_mufulira', 'Bwalya Mumba', 'Mufulira Smelter & Refinery (Demo)', 'mine', 'Mufulira Smelter & Refinery'],
  ['mine_kalumbila', 'Chanda Phiri', 'Kalumbila Cobalt Works (Demo)', 'mine', 'Kalumbila Cobalt Works'],
  ['trans_copperbelt', 'Joseph Banda', 'Copperbelt Haulage Ltd (Demo)', 'transporter', null],
  ['wb_kitwe', 'Grace Tembo', 'Kitwe Weighbridge (Demo)', 'weighbridge', 'Kitwe Weighbridge'],
  ['insp_ndola', 'Peter Zulu', 'Ndola Mineral Inspectorate (Demo)', 'inspector', 'Ndola Inspection Yard'],
  ['reg_zra', 'Natasha Mulenga', 'ZRA Mineral Desk (Demo)', 'regulator', null],
  ['buyer_alpine', 'Lukas Meier', 'Alpine Metals Trading AG (Demo)', 'buyer', null],
  ['buyer_shenzhen', 'Li Wei', 'Shenzhen Metals Import Co (Demo)', 'buyer', null],
  // Operators at stops outside Zambia (the Zambia -> Namibia -> Walvis Bay export route)
  ['border_katima', 'Ndapewa Shikongo', 'Namibia Customs, Katima Mulilo (Demo)', 'border', 'Katima Mulilo Border Post'],
  ['wb_katima', 'Tobias Haufiku', 'Katima Mulilo Weighbridge (Demo)', 'weighbridge', 'Katima Mulilo Weighbridge'],
  ['port_walvis', 'Selma Nghidinwa', 'Walvis Bay Port Operations (Demo)', 'port', 'Walvis Bay Port'],
];

// Places people can request access at. Simulated; admins add their own in the Users & stops page.
const STOPS = [
  ['Solwezi Copper Mine', 'Zambia', 'North-Western', 'mine'],
  ['Mufulira Smelter & Refinery', 'Zambia', 'Copperbelt', 'mine'],
  ['Kalumbila Cobalt Works', 'Zambia', 'North-Western', 'mine'],
  ['Chambishi Copper Smelter', 'Zambia', 'Copperbelt', 'mine'],
  ['Copperbelt Haulage Depot', 'Zambia', 'Copperbelt', 'depot'],
  ['Kitwe Weighbridge', 'Zambia', 'Copperbelt', 'weighbridge'],
  ['Ndola Inspection Yard', 'Zambia', 'Copperbelt', 'inspection'],
  ['Kasumbalesa Border Post', 'Zambia', 'Copperbelt', 'border'],
  ['Katima Mulilo Border Post', 'Namibia', 'Zambezi', 'border'],
  ['Katima Mulilo Weighbridge', 'Namibia', 'Zambezi', 'weighbridge'],
  ['Walvis Bay Port', 'Namibia', 'Erongo', 'port'],
  ['Dar es Salaam Port', 'Tanzania', 'Dar es Salaam', 'port'],
];

async function seedStops() {
  for (const [name, country, region, type] of STOPS) {
    const c = geo.coordsForStopName(name);
    const ex = await db.query('SELECT 1 FROM stops WHERE name = $1 AND country = $2', [name, country]);
    if (!ex.rows.length) {
      await db.query('INSERT INTO stops (name, country, region, stop_type, latitude, longitude) VALUES ($1,$2,$3,$4,$5,$6)',
        [name, country, region, type, c ? c.latitude : null, c ? c.longitude : null]);
    } else if (c) {
      // databases created before the map existed: fill in missing coordinates only
      await db.query('UPDATE stops SET latitude = $1, longitude = $2 WHERE name = $3 AND country = $4 AND latitude IS NULL',
        [c.latitude, c.longitude, name, country]);
    }
  }
}

/** A user row joined with its stop, the shape the API layer sees after authentication. */
async function loadUser(username) {
  const { rows } = await db.query(
    `SELECT u.*, s.name AS stop_name, s.country AS stop_country, s.region AS stop_region
     FROM users u LEFT JOIN stops s ON s.id = u.stop_id WHERE u.username = $1`, [username]);
  return rows[0];
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

// Each scenario: the stage the batch should reach, plus an optional weighbridge reading.
const SCENARIOS = [
  { mine: 'mine_solwezi', mineral: 'Copper cathode', site: 'Solwezi', province: 'North-Western', w: 24800, grade: 'LME Grade A (99.99%)', dest: 'Switzerland', buyer: 'buyer_alpine', stage: 'received' },
  { mine: 'mine_mufulira', mineral: 'Copper cathode', site: 'Mufulira', province: 'Copperbelt', w: 25200, grade: 'LME Grade A (99.99%)', dest: 'China', buyer: 'buyer_shenzhen', stage: 'shipped' },
  { mine: 'mine_solwezi', mineral: 'Copper concentrate', site: 'Solwezi', province: 'North-Western', w: 31500, grade: '26% Cu', dest: 'China', buyer: 'buyer_shenzhen', stage: 'export_approved' },
  { mine: 'mine_kalumbila', mineral: 'Cobalt hydroxide', site: 'Kalumbila', province: 'North-Western', w: 18200, grade: '30% Co', dest: 'Singapore', buyer: 'buyer_alpine', stage: 'inspected' },
  { mine: 'mine_mufulira', mineral: 'Copper cathode', site: 'Mufulira', province: 'Copperbelt', w: 24950, grade: 'LME Grade A (99.99%)', dest: 'Switzerland', buyer: 'buyer_alpine', stage: 'in_transit' },
  { mine: 'mine_kalumbila', mineral: 'Cobalt hydroxide', site: 'Kalumbila', province: 'North-Western', w: 17600, grade: '29% Co', dest: 'United Arab Emirates', buyer: 'buyer_shenzhen', stage: 'in_transit', wbWeight: 16380 }, // under-declared! (flagged)
  { mine: 'mine_solwezi', mineral: 'Manganese ore', site: 'Solwezi', province: 'North-Western', w: 22000, grade: '38% Mn', dest: 'China', buyer: 'buyer_shenzhen', stage: 'processed' },
  { mine: 'mine_mufulira', mineral: 'Gold', site: 'Mufulira', province: 'Copperbelt', w: 12.4, grade: '99.5% fine', dest: 'United Arab Emirates', buyer: 'buyer_alpine', stage: 'registered' },
];

async function seedDemo() {
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM batches');
  if (Number(rows[0].n) > 0) return false; // already has data

  await seedStops();
  const hash = await auth.hashPassword(DEMO_PASSWORD);
  const users = {};
  for (const [username, fullName, org, role, stopName] of USERS) {
    if (!(await db.query('SELECT 1 FROM users WHERE username = $1', [username])).rows.length) { // e.g. bootstrap admin
      const stopId = stopName ? (await db.query('SELECT id FROM stops WHERE name = $1', [stopName])).rows[0].id : null;
      await db.query(
        `INSERT INTO users (username, password_hash, full_name, organisation, role, stop_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,'active')`,
        [username, hash, fullName, org, role, stopId]
      );
    }
    users[username] = await loadUser(username);
  }

  const u = (name) => users[name];
  let hourOffset = 200;
  const t = () => hoursAgo((hourOffset -= 2));

  for (const s of SCENARIOS) {
    const detail = await svc.createBatch(u(s.mine), {
      mineral: s.mineral, mine_site: s.site, province: s.province, declared_weight_kg: s.w,
      grade: s.grade, destination: s.dest, buyer_id: u(s.buyer).id,
      notes: 'Simulated production batch',
    }, { occurredAt: new Date(hoursAgo((hourOffset -= 2) + 1)) });
    const code = detail.batch.batch_code;
    const add = (user, type, location, extra = {}) =>
      svc.addEvent(u(user), code, { event_type: type, location, occurred_at: t(), ...extra });

    const stages = ['registered', 'processed', 'in_transit', 'inspected', 'export_approved', 'exported', 'shipped', 'received'];
    const target = stages.indexOf(s.stage);

    if (target >= 1) await add(s.mine, 'PROCESSED', s.site, { notes: 'Processing / smelting complete, packed and tagged' });
    if (target >= 2) await add(s.mine, 'EXPORT_READY', s.site, { notes: 'Consignment sealed and ready for export' });
    if (target >= 2) {
      await add(s.mine, 'DISPATCHED', s.site, { notes: 'Loaded onto truck for road transport' });
      await add('wb_kitwe', 'WEIGHBRIDGE', 'Kitwe Weighbridge, Copperbelt', { weight_kg: s.wbWeight || s.w, notes: 'Gross/net weight verified' });
      await add('trans_copperbelt', 'CHECKPOINT', 'Kasumbalesa Border Post', { notes: 'Arrived at border staging area' });
    }
    if (target >= 3) await add('insp_ndola', 'INSPECTED', 'Ndola Inspection Yard', { notes: 'Sample assay and seal check passed' });
    if (target >= 4) await add('reg_zra', 'EXPORT_APPROVED', 'ZRA Head Office, Lusaka', { notes: 'Export permit and royalty checks cleared' });
    if (target >= 5) await add('reg_zra', 'EXPORTED', 'Kasumbalesa Border Post', { notes: 'Cleared customs and left Zambia' });
    if (target >= 6) {
      // Zambia -> Namibia -> Walvis Bay: each stop's own operator records what they saw
      await add('border_katima', 'CHECKPOINT', 'Katima Mulilo Border Post', { notes: 'Entered Namibia, seals intact, documents match' });
      await add('wb_katima', 'WEIGHBRIDGE', 'Katima Mulilo Weighbridge', { weight_kg: s.w, notes: 'Transit weight check' });
      await add('port_walvis', 'SHIPPED', 'Walvis Bay Port', { notes: 'Container loaded on vessel' });
    }
    if (target >= 7) await add(s.buyer, 'RECEIVED', s.dest, { notes: 'Receipt confirmed by buyer' });
  }
  return true;
}

/**
 * Production bootstrap: creates the first administrator from ADMIN_USERNAME / ADMIN_PASSWORD
 * when the users table is empty. The admin then creates all other accounts in the UI.
 */
async function bootstrapAdmin() {
  const username = (process.env.ADMIN_USERNAME || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!username || !password) return false;
  if (password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM users');
  if (Number(rows[0].n) > 0) return false;
  await db.query(
    'INSERT INTO users (username, password_hash, full_name, organisation, role) VALUES ($1,$2,$3,$4,$5)',
    [username, await auth.hashPassword(password), 'System Administrator', 'Platform Administration', 'admin']
  );
  return true;
}

module.exports = { seedDemo, seedStops, bootstrapAdmin, DEMO_PASSWORD, USERS, STOPS };
