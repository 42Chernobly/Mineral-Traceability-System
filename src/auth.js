const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('./config');
const db = require('./db');

const ALG = 'HS256';

function signToken(user) {
  return jwt.sign(
    { role: user.role, org: user.organisation, name: user.full_name },
    config.jwtSecret,
    {
      algorithm: ALG,
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
      subject: String(user.id),
      expiresIn: config.jwtExpiry,
    }
  );
}

/** Validates signature, issuer, audience, expiry and algorithm (pinned to HS256). */
function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret, {
    algorithms: [ALG],
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
  });
}

/** Express middleware: authenticates every request and loads the live user record. */
async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'Authentication required' });
  try {
    const claims = verifyToken(m[1]);
    const { rows } = await db.query(
      `SELECT u.id, u.username, u.full_name, u.organisation, u.role, u.active, u.status, u.stop_id,
              s.name AS stop_name, s.country AS stop_country, s.region AS stop_region
       FROM users u LEFT JOIN stops s ON s.id = u.stop_id WHERE u.id = $1`,
      [Number(claims.sub)]
    );
    const user = rows[0];
    if (!user || !user.active || user.status !== 'active') return res.status(401).json({ error: 'Account disabled or not found' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Express middleware factory: restricts a route to the given roles. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Your role is not permitted to perform this action' });
    }
    next();
  };
}

async function hashPassword(pw) {
  return bcrypt.hash(pw, 10);
}

async function checkPassword(pw, hash) {
  return bcrypt.compare(pw, hash);
}

module.exports = { signToken, verifyToken, authenticate, requireRole, hashPassword, checkPassword };
