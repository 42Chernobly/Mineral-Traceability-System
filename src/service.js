/** Core business logic: registering batches and appending hash-chained events. */
const db = require('./db');
const chain = require('./hashchain');
const P = require('./permissions');
const geo = require('./geo');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MINERALS = ['Copper cathode', 'Copper concentrate', 'Cobalt hydroxide', 'Gold', 'Manganese ore', 'Nickel concentrate', 'Emerald', 'Amethyst'];

const num = (v) => (v === null || v === undefined ? null : Number(v));

function cleanText(v, max, field, required = true) {
  const s = (v === undefined || v === null ? '' : String(v)).trim();
  if (required && !s) throw new HttpError(400, `${field} is required`);
  if (s.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return s;
}

function parseWeight(v, field, required) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  const w = Number(v);
  if (!Number.isFinite(w) || w <= 0 || w > 1e9) throw new HttpError(400, `${field} must be a positive number (kg)`);
  return Math.round(w * 1000) / 1000;
}

function parseOccurredAt(v) {
  if (v === undefined || v === null || v === '') return new Date();
  const d = new Date(v);
  if (isNaN(d.getTime())) throw new HttpError(400, 'occurred_at is not a valid date');
  const now = Date.now();
  if (d.getTime() > now + 5 * 60 * 1000) throw new HttpError(400, 'occurred_at cannot be in the future');
  if (d.getTime() < now - 30 * 24 * 3600 * 1000) throw new HttpError(400, 'occurred_at is older than 30 days');
  return new Date(d.getTime()); // ms precision keeps the hash stable across the DB round-trip
}

function batchView(b) {
  return {
    id: b.id,
    batch_code: b.batch_code,
    mineral: b.mineral,
    mine_site: b.mine_site,
    province: b.province,
    producer_id: b.producer_id,
    producer_org: b.producer_org,
    buyer_id: b.buyer_id,
    buyer_org: b.buyer_org || null,
    declared_weight_kg: num(b.declared_weight_kg),
    grade: b.grade,
    destination: b.destination,
    status: b.status,
    flagged: b.flagged,
    event_count: b.event_count,
    head_hash: b.head_hash,
    created_at: b.created_at,
  };
}

function eventView(e) {
  return {
    id: e.id,
    seq: e.seq,
    event_type: e.event_type,
    label: (P.EVENT_RULES[e.event_type] || {}).label || e.event_type,
    location: e.location,
    actor_role: e.actor_role,
    actor_org: e.actor_org,
    weight_kg: num(e.weight_kg),
    notes: e.notes,
    details: e.details || {},
    occurred_at: e.occurred_at,
    recorded_at: e.recorded_at,
    offline: e.offline,
    prev_hash: e.prev_hash,
    hash: e.hash,
  };
}

const BATCH_SELECT = `
  SELECT b.*, p.organisation AS producer_org, p.stop_id AS producer_stop_id, y.organisation AS buyer_org
  FROM batches b
  JOIN users p ON p.id = b.producer_id
  LEFT JOIN users y ON y.id = b.buyer_id`;

function canView(user, b) {
  if (P.GLOBAL_VIEW_ROLES.includes(user.role)) return true;
  // Every operator at the same mine shares that mine's batches (and only that mine's).
  if (user.role === 'mine') return b.producer_id === user.id || (!!user.stop_id && b.producer_stop_id === user.stop_id);
  if (user.role === 'buyer') return b.buyer_id === user.id;
  // Border posts and ports (often in another country) only see consignments already on the move.
  if (P.OUTBOUND_VIEW_ROLES.includes(user.role)) return P.OUTBOUND_STATUSES.includes(b.status);
  return false;
}

async function getBatchRow(code) {
  const { rows } = await db.query(BATCH_SELECT + ' WHERE b.batch_code = $1', [code]);
  return rows[0] || null;
}

async function getEvents(batchId) {
  const { rows } = await db.query('SELECT * FROM events WHERE batch_id = $1 ORDER BY seq ASC', [batchId]);
  return rows;
}

async function nextBatchCode(mineral) {
  const prefix = {
    'Copper cathode': 'CU', 'Copper concentrate': 'CC', 'Cobalt hydroxide': 'CO', Gold: 'AU',
    'Manganese ore': 'MN', 'Nickel concentrate': 'NI', Emerald: 'EM', Amethyst: 'AM',
  }[mineral];
  const year = new Date().getFullYear();
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM batches');
  let n = Number(rows[0].n) + 1;
  // Loop guards against the (rare) case where a code is already taken
  for (;;) {
    const code = `ZM-${prefix}-${year}-${String(n).padStart(4, '0')}`;
    const { rows: ex } = await db.query('SELECT 1 FROM batches WHERE batch_code = $1', [code]);
    if (!ex.length) return code;
    n += 1;
  }
}

