const crypto = require('crypto');
const db = require('./db');
const supabaseService = require('./supabaseService');
const security = require('./security');

const CACHE_TTL_MS = 30 * 1000;
const tokenCache = new Map();

function tokenExpiryMs(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return decoded.exp ? Number(decoded.exp) * 1000 : null;
  } catch (e) {
    return null;
  }
}

function extractToken(req) {
  const header = req.headers.authorization || req.headers.token || '';
  if (typeof header !== 'string') return '';
  const trimmed = header.trim();
  return trimmed.startsWith('Bearer ') ? trimmed.slice(7).trim() : trimmed;
}

function newInviteCode(state) {
  const existing = new Set(
    Object.values((state && state.users) || {})
      .map(user => user && user.inviteCode)
      .filter(Boolean)
      .map(code => String(code).toUpperCase())
  );
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const code = 'LP' + Math.floor(1000 + Math.random() * 9000);
    if (!existing.has(code.toUpperCase())) return code;
  }
  return 'LP' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

// Only identity/display data comes from Supabase. Balances, wallets, claimed
// orders and PIN state are created and owned by the server ledger.
function createLocalUser(supUser, state) {
  return {
    id: supUser.id,
    userId: supUser.id,
    phone: supUser.phone || supUser.email || '',
    nickname: supUser.nickname || 'Trader',
    avatar: supUser.avatar || '/static/user/profile.png',
    balance: 0.00,
    totalBalance: 0.00,
    rewardTotal: 0.00,
    pending: 0.00,
    points: 0,
    vipLevel: 1,
    inviteCode: newInviteCode(state),
    pinHash: null,
    pinSalt: null,
    isPinSet: false,
    onSellStatus: 1,
    totalDeposited: 0.00,
    totalWithdrawn: 0.00,
    pendingWithdrawal: 0.00,
    wallets: [],
    claimedOrders: [],
    claimedMissions: [],
    newcomerRewardClaimed: false,
    ledgerBaseline: 0,
    createdAt: supUser.createdAt || new Date().toISOString()
  };
}

async function authenticateToken(token) {
  if (!token || typeof token !== 'string' || token.length > 32768) return null;

  // Supabase access tokens are JWTs. Reject static/predictable tokens outright.
  if (token.split('.').length !== 3) return null;
  const expiresAt = tokenExpiryMs(token);
  if (expiresAt && expiresAt <= Date.now()) return null;

  const state = db.get();
  const tokenHash = security.hashToken(token);

  if (state.revokedTokens && state.revokedTokens[tokenHash]) {
    return null;
  }

  const cached = tokenCache.get(tokenHash);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }

  const supUser = await supabaseService.verifyToken(token);
  if (!supUser) {
    tokenCache.delete(tokenHash);
    return null;
  }

  let user = state.users[supUser.id];
  if (!user) {
    user = createLocalUser(supUser, state);
    state.users[supUser.id] = user;
    db.save();
  } else {
    // Refresh identity/display fields only. Financial and security state is
    // owned by the local ledger and must never be sourced from metadata.
    if (supUser.nickname) user.nickname = supUser.nickname;
    if (supUser.phone) user.phone = supUser.phone;
    if (supUser.avatar) user.avatar = supUser.avatar;
    if (!user.inviteCode) user.inviteCode = newInviteCode(state);
    user.isPinSet = Boolean(user.pinHash && user.pinSalt);
  }

  // Cache user's active session token in memory (non-enumerable so it never serializes to disk)
  Object.defineProperty(user, '_lastToken', {
    value: token,
    writable: true,
    configurable: true,
    enumerable: false
  });

  tokenCache.set(tokenHash, {
    user,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
  return user;
}

function revokeToken(token) {
  if (!token) return false;
  const state = db.get();
  const tokenHash = security.hashToken(token);
  if (!state.revokedTokens) state.revokedTokens = {};
  state.revokedTokens[tokenHash] = Date.now();
  tokenCache.delete(tokenHash);

  // Keep the revocation list bounded.
  const hashes = Object.keys(state.revokedTokens);
  if (hashes.length > 1000) {
    for (const hash of hashes.slice(0, hashes.length - 1000)) {
      delete state.revokedTokens[hash];
    }
  }
  db.save();
  return true;
}

function clearAuthCache() {
  tokenCache.clear();
}

module.exports = {
  extractToken,
  authenticateToken,
  revokeToken,
  clearAuthCache
};
