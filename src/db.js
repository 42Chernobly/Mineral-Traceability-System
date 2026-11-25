const fs = require('fs');
const path = require('path');
const config = require('./config');

let pool = null;
let mode = null;

/**
 * Connects to PostgreSQL when DATABASE_URL is set; otherwise falls back to an
 * in-memory pg-mem database so the prototype runs with zero setup.
 */
async function init() {
  if (pool) return pool;

  if (config.databaseUrl) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
    });
    mode = 'postgres';
  } else {
    const { newDb } = require('pg-mem');
    const mem = newDb();
    const { Pool } = mem.adapters.createPg();
    pool = new Pool();
    mode = 'in-memory (pg-mem)';
  }

  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);
  await upgrade();
  return pool;
}

/** Brings a database created by an earlier version up to date (idempotent; no-op on a fresh one). */
async function upgrade() {
  if (mode === 'postgres') {
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS stop_id INTEGER REFERENCES stops(id);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(12) NOT NULL DEFAULT 'active';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS contact VARCHAR(120);
      ALTER TABLE stops ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
      ALTER TABLE stops ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;`);
  }
  await pool.query('CREATE INDEX IF NOT EXISTS idx_users_stop ON users (stop_id)');
}

async function query(text, params) {
  if (!pool) await init();
  return pool.query(text, params);
}

/** Runs fn(q) inside a transaction on one connection; q(text, params) is the query helper. */
let memQueue = Promise.resolve();
async function tx(fn) {
  if (!pool) await init();
  if (mode !== 'postgres') {
    // pg-mem has one connection and no row locks: serialise transactions in-process.
    const run = memQueue.then(() => runTx(fn));
    memQueue = run.catch(() => {});
    return run;
  }
  return runTx(fn);
}

async function runTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn((text, params) => client.query(text, params));
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection already broken */ }
    throw err;
  } finally {
    client.release();
  }
}

function getMode() {
  return mode;
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
    mode = null;
  }
}

module.exports = { init, query, tx, getMode, close };