async function createBatch(user, input, opts = {}) {
  if (!['mine', 'admin'].includes(user.role)) throw new HttpError(403, 'Only mine operators can register batches');
  const mineral = cleanText(input.mineral, 40, 'mineral');
  if (!MINERALS.includes(mineral)) throw new HttpError(400, `mineral must be one of: ${MINERALS.join(', ')}`);
  // An operator signed up at a mine can only register batches at that mine.
  const stopBound = user.role === 'mine' && !!user.stop_name;
  const mineSite = stopBound ? user.stop_name : cleanText(input.mine_site, 120, 'mine_site');
  const province = stopBound ? (user.stop_region || '') : cleanText(input.province, 60, 'province', false);
  const grade = cleanText(input.grade, 60, 'grade', false);
  const destination = cleanText(input.destination, 120, 'destination', false);
  const weight = parseWeight(input.declared_weight_kg, 'declared_weight_kg', true);
  const notes = cleanText(input.notes, 500, 'notes', false);

  let producerId = user.id;
  if (user.role === 'admin') {
    producerId = Number(input.producer_id);
    const { rows } = await db.query("SELECT id FROM users WHERE id=$1 AND role='mine'", [producerId]);
    if (!rows.length) throw new HttpError(400, 'Admin must supply a valid producer_id (a mine operator)');
  }
  let buyerId = null;
  if (input.buyer_id) {
    buyerId = Number(input.buyer_id);
    const { rows } = await db.query("SELECT id FROM users WHERE id=$1 AND role='buyer' AND active", [buyerId]);
    if (!rows.length) throw new HttpError(400, 'buyer_id is not a valid buyer account');
  }

  const code = await nextBatchCode(mineral);
  const { rows: ins } = await db.query(
    `INSERT INTO batches (batch_code, mineral, mine_site, province, producer_id, buyer_id,
        declared_weight_kg, grade, destination, status, head_hash, event_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'registered',$10,0) RETURNING *`,
    [code, mineral, mineSite, province || null, producerId, buyerId, weight, grade || null,
      destination || null, chain.genesisHash(code)]
  );
  const batch = ins[0];
  const actor = user.role === 'admin' ? (await db.query('SELECT * FROM users WHERE id=$1', [producerId])).rows[0] : user;
  await commitEvent(batch, actor, {
    event_type: 'REGISTERED',
    location: mineSite,
    weight_kg: weight,
    notes: notes || 'Batch registered at point of production',
    details: { mineral, grade: grade || null },
    occurred_at: opts.occurredAt || new Date(),
  });
  return getBatchDetail(user, code);
}

/**
 * Appends one event to a batch's hash chain and updates the batch's head anchor,
 * atomically. The batch row is locked for the duration of the transaction, so
 * concurrent appends to the same batch are serialised, the chain never forks,
 * and readers never observe an event without its matching head/count update.
 * The batch status is re-checked under the lock (the caller's check may be stale).
 */
