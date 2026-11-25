/**
 * Simple performance evaluation (proposal objective 1.4: "transaction performance").
 * Usage: node scripts/benchmark.js [baseUrl]    (server must be running with demo data)
 * Measures: event-append latency, public QR verification latency, and full-chain
 * audit time as the chain grows.
 */
const base = process.argv[2] || 'http://localhost:3000';

async function call(path, opts = {}, token) {
  const res = await fetch(base + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const login = async (u) => (await call('/api/auth/login', { method: 'POST', body: { username: u, password: process.env.DEMO_PASSWORD || 'Demo@12345' } })).body.token;
const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))];
const summary = (name, ms) => console.log(`${name.padEnd(34)} n=${String(ms.length).padStart(4)}  mean=${(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(1)}ms  p50=${pct(ms, 50).toFixed(1)}ms  p95=${pct(ms, 95).toFixed(1)}ms  max=${Math.max(...ms).toFixed(1)}ms`);

async function timed(fn) { const t = performance.now(); const r = await fn(); return [performance.now() - t, r]; }

(async () => {
  const mine = await login('mine_solwezi');
  const wb = await login('wb_kitwe');
  const reg = await login('reg_zra');

  const created = await call('/api/batches', { method: 'POST', body: { mineral: 'Copper cathode', mine_site: 'Benchmark', declared_weight_kg: 1000 } }, mine);
  const code = created.body.batch.batch_code;
  await call(`/api/batches/${code}/events`, { method: 'POST', body: { event_type: 'DISPATCHED', location: 'Bench' } }, mine);

  // 1. sequential appends
  const appendMs = [];
  for (let i = 0; i < 100; i++) {
    const [ms, r] = await timed(() => call(`/api/batches/${code}/events`, { method: 'POST', body: { event_type: 'WEIGHBRIDGE', location: 'Bench ' + i, weight_kg: 1000 } }, wb));
    if (r.status !== 201) throw new Error('append failed: ' + JSON.stringify(r.body));
    appendMs.push(ms);
  }
  summary('Append event (sequential)', appendMs);

  // 2. concurrent appends to different batches
  const codes = [];
  for (let i = 0; i < 10; i++) {
    const c = (await call('/api/batches', { method: 'POST', body: { mineral: 'Gold', mine_site: 'Bench', declared_weight_kg: 10 } }, mine)).body.batch.batch_code;
    await call(`/api/batches/${c}/events`, { method: 'POST', body: { event_type: 'DISPATCHED', location: 'B' } }, mine);
    codes.push(c);
  }
  const t0 = performance.now();
  const results = await Promise.all(codes.flatMap((c) => [1, 2, 3, 4, 5].map(() => call(`/api/batches/${c}/events`, { method: 'POST', body: { event_type: 'WEIGHBRIDGE', location: 'B', weight_kg: 10 } }, wb))));
  const wall = performance.now() - t0;
  const ok = results.filter((r) => r.status === 201).length;
  console.log(`Concurrent appends                 ${ok}/${results.length} ok in ${wall.toFixed(0)}ms  (${(ok / (wall / 1000)).toFixed(0)} events/s)`);

  // 3. public verification (chain of 100+ events)
  const detail = await call(`/api/batches/${code}`, {}, mine);
  const tokenUrl = new URL(detail.body.qr.url).searchParams.get('t');
  const pubMs = [];
  for (let i = 0; i < 50; i++) {
    const [ms, r] = await timed(() => call('/api/public/verify?t=' + encodeURIComponent(tokenUrl)));
    if (!r.body.chain.valid) throw new Error('chain unexpectedly invalid');
    pubMs.push(ms);
  }
  summary(`Public verify (${detail.body.events.length}-event chain)`, pubMs);

  // 4. full audit
  const auditMs = [];
  let auditInfo;
  for (let i = 0; i < 5; i++) { const [ms, r] = await timed(() => call('/api/audit/verify', {}, reg)); auditMs.push(ms); auditInfo = r.body; }
  summary(`Full audit (${auditInfo.batches_checked} batches)`, auditMs);
  console.log(`\nAll chains valid after benchmark: ${auditInfo.batches_tampered === 0}`);
})().catch((e) => { console.error('Benchmark failed:', e.message); process.exit(1); });
