/**
 * SHA-256 hash-chained audit trail.
 *
 * Each event stores the hash of the previous event in the same batch (prev_hash)
 * and its own hash = SHA256(canonical JSON of its content + prev_hash).
 * Changing, deleting or re-ordering any historical event breaks every hash
 * after it, which verifyChain() detects.
 */
const crypto = require('crypto');

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/** Deterministic JSON: object keys sorted recursively (jsonb does not keep key order). */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

function toIso(v) {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function normWeight(w) {
  return w === null || w === undefined || w === '' ? null : Number(w).toFixed(3);
}

/** Hash of the "block before the first event" of a batch. */
function genesisHash(batchCode) {
  return sha256('GENESIS|' + batchCode);
}

/** The exact content that is covered by an event's hash. */
function eventContent(batchCode, e) {
  return {
    batch_code: batchCode,
    seq: Number(e.seq),
    event_type: e.event_type,
    location: e.location,
    actor_id: Number(e.actor_id),
    actor_role: e.actor_role,
    actor_org: e.actor_org,
    weight_kg: normWeight(e.weight_kg),
    notes: e.notes || '',
    details: e.details || {},
    occurred_at: toIso(e.occurred_at),
  };
}

function computeEventHash(batchCode, event, prevHash) {
  return sha256(prevHash + '|' + canonicalize(eventContent(batchCode, event)));
}

/**
 * Verifies a batch's chain.
 * @param {string} batchCode
 * @param {Array} events    rows ordered by seq
 * @param {{head_hash?:string,event_count?:number}} [batch] optional head anchor
 */
function verifyChain(batchCode, events, batch) {
  let prev = genesisHash(batchCode);
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (Number(e.seq) !== i + 1) {
      return { valid: false, checked: i, brokenAtSeq: i + 1, reason: 'Missing or re-ordered event (sequence gap)' };
    }
    if (e.prev_hash !== prev) {
      return { valid: false, checked: i, brokenAtSeq: e.seq, reason: 'Link to previous event does not match' };
    }
    const expected = computeEventHash(batchCode, e, prev);
    if (e.hash !== expected) {
      return { valid: false, checked: i, brokenAtSeq: e.seq, reason: 'Event content does not match its recorded hash (altered after recording)' };
    }
    prev = e.hash;
  }
  if (batch) {
    if (batch.event_count !== undefined && Number(batch.event_count) !== events.length) {
      return { valid: false, checked: events.length, brokenAtSeq: events.length, reason: 'Event count differs from batch record (events removed or added)' };
    }
    if (batch.head_hash !== undefined && batch.head_hash !== prev) {
      return { valid: false, checked: events.length, brokenAtSeq: events.length, reason: 'Chain head does not match batch record (tail truncated or replaced)' };
    }
  }
  return { valid: true, checked: events.length, brokenAtSeq: null, reason: null, headHash: prev };
}

module.exports = { sha256, canonicalize, genesisHash, computeEventHash, eventContent, verifyChain };
