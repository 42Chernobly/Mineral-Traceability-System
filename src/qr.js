/**
 * Signed batch identifiers for QR codes.
 *
 * QR payload = <baseUrl>/verify.html?t=<token>, token = "v1.<batch_code>.<sig>"
 * sig = first 22 chars of base64url(HMAC-SHA256(QR_SECRET, batch_code)).
 * A forged or edited code fails signature validation on scan, so QR codes
 * cannot be invented for non-existent batches (risk R3 in the proposal).
 */
const crypto = require('crypto');
const QRCode = require('qrcode');
const config = require('./config');

function sign(batchCode) {
  return crypto.createHmac('sha256', config.qrSecret).update(batchCode).digest('base64url').slice(0, 22);
}

function makeToken(batchCode) {
  return `v1.${batchCode}.${sign(batchCode)}`;
}

/** Returns the batch code if the token is genuine, otherwise null. */
function parseToken(raw) {
  if (typeof raw !== 'string') return null;
  let token = raw.trim();
  // Accept a full scanned URL as well as a bare token
  const m = token.match(/[?&]t=([^&#]+)/);
  if (m) token = decodeURIComponent(m[1]);
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, code, sig] = parts;
  if (!/^[A-Z0-9-]{6,40}$/.test(code)) return null;
  const expected = Buffer.from(sign(code));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  return code;
}

function verifyUrl(token, req) {
  const base = config.baseUrl || (req ? `${req.protocol}://${req.get('host')}` : '');
  return `${base}/verify.html?t=${encodeURIComponent(token)}`;
}

async function qrPngBuffer(url) {
  return QRCode.toBuffer(url, { errorCorrectionLevel: 'M', margin: 2, width: 360 });
}

module.exports = { makeToken, parseToken, verifyUrl, qrPngBuffer };
