/* Shared helpers for the dashboard and the public verification portal. */
(function () {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ESC[c]);

  const fmtDate = (d) => {
    if (!d) return '';
    const x = new Date(d);
    return x.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };
  const fmtKg = (n) => (n === null || n === undefined ? '' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 }) + ' kg');
  const shortHash = (h) => (h ? h.slice(0, 10) + '…' + h.slice(-6) : '');

  const STATUS = {
    registered: 'Registered', processed: 'Processed', in_transit: 'In transit', inspected: 'Inspected',
    export_approved: 'Export approved', exported: 'Exported', received: 'Received',
  };
  const statusBadge = (s) => {
    const cls = s === 'received' || s === 'exported' ? 'ok' : s === 'export_approved' ? 'ok' : '';
    return `<span class="badge ${cls}">${esc(STATUS[s] || s)}</span>`;
  };

  let toastTimer;
  function toast(msg, bad) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 4500);
  }

  /** Starts the camera QR scanner (html5-qrcode). Returns a stop() function. */
  async function startScanner(elementId, onToken, onError) {
    if (typeof Html5Qrcode === 'undefined') { onError('Scanner library failed to load'); return () => {}; }
    const scanner = new Html5Qrcode(elementId);
    let done = false;
    try {
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        (text) => { if (!done) { done = true; onToken(text); } },
        () => {}
      );
    } catch (e) {
      onError('Camera unavailable: ' + (e && e.message ? e.message : e) + '. Use the manual entry box instead.');
      return () => {};
    }
    return async () => { try { await scanner.stop(); scanner.clear(); } catch (_) { /* already stopped */ } };
  }

  window.TC = { esc, fmtDate, fmtKg, shortHash, STATUS, statusBadge, toast, startScanner };
})();
