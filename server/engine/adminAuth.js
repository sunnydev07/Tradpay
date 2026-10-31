const crypto = require('crypto');

const MIN_KEY_LENGTH = 32;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const SESSION_VERSION = 'v1';

// Values that have shipped in documentation, tests, or old source code. They
// must never authenticate a real admin, even if someone copies them into the
// environment by mistake.
const FORBIDDEN_KEYS = new Set([
  'dev780@$$',
  'change-me',
  'changeme',
  'admin',
  'password',
  'secret',
  'your-admin-key'
]);

function readConfiguredKey() {
  const value = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '';
  return typeof value === 'string' ? value.trim() : '';
}

function validateConfiguredKey(key = readConfiguredKey()) {
  const value = typeof key === 'string' ? key.trim() : '';
  if (!value) {
    return { ok: false, reason: 'ADMIN_KEY is not set' };
  }
  if (FORBIDDEN_KEYS.has(value.toLowerCase())) {
    return { ok: false, reason: 'ADMIN_KEY is a known default or placeholder value' };
  }
  if (value.length < MIN_KEY_LENGTH) {
    return { ok: false, reason: `ADMIN_KEY is too short (minimum ${MIN_KEY_LENGTH} characters)` };
  }
  return { ok: true, key: value };
}

function isConfigured() {
  return validateConfiguredKey().ok;
}

// Hash both values first so timingSafeEqual always receives equal-length
// buffers. This avoids leaking the configured key's length through timing.
function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function verifyKey(candidate) {
  const configured = validateConfiguredKey();
  if (!configured.ok) return false;
  if (typeof candidate !== 'string' || !candidate) return false;
  return safeEqual(candidate.trim(), configured.key);
}

function signPayload(encodedPayload, key) {
  return crypto
    .createHmac('sha256', key)
    .update(`${SESSION_VERSION}.${encodedPayload}`)
    .digest('base64url');
}

function createAdminSession({ subject = 'admin', ttlMs = SESSION_TTL_MS } = {}) {
  const configured = validateConfiguredKey();
  if (!configured.ok) return null;

  const now = Date.now();
  const ttl = Number.isFinite(Number(ttlMs)) ? Number(ttlMs) : SESSION_TTL_MS;
  const payload = {
    v: 1,
    t: 'admin',
    sub: String(subject || 'admin'),
    iat: now,
    exp: now + ttl
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = signPayload(encoded, configured.key);

  return {
    token: `${SESSION_VERSION}.${encoded}.${signature}`,
    expiresAt: new Date(payload.exp).toISOString()
  };
}

function verifySessionToken(token) {
  const configured = validateConfiguredKey();
  if (!configured.ok || typeof token !== 'string' || !token) return null;

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== SESSION_VERSION) return null;

  const [, encoded, signature] = parts;
  if (!encoded || !signature) return null;

  let provided;
  let expected;
  try {
    provided = Buffer.from(signature, 'base64url');
    expected = Buffer.from(signPayload(encoded, configured.key), 'base64url');
  } catch (e) {
    return null;
  }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }

  if (!payload || payload.v !== 1 || payload.t !== 'admin') return null;
  if (!Number.isFinite(payload.exp) || payload.exp <= Date.now()) return null;
  return payload;
}

module.exports = {
  MIN_KEY_LENGTH,
  SESSION_TTL_MS,
  validateConfiguredKey,
  isConfigured,
  verifyKey,
  createAdminSession,
  verifySessionToken
};
