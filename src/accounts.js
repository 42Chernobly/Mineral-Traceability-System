/** Stops (places along the chain), sign-up requests and administrator approval. */
const db = require('./db');
const auth = require('./auth');
const P = require('./permissions');
const geo = require('./geo');

class AccountError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function text(v, max, field, required = true) {
  const s = (v === undefined || v === null ? '' : String(v)).trim();
  if (required && !s) throw new AccountError(400, `${field} is required`);
  if (s.length > max) throw new AccountError(400, `${field} must be at most ${max} characters`);
  return s;
}

const stopView = (s) => ({
  id: s.id,
  name: s.name,
  country: s.country,
  region: s.region,
  latitude: s.latitude === null || s.latitude === undefined ? null : Number(s.latitude),
  longitude: s.longitude === null || s.longitude === undefined ? null : Number(s.longitude),
  stop_type: s.stop_type,
  type_label: (P.STOP_TYPES[s.stop_type] || {}).label || s.stop_type,
  role: (P.STOP_TYPES[s.stop_type] || {}).role,
  role_label: P.ROLE_LABELS[(P.STOP_TYPES[s.stop_type] || {}).role],
  active: s.active,
});

async function listStops({ onlyActive } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM stops ${onlyActive ? 'WHERE active' : ''} ORDER BY country, stop_type, name`
  );
  return rows.map(stopView);
}

async function getStop(id) {
  const { rows } = await db.query('SELECT * FROM stops WHERE id = $1', [Number(id) || 0]);
  return rows[0] || null;
}

async function createStop(input) {
  const name = text(input.name, 120, 'name');
  const country = text(input.country, 60, 'country');
  const region = text(input.region, 60, 'region', false);
  const type = String(input.stop_type || '');
  if (!P.STOP_TYPES[type]) throw new AccountError(400, `stop_type must be one of: ${Object.keys(P.STOP_TYPES).join(', ')}`);
  const dup = await db.query('SELECT 1 FROM stops WHERE LOWER(name) = LOWER($1) AND LOWER(country) = LOWER($2)', [name, country]);
  if (dup.rows.length) throw new AccountError(409, 'A stop with this name already exists in that country');
  let coords;
  try { coords = geo.parseCoords(input.latitude, input.longitude); } catch (e) { throw new AccountError(400, e.message); }
  if (!coords) coords = geo.coordsForStopName(name); // known place names get their location automatically
  const { rows } = await db.query(
    'INSERT INTO stops (name, country, region, stop_type, latitude, longitude) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [name, country, region || null, type, coords ? coords.latitude : null, coords ? coords.longitude : null]
  );
  return stopView(rows[0]);
}

async function setStopActive(id, active) {
  const { rows } = await db.query('UPDATE stops SET active = $1 WHERE id = $2 RETURNING *', [!!active, Number(id) || 0]);
  if (!rows.length) throw new AccountError(404, 'Stop not found');
  return stopView(rows[0]);
}

function validateCredentials(b) {
  const username = String(b.username || '').trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,40}$/.test(username)) throw new AccountError(400, 'Username must be 3-40 characters (a-z, 0-9, _ . -)');
  if (typeof b.password !== 'string' || b.password.length < 8) throw new AccountError(400, 'Password must be at least 8 characters');
  if (b.password.length > 72) throw new AccountError(400, 'Password must be at most 72 characters');
  return username;
}

/**
 * Public sign-up at a stop. The role is derived from the stop's type (the applicant cannot
 * choose it) and the account stays "pending" until an administrator approves it.
 */
async function signup(b) {
  const username = validateCredentials(b);
  const fullName = text(b.full_name, 120, 'Full name');
  const organisation = text(b.organisation, 120, 'Organisation');
  const contact = text(b.contact, 120, 'Contact', false);
  const stop = await getStop(b.stop_id);
  if (!stop || !stop.active) throw new AccountError(400, 'Please choose a valid stop');
  const role = P.STOP_TYPES[stop.stop_type].role;

  const exists = await db.query('SELECT 1 FROM users WHERE username = $1', [username]);
  if (exists.rows.length) throw new AccountError(409, 'That username is already taken');

  const hash = await auth.hashPassword(b.password);
  const { rows } = await db.query(
    `INSERT INTO users (username, password_hash, full_name, organisation, role, stop_id, status, contact)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7) RETURNING id, username, full_name, organisation, role, status`,
    [username, hash, fullName, organisation, role, stop.id, contact || null]
  );
  return { user: rows[0], stop: stopView(stop) };
}

const USER_COLUMNS = `u.id, u.username, u.full_name, u.organisation, u.role, u.active, u.status, u.contact,
  u.created_at, u.stop_id, s.name AS stop_name, s.country AS stop_country`;

async function listUsers() {
  const { rows } = await db.query(
    `SELECT ${USER_COLUMNS} FROM users u LEFT JOIN stops s ON s.id = u.stop_id ORDER BY u.id`
  );
  return rows;
}

async function setStatus(id, status) {
  const { rows } = await db.query('SELECT id, status FROM users WHERE id = $1', [Number(id) || 0]);
  if (!rows.length) throw new AccountError(404, 'User not found');
  if (rows[0].status !== 'pending') throw new AccountError(409, `This request is already ${rows[0].status}`);
  await db.query('UPDATE users SET status = $1 WHERE id = $2', [status, rows[0].id]);
  return (await db.query(`SELECT ${USER_COLUMNS} FROM users u LEFT JOIN stops s ON s.id = u.stop_id WHERE u.id = $1`, [rows[0].id])).rows[0];
}

const approve = (id) => setStatus(id, 'active');
const reject = (id) => setStatus(id, 'rejected');

/** Admin creates an account directly. If a stop is given, the role comes from the stop. */
async function adminCreateUser(b) {
  const username = validateCredentials(b);
  const fullName = text(b.full_name, 120, 'Full name');
  const organisation = text(b.organisation, 120, 'Organisation');
  let role = b.role;
  let stopId = null;
  if (b.stop_id) {
    const stop = await getStop(b.stop_id);
    if (!stop || !stop.active) throw new AccountError(400, 'stop_id is not a valid stop');
    stopId = stop.id;
    role = P.STOP_TYPES[stop.stop_type].role;
  }
  if (!P.ROLES.includes(role)) throw new AccountError(400, `role must be one of: ${P.ROLES.join(', ')}`);
  const exists = await db.query('SELECT 1 FROM users WHERE username = $1', [username]);
  if (exists.rows.length) throw new AccountError(409, 'username already exists');
  const { rows } = await db.query(
    `INSERT INTO users (username, password_hash, full_name, organisation, role, stop_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,'active') RETURNING id, username, full_name, organisation, role, active, status, stop_id`,
    [username, await auth.hashPassword(b.password), fullName, organisation, role, stopId]
  );
  return rows[0];
}

module.exports = {
  AccountError, listStops, getStop, createStop, setStopActive, signup, listUsers, approve, reject,
  adminCreateUser, stopView,
};
