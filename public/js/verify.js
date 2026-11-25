(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmt = (d) => new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const STATUS = { registered: 'Registered', processed: 'Processed', in_transit: 'In transit', inspected: 'Inspected', export_approved: 'Export approved', exported: 'Exported', shipped: 'Shipped', received: 'Received', on_hold: 'ON HOLD', rejected: 'REJECTED – under investigation', export_rejected: 'EXPORT PERMIT REJECTED' };
  let scanner = null;

  function tokenFrom(raw) {
    const m = String(raw).match(/[?&]t=([^&#]+)/);
    return m ? decodeURIComponent(m[1]) : String(raw).trim();
  }

  async function verify(raw) {
    const out = $('#out');
    out.innerHTML = '<p class="muted">Verifying…</p>';
    let res; let d;
    try { res = await fetch('/api/public/verify?t=' + encodeURIComponent(tokenFrom(raw))); d = await res.json(); }
    catch (e) { out.innerHTML = '<div class="banner bad">Could not reach the server. Check your connection.</div>'; return; }
    if (!res.ok || !d.genuine) {
      out.innerHTML = `<div class="banner bad">✖ NOT VERIFIED<span class="small">${esc(d.error || 'Unknown error')} Treat this consignment as suspect.</span></div>`;
      return;
    }
    const b = d.batch; const c = d.chain;
    const broken = c.valid ? null : (d.timeline[c.events_checked] || {}).seq;
    out.innerHTML = `
      ${c.valid && (b.status === 'rejected' || b.status === 'on_hold') ? `<div class="banner ${b.status === 'rejected' ? 'bad' : 'warn'}" role="alert">${b.status === 'rejected' ? '⛔ REJECTED — this consignment is stopped pending investigation' : '⏸ ON HOLD — this consignment is temporarily stopped'}<span class="small">Do not accept or move it until the authorities have cleared it.</span></div>` : ''}
      ${c.valid && b.status === 'export_rejected' ? '<div class="banner warn" role="alert">✖ EXPORT PERMIT REJECTED<span class="small">This consignment may not be exported until the regulator grants a permit.</span></div>' : ''}
      <div class="banner ${c.valid ? (b.flagged ? 'warn' : 'ok') : 'bad'}">
        ${c.valid ? (b.flagged ? '⚑ Genuine batch — chain intact, but flagged for a weight discrepancy' : '✔ Genuine batch — chain of custody intact') : '✖ TAMPERING DETECTED'}
        <span class="small">${c.valid ? c.events_checked + ' recorded events verified with SHA-256.' : esc(c.reason)}</span>
      </div>
      <div class="card">
        <h2 class="mono">${esc(b.batch_code)}</h2>
        <table><tbody>
          <tr><th>Mineral</th><td>${esc(b.mineral)}</td></tr>
          <tr><th>Origin</th><td>${esc(b.origin_mine)}${b.province ? ', ' + esc(b.province) : ''}</td></tr>
          <tr><th>Producer</th><td>${esc(b.producer)}</td></tr>
          <tr><th>Current status</th><td>${esc(STATUS[b.status] || b.status)}</td></tr>
          <tr><th>Registered</th><td>${fmt(b.registered_at)}</td></tr>
          <tr><th>Chain head</th><td class="mono small" style="word-break:break-all">${esc(c.head_hash)}</td></tr>
        </tbody></table>
      </div>
      <div class="card"><h3>Chain of custody</h3>
        <ol class="timeline">${d.timeline.map((e) => `<li class="${broken !== null && broken !== undefined && e.seq >= broken ? 'broken' : ''}">
          <b>#${e.seq} ${esc(e.label)}</b><br><span class="small">${esc(e.location)} · ${esc(e.organisation)}</span><br>
          <span class="small muted">${fmt(e.occurred_at)}</span><div class="hash">${esc(e.hash)}</div></li>`).join('')}</ol>
      </div>`;
    $('#scan-card').querySelector('h3').textContent = 'Check another consignment';
  }

  $('#manual').addEventListener('submit', (e) => { e.preventDefault(); verify($('#tok').value); });

  const t = new URLSearchParams(location.search).get('t');
  if (t) verify(t);

  if (window.Html5Qrcode) {
    let done = false;
    scanner = new Html5Qrcode('reader');
    scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: 220 }, (text) => {
      if (done) return; done = true;
      scanner.stop().catch(() => {}); verify(text);
    }, () => {}).catch(() => { $('#reader').innerHTML = '<p class="small muted">Camera unavailable — paste the code below.</p>'; });
  } else {
    $('#reader').innerHTML = '<p class="small muted">Camera scanner could not load — paste the code below.</p>';
  }
})();