async function commitEvent(batch, user, ev) {
  const rule = P.EVENT_RULES[ev.event_type];
  return db.tx(async (q) => {
    await q('UPDATE batches SET event_count = event_count WHERE id = $1', [batch.id]); // row lock
    const { rows: cur } = await q('SELECT status, flagged FROM batches WHERE id = $1', [batch.id]);
    if (rule.from) {
      if (P.CLOSED_STATUSES.includes(cur[0].status)) throw new HttpError(409, 'Batch chain of custody is closed (received by buyer)');
      if (!rule.from.includes(cur[0].status)) throw new HttpError(409, `${ev.event_type} cannot follow status "${cur[0].status}"`);
    }
    const { rows: last } = await q('SELECT seq, hash FROM events WHERE batch_id = $1 ORDER BY seq DESC LIMIT 1', [batch.id]);
    const seq = last.length ? last[0].seq + 1 : 1;
    const prevHash = last.length ? last[0].hash : chain.genesisHash(batch.batch_code);
    const record = {
      seq,
      event_type: ev.event_type,
      location: ev.location,
      actor_id: user.id,
      actor_role: user.role,
      actor_org: user.organisation,
      weight_kg: ev.weight_kg,
      notes: ev.notes,
      details: ev.details,
      occurred_at: ev.occurred_at,
    };
    const hash = chain.computeEventHash(batch.batch_code, record, prevHash);
    const { rows } = await q(
      `INSERT INTO events
         (batch_id, seq, event_type, location, actor_id, actor_role, actor_org,
          weight_kg, notes, details, occurred_at, offline, client_ref, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [batch.id, seq, record.event_type, record.location, user.id, user.role, user.organisation,
        record.weight_kg, record.notes, JSON.stringify(record.details), record.occurred_at,
        !!ev.offline, ev.client_ref || null, prevHash, hash]
    );
    const row = rows[0];
    const status = rule.status || cur[0].status;
    const flagged = cur[0].flagged || !!(ev.details && ev.details.weight_discrepancy);
    await q('UPDATE batches SET head_hash=$1, event_count=$2, status=$3, flagged=$4 WHERE id=$5', [row.hash, row.seq, status, flagged, batch.id]);
    batch.status = status;
    batch.flagged = flagged;
    batch.head_hash = row.hash;
    batch.event_count = row.seq;
    return row;
  });
}

async function addEvent(user, code, input, opts = {}) {
  const batch = await getBatchRow(code);
  if (!batch || !canView(user, batch)) throw new HttpError(404, 'Batch not found');

  // Idempotent offline sync: a replayed client_ref is acknowledged, never recorded twice.
  // Checked first so a retry after a lost response is not rejected by the state machine.
  const clientRef = input.client_ref ? String(input.client_ref).slice(0, 64) : null;
  if (clientRef) {
    const { rows } = await db.query('SELECT * FROM events WHERE batch_id=$1 AND client_ref=$2 AND actor_id=$3', [batch.id, clientRef, user.id]);
    if (rows.length) return { event: eventView(rows[0]), duplicate: true };
  }

  const type = String(input.event_type || '').toUpperCase();
  const rule = P.EVENT_RULES[type];
  if (!rule || type === 'REGISTERED') throw new HttpError(400, `event_type must be one of: ${P.EVENT_TYPES.filter((t) => t !== 'REGISTERED').join(', ')}`);
  if (!rule.roles.includes(user.role)) throw new HttpError(403, `Role "${user.role}" may not record ${type} events`);
  if (P.CLOSED_STATUSES.includes(batch.status)) throw new HttpError(409, 'Batch chain of custody is closed (received by buyer)');
  if (!rule.from.includes(batch.status)) {
    throw new HttpError(409, `${type} cannot follow status "${batch.status}"`);
  }

  // Someone signed up at a stop records everything as happening at that stop; it cannot be typed over.
  const location = user.stop_name ? user.stop_name : cleanText(input.location, 120, 'location');
  const notes = cleanText(input.notes, 500, 'notes', false);
  const needsWeight = type === 'WEIGHBRIDGE';
  const weight = parseWeight(input.weight_kg, 'weight_kg', needsWeight);
  const occurredAt = parseOccurredAt(input.occurred_at);

  const details = {};
  if (input.details && typeof input.details === 'object' && !Array.isArray(input.details)) {
    // only allow a small, flat set of string/number details
    Object.keys(input.details).slice(0, 10).forEach((k) => {
      const v = input.details[k];
      if (['string', 'number', 'boolean'].includes(typeof v) && String(k).length <= 40 && String(v).length <= 120) {
        details[k] = v;
      }
    });
  }
  // Weight discrepancy check against the declared weight (anti under-declaration)
  if (weight !== null && type === 'WEIGHBRIDGE') {
    const declared = Number(batch.declared_weight_kg);
    const diff = Math.abs(weight - declared) / declared;
    if (diff > P.WEIGHT_TOLERANCE) {
      details.weight_discrepancy = true;
      details.declared_weight_kg = declared;
      details.difference_pct = Math.round(diff * 1000) / 10;
    }
  }

  const row = await commitEvent(batch, user, {
    event_type: type, location, weight_kg: weight, notes, details,
    occurred_at: occurredAt, offline: !!opts.offline, client_ref: clientRef,
  });
  return { event: eventView(row), duplicate: false, flagged: batch.flagged, status: batch.status };
}

async function listBatches(user, { status, q } = {}) {
  const where = [];
  const params = [];
  if (user.role === 'mine') {
    params.push(user.id);
    let cond = `b.producer_id = $${params.length}`;
    if (user.stop_id) { params.push(user.stop_id); cond = `(${cond} OR p.stop_id = $${params.length})`; }
    where.push(cond);
  } else if (user.role === 'buyer') { params.push(user.id); where.push(`b.buyer_id = $${params.length}`); }
  else if (P.OUTBOUND_VIEW_ROLES.includes(user.role)) {
    const marks = P.OUTBOUND_STATUSES.map((s) => { params.push(s); return `$${params.length}`; });
    where.push(`b.status IN (${marks.join(',')})`);
  } else if (!P.GLOBAL_VIEW_ROLES.includes(user.role)) where.push('1=0');
  if (status) { params.push(status); where.push(`b.status = $${params.length}`); }
  if (q) { params.push('%' + String(q).toUpperCase() + '%'); where.push(`UPPER(b.batch_code) LIKE $${params.length}`); }
  const sql = BATCH_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY b.id DESC LIMIT 200';
  const { rows } = await db.query(sql, params);
  return rows.map(batchView);
}

async function getBatchDetail(user, code) {
  const batch = await getBatchRow(code);
  if (!batch || !canView(user, batch)) throw new HttpError(404, 'Batch not found');
  const events = await getEvents(batch.id);
  const integrity = chain.verifyChain(batch.batch_code, events, batch);
  return { batch: batchView(batch), events: events.map(eventView), integrity };
}

async function verifyAll() {
  const { rows: batches } = await db.query('SELECT * FROM batches ORDER BY id');
  const results = [];
  for (const b of batches) {
    const events = await getEvents(b.id);
    const r = chain.verifyChain(b.batch_code, events, b);
    results.push({ batch_code: b.batch_code, valid: r.valid, events: events.length, reason: r.reason, brokenAtSeq: r.brokenAtSeq });
  }
  return {
    checked_at: new Date().toISOString(),
    batches_checked: results.length,
    batches_valid: results.filter((r) => r.valid).length,
    batches_tampered: results.filter((r) => !r.valid).length,
    results,
  };
}

async function stats(user) {
  const batches = await listBatches(user);
  const byStatus = {};
  const byMineral = {};
  let weight = 0;
  batches.forEach((b) => {
    byStatus[b.status] = (byStatus[b.status] || 0) + 1;
    byMineral[b.mineral] = (byMineral[b.mineral] || 0) + 1;
    weight += b.declared_weight_kg || 0;
  });
  return {
    total_batches: batches.length,
    flagged_batches: batches.filter((b) => b.flagged).length,
    total_declared_weight_kg: Math.round(weight * 1000) / 1000,
    by_status: byStatus,
    by_mineral: byMineral,
  };
}

/**
 * Movement of the consignments a user may see, for the dashboard map. Scope is exactly that of
 * listBatches (so a buyer only sees their own shipments, a border post only consignments on the move).
 * Each consignment gets an ordered list of waypoints built from its events; consecutive events at the
 * same place are merged into one waypoint. Locations that cannot be placed are listed, never guessed.
 */
async function mapData(user) {
  const batches = await listBatches(user);
  const { rows: stopRows } = await db.query('SELECT name, latitude, longitude FROM stops');
  const resolve = geo.makeResolver(stopRows);
  const byBatch = new Map();
  if (batches.length) {
    const marks = batches.map((b, i) => `$${i + 1}`).join(',');
    const { rows } = await db.query(
      `SELECT batch_id, seq, event_type, location, occurred_at FROM events WHERE batch_id IN (${marks}) ORDER BY batch_id, seq`,
      batches.map((b) => b.id)
    );
    rows.forEach((e) => { if (!byBatch.has(e.batch_id)) byBatch.set(e.batch_id, []); byBatch.get(e.batch_id).push(e); });
  }

  const consignments = batches.map((b) => {
    const waypoints = [];
    const unmapped = [];
    (byBatch.get(b.id) || []).forEach((e) => {
      const label = (P.EVENT_RULES[e.event_type] || {}).label || e.event_type;
      const pt = resolve(e.location);
      if (!pt) { if (!unmapped.includes(e.location)) unmapped.push(e.location); return; }
      const last = waypoints[waypoints.length - 1];
      if (last && last.lat === pt.lat && last.lng === pt.lng) {
        last.events.push(label); last.last_seq = e.seq; last.at = e.occurred_at;
      } else {
        waypoints.push({ place: pt.name, lat: pt.lat, lng: pt.lng, first_seq: e.seq, last_seq: e.seq, events: [label], at: e.occurred_at });
      }
    });
    const dest = b.destination ? resolve(b.destination) : null;
    return {
      batch_code: b.batch_code,
      mineral: b.mineral,
      status: b.status,
      flagged: b.flagged,
      mine_site: b.mine_site,
      destination: b.destination,
      destination_point: dest ? { place: dest.name, lat: dest.lat, lng: dest.lng } : null,
      waypoints,
      current: waypoints.length ? waypoints[waypoints.length - 1] : null,
      unmapped,
    };
  });
  return { generated_at: new Date().toISOString(), consignments };
}

module.exports = {
  HttpError, MINERALS, createBatch, addEvent, listBatches, getBatchDetail, getBatchRow, getEvents,
  verifyAll, stats, batchView, eventView, canView, commitEvent, mapData,
};
