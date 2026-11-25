require('dotenv').config({ quiet: true });
const crypto = require('crypto');

const isProd = process.env.NODE_ENV === 'production';

function secret(name) {
  const v = process.env[name];
  if (v && v.length >= 32) return v;
  if (isProd) {
    throw new Error(`${name} must be set to a random string of at least 32 characters in production`);
  }
  // Development / demo only: ephemeral random secret (tokens die on restart).
  return crypto.randomBytes(48).toString('hex');
}

// Map basemap. Default: OpenStreetMap's standard tiles. They work for a low-traffic app as long as every
// request carries a Referer (see referrerPolicy in app.js) and the attribution is shown. The OSM tile policy
// forbids heavy use and bulk downloading; for a busy or commercial deployment use a keyed provider instead.
// Override with TILE_URL (and optionally TILE_URL_DARK, TILE_ATTRIBUTION, TILE_SUBDOMAINS), e.g. MapTiler or
// Stadia Maps with your own API key. Note: CARTO's basemaps now require an API key too.
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
const tileUrl = process.env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const tileUrlDark = process.env.TILE_URL_DARK || ''; // empty: the light tiles are darkened with CSS in dark mode
const tileAttribution = process.env.TILE_ATTRIBUTION || OSM_ATTRIBUTION;

/** CSP img-src entries for a tile URL template: {s} becomes a wildcard subdomain. */
function tileOrigin(template) {
  if (!template) return null;
  try {
    const sub = template.includes('{s}');
    const u = new URL(template.replace('{s}', 'x').replace(/\{[a-z]+\}/g, '0'));
    if (u.protocol !== 'https:') return null; // plain-http tiles would be blocked as mixed content anyway
    return sub ? `https://*.${u.host.replace(/^x\./, '')}` : u.origin;
  } catch (e) { return null; }
}

module.exports = {
  isProd,
  map: {
    tileUrl,
    tileUrlDark,
    attribution: tileAttribution,
    subdomains: process.env.TILE_SUBDOMAINS || 'abc',
    imgOrigins: [...new Set([tileOrigin(tileUrl), tileOrigin(tileUrlDark)].filter(Boolean))],
  },
  port: parseInt(process.env.PORT || '3000', 10),
  baseUrl: (process.env.BASE_URL || '').replace(/\/$/, ''),
  databaseUrl: process.env.DATABASE_URL || '',
  databaseSsl: process.env.DATABASE_SSL === 'true',
  jwtSecret: secret('JWT_SECRET'),
  qrSecret: secret('QR_SECRET'),
  jwtIssuer: 'mineral-traceability',
  jwtAudience: 'mineral-traceability-clients',
  jwtExpiry: process.env.JWT_EXPIRY || '8h',
  seedDemo: process.env.SEED_DEMO
    ? process.env.SEED_DEMO === 'true'
    : !process.env.DATABASE_URL, // auto-seed in zero-setup mode
  // Tamper demo: explicit setting wins; otherwise on only for the zero-setup local demo
  // (in-memory DB, not production). Always off by default on real deployments.
  enableTamperDemo: process.env.ENABLE_TAMPER_DEMO
    ? process.env.ENABLE_TAMPER_DEMO === 'true'
    : !isProd && !process.env.DATABASE_URL,
};
