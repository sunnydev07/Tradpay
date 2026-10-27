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

function newInviteCode() {
  return 'LP' + Math.floor(1000 + Math.random() * 9000);
}

function createLocalUser(supUser) {
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
    vipLevel: Number(supUser.vipLevel) || 1,
    inviteCode: supUser.inviteCode || newInviteCode(),
    pinHash: null,
    pinSalt: null,
    isPinSet: false,
    onSellStatus: 1,
    wallets: [],
    claimedOrders: [],
    claimedMissions: [],
    newcomerRewardClaimed: false,
    createdAt: new Date().toISOString()
  };
}

async function authenticateToken(token) {
  if (!token || typeof token !== 'string' || token.length > 4096) return null;

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
    user = createLocalUser(supUser);
    state.users[supUser.id] = user;
    db.save();
  } else {
    // Supabase identity may refresh non-sensitive profile fields only.
    if (supUser.nickname) user.nickname = supUser.nickname;
    if (supUser.phone) user.phone = supUser.phone;
    if (supUser.avatar) user.avatar = supUser.avatar;
    if (!user.inviteCode && supUser.inviteCode) user.inviteCode = supUser.inviteCode;
  }

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
