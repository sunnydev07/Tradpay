const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// Automatically load local .env file if available in the environment
if (typeof process.loadEnvFile === 'function') {
  try {
    const envPath = path.resolve(__dirname, '../../.env');
    if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
  } catch (e) { /* ignore */ }
}

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_KEY = String(process.env.SUPABASE_KEY || '').trim();
const SUPABASE_SERVICE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

let supabase = null;
let adminClient = null;

function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

function getClient() {
  if (!isConfigured()) return null;
  if (!supabase) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return supabase;
}

function getAdminClient() {
  if (!isConfigured() || !SUPABASE_SERVICE_KEY) return null;
  if (!adminClient) {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return adminClient;
}

function normalizeAuthIdentifier(identifier) {
  const trimmed = String(identifier || '').trim();
  if (!trimmed) return `user_${Date.now()}@tradepay.live`;

  // 1. Direct email address
  if (trimmed.includes('@')) {
    return trimmed.toLowerCase();
  }

  // 2. Phone number (detect digits)
  const digitsOnly = trimmed.replace(/\D/g, '');
  if (digitsOnly.length >= 7 && digitsOnly.length <= 15) {
    let cleanPhone = digitsOnly;
    // Normalize Indian 10-digit mobile
    if (cleanPhone.length === 12 && cleanPhone.startsWith('91')) {
      cleanPhone = cleanPhone.slice(2);
    } else if (cleanPhone.length === 11 && cleanPhone.startsWith('0')) {
      cleanPhone = cleanPhone.slice(1);
    }
    return `${cleanPhone}@tradepay.live`;
  }

  // 3. Alphanumeric username (deterministic)
  const cleanUsername = trimmed.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (cleanUsername) {
    return `${cleanUsername}@tradepay.live`;
  }

  return `user_${Date.now()}@tradepay.live`;
}

// 1. Sign up user via Supabase Auth with complete user metadata
async function signUpUser({ identifier, password, nickname = '', phone = '', inviteCode = '' }) {
  const client = getClient();
  if (!client) throw new Error('Authentication service is not configured');

  const identifierValue = String(identifier || phone || '').trim();
  if (!identifierValue) throw new Error('Phone, email, or username is required');
  if (typeof password !== 'string' || password.length < 6) {
    throw new Error('Password must be at least 6 characters');
  }

  const email = normalizeAuthIdentifier(identifierValue);
  const digitsOnly = identifierValue.replace(/\D/g, '');
  const userPhone = phone || (digitsOnly.length >= 10 ? digitsOnly : '');
  const cleanNick = nickname || ('Trader_' + Math.floor(1000 + Math.random() * 9000));
  const finalInviteCode = inviteCode || ('TP' + Math.floor(1000 + Math.random() * 9000));

  const initialMetadata = {
    nickname: cleanNick,
    phone: userPhone,
    identifier: identifierValue,
    inviteCode: finalInviteCode,
    vipLevel: 1,
    balance: 0.00,
    totalBalance: 0.00,
    rewardTotal: 0.00,
    pending: 0.00,
    points: 0,
    isPinSet: false,
    onSellStatus: 1,
    wallets: [],
    claimedOrders: [],
    claimedMissions: [],
    newcomerRewardClaimed: false,
    createdAt: new Date().toISOString()
  };

  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: { data: initialMetadata }
  });

  if (error) {
    if (error.message.includes('User already registered') || error.message.includes('already exists')) {
      throw new Error('Account already exists for this phone or email. Please sign in instead.');
    }
    throw new Error(error.message);
  }
  if (!data.user) throw new Error('Registration failed');

  let token = data.session?.access_token;
  if (!token) {
    // Attempt immediate sign-in to retrieve session token
    try {
      const signInRes = await client.auth.signInWithPassword({ email, password });
      token = signInRes.data?.session?.access_token;
    } catch (e) {
      // ignore
    }
  }

  if (!token) {
    throw new Error('Account created! Please sign in with your password.');
  }

  return {
    token,
    user: {
      id: data.user.id,
      email: data.user.email,
      ...initialMetadata
    }
  };
}

// 2. Sign in user via Supabase Auth.
async function signInUser({ identifier, password }) {
  const client = getClient();
  if (!client) throw new Error('Authentication service is not configured');

  const trimmed = String(identifier || '').trim();
  if (!trimmed) throw new Error('Identifier is required');
  if (!password) throw new Error('Password is required');

  const email = normalizeAuthIdentifier(trimmed);

  let { data, error } = await client.auth.signInWithPassword({
    email,
    password
  });

  // Fallback: If not found and input didn't have @, try raw identifier as email
  if (error && !trimmed.includes('@') && email !== trimmed) {
    try {
      const retry = await client.auth.signInWithPassword({
        email: trimmed,
        password
      });
      if (!retry.error && retry.data?.user) {
        data = retry.data;
        error = null;
      }
    } catch (e) {
      // ignore
    }
  }

  if (error) {
    if (error.message.includes('Invalid login credentials')) {
      throw new Error('Invalid phone/email or password. Please verify your credentials.');
    }
    if (error.message.includes('Email not confirmed')) {
      throw new Error('Email not confirmed. Please check your inbox or contact support.');
    }
    throw new Error(error.message);
  }

  if (!data.user || !data.session?.access_token) {
    throw new Error('Sign in failed. Could not obtain session token.');
  }

  const metadata = data.user.user_metadata || {};
  return {
    token: data.session.access_token,
    user: {
      id: data.user.id,
      email: data.user.email,
      nickname: metadata.nickname || 'Trader',
      phone: metadata.phone || data.user.phone || '',
      avatar: metadata.avatar || '/static/user/profile.png',
      inviteCode: metadata.inviteCode || 'TP8899',
      vipLevel: Number(metadata.vipLevel) || 1,
      balance: metadata.balance != null ? Number(metadata.balance) : 0.00,
      totalBalance: metadata.totalBalance != null ? Number(metadata.totalBalance) : 0.00,
      rewardTotal: metadata.rewardTotal != null ? Number(metadata.rewardTotal) : 0.00,
      pending: metadata.pending != null ? Number(metadata.pending) : 0.00,
      points: metadata.points != null ? Number(metadata.points) : 0,
      isPinSet: Boolean(metadata.isPinSet || metadata.pinHash),
      onSellStatus: metadata.onSellStatus != null ? metadata.onSellStatus : 1,
      wallets: Array.isArray(metadata.wallets) ? metadata.wallets : [],
      claimedOrders: Array.isArray(metadata.claimedOrders) ? metadata.claimedOrders : []
    }
  };
}

