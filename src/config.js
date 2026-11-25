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

module.exports = {
  isProd,
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
