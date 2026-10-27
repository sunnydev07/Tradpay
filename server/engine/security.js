const crypto = require('crypto');

const PIN_RE = /^\d{6}$/;
const UTR_RE = /^\d{12}$/;
const BUY_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPin(pin, user) {
  if (!user || !user.pinHash || !user.pinSalt) return false;
  if (!PIN_RE.test(String(pin || ''))) return false;
  const derived = crypto.scryptSync(String(pin), user.pinSalt, 64);
  const stored = Buffer.from(user.pinHash, 'hex');
  return stored.length === derived.length && crypto.timingSafeEqual(stored, derived);
}

function isValidPin(pin) {
  return PIN_RE.test(String(pin || ''));
}

function isValidUtr(utr) {
  return UTR_RE.test(String(utr || '').trim());
}

function isValidBuyId(buyId) {
  return typeof buyId === 'string' && BUY_ID_RE.test(buyId);
}

function isAdmin(user) {
  const ids = String(process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return Boolean(user && ids.includes(String(user.id)));
}

function publicUser(user) {
  if (!user) return null;
  const fields = [
    'id', 'userId', 'phone', 'nickname', 'avatar', 'balance', 'totalBalance',
    'rewardTotal', 'pending', 'points', 'vipLevel', 'inviteCode', 'isPinSet',
    'onSellStatus', 'createdAt'
  ];
  const out = {};
  for (const field of fields) {
    if (user[field] !== undefined) out[field] = user[field];
  }
  out.isAdmin = isAdmin(user);
  return out;
}

module.exports = {
  hashToken,
  hashPin,
  verifyPin,
  isValidPin,
  isValidUtr,
  isValidBuyId,
  isAdmin,
  publicUser
};