// 3. Update user metadata in Supabase
async function updateUserRecord(token, metadataUpdates = {}) {
  if (!isConfigured()) return { synced: false, reason: 'not configured' };
  if (!metadataUpdates || !Object.keys(metadataUpdates).length) {
    return { synced: true };
  }

  const admin = getAdminClient();

  // Path A: Use admin client if configured
  if (admin) {
    try {
      const client = getClient();
      let userId = null;
      if (token) {
        const { data: { user } } = await client.auth.getUser(token);
        if (user) userId = user.id;
      }
      if (userId) {
        const { error } = await admin.auth.admin.updateUserById(userId, {
          user_metadata: metadataUpdates
        });
        if (!error) return { synced: true };
      }
    } catch (e) {
      console.warn('[Supabase] Admin update error:', e.message);
    }
  }

  // Path B: Direct REST API update using the user's session token
  if (token && typeof token === 'string' && token.split('.').length === 3) {
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        method: 'PUT',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ data: metadataUpdates })
      });
      if (res.ok) {
        return { synced: true };
      }
    } catch (err) {
      console.warn('[Supabase] REST update error:', err.message);
    }
  }

  return { synced: false, reason: 'no valid token or admin credentials' };
}

// 4. Sync a local user object's complete financial and profile state to Supabase
async function syncUserData(user, token = null) {
  if (!user || !user.id) return { synced: false };

  const payload = {
    nickname: user.nickname,
    phone: user.phone,
    avatar: user.avatar,
    balance: Number(user.balance) || 0.00,
    totalBalance: Number(user.totalBalance) || Number(user.balance) || 0.00,
    rewardTotal: Number(user.rewardTotal) || 0.00,
    pending: Number(user.pending) || 0.00,
    points: Number(user.points) || 0,
    vipLevel: Number(user.vipLevel) || 1,
    inviteCode: user.inviteCode,
    isPinSet: Boolean(user.isPinSet || user.pinHash),
    onSellStatus: user.onSellStatus != null ? user.onSellStatus : 1,
    wallets: Array.isArray(user.wallets) ? user.wallets : [],
    claimedOrders: Array.isArray(user.claimedOrders) ? user.claimedOrders : [],
    claimedMissions: Array.isArray(user.claimedMissions) ? user.claimedMissions : [],
    newcomerRewardClaimed: Boolean(user.newcomerRewardClaimed),
    updatedAt: new Date().toISOString()
  };

  const authToken = token || user._lastToken;
  return updateUserRecord(authToken, payload);
}

// 5. Verify bearer token with Supabase and return complete user metadata
async function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const client = getClient();
  if (!client) return null;

  try {
    const { data: { user }, error } = await client.auth.getUser(token);
    if (error || !user) return null;

    const metadata = user.user_metadata || {};
    return {
      id: user.id,
      email: user.email,
      phone: metadata.phone || user.phone || '',
      nickname: metadata.nickname || 'Trader',
      avatar: metadata.avatar || '/static/user/profile.png',
      inviteCode: metadata.inviteCode || null,
      vipLevel: Number(metadata.vipLevel) || 1,
      balance: metadata.balance != null ? Number(metadata.balance) : 0.00,
      totalBalance: metadata.totalBalance != null ? Number(metadata.totalBalance) : 0.00,
      rewardTotal: metadata.rewardTotal != null ? Number(metadata.rewardTotal) : 0.00,
      pending: metadata.pending != null ? Number(metadata.pending) : 0.00,
      points: metadata.points != null ? Number(metadata.points) : 0,
      isPinSet: Boolean(metadata.isPinSet || metadata.pinHash),
      onSellStatus: metadata.onSellStatus != null ? metadata.onSellStatus : 1,
      wallets: Array.isArray(metadata.wallets) ? metadata.wallets : [],
      claimedOrders: Array.isArray(metadata.claimedOrders) ? metadata.claimedOrders : [],
      claimedMissions: Array.isArray(metadata.claimedMissions) ? metadata.claimedMissions : [],
      newcomerRewardClaimed: Boolean(metadata.newcomerRewardClaimed),
      createdAt: metadata.createdAt || user.created_at
    };
  } catch (e) {
    return null;
  }
}

module.exports = {
  isConfigured,
  getClient,
  getAdminClient,
  normalizeAuthIdentifier,
  signUpUser,
  signInUser,
  updateUserRecord,
  syncUserData,
  verifyToken
};
