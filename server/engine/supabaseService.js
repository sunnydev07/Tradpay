const { createClient } = require('@supabase/supabase-js');

// Supabase configuration is supplied by the environment only. The project URL
// and publishable key are not secrets, but hardcoding them couples every fork
// to one project and makes it too easy to ship against the wrong backend.
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
  if (trimmed.includes('@')) {
    return trimmed.toLowerCase();
  }
  const cleanPhone = trimmed.replace(/\D/g, '');
  return `${cleanPhone || 'user' + Date.now()}@tradepay.live`;
}

// 1. Sign up user via Supabase Auth with ZERO initial balances.
// Financial and PIN state is owned by the server, never by user_metadata.
async function signUpUser({ identifier, password, nickname = '', phone = '' }) {
  const client = getClient();
  if (!client) throw new Error('Authentication service is not configured');

  const identifierValue = String(identifier || phone || '').trim();
  const email = normalizeAuthIdentifier(identifierValue);
  const userPhone = phone || (identifierValue.includes('@') ? '' : identifierValue);
  const cleanNick = nickname || ('Trader_' + Math.floor(1000 + Math.random() * 9000));
  const inviteCode = 'LP' + Math.floor(1000 + Math.random() * 9000);

  const initialMetadata = {
    nickname: cleanNick,
    phone: userPhone,
    inviteCode,
    vipLevel: 1
  };

  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: { data: initialMetadata }
  });

  if (error) throw new Error(error.message);
  if (!data.user) throw new Error('Registration failed');

  const token = data.session?.access_token;
  if (!token) {
    throw new Error('Account created. Confirm your email address before signing in.');
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

// 2. Sign in user via Supabase Auth. Returns identity/profile only.
async function signInUser({ identifier, password }) {
  const client = getClient();
  if (!client) throw new Error('Authentication service is not configured');

  const email = normalizeAuthIdentifier(identifier);

  const { data, error } = await client.auth.signInWithPassword({
    email,
    password
  });

  if (error) throw new Error(error.message);
  if (!data.user || !data.session?.access_token) {
    throw new Error('Sign in failed');
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
      inviteCode: metadata.inviteCode || 'LP8899',
      vipLevel: Number(metadata.vipLevel) || 1
    }
  };
}

// 3. Update non-sensitive profile metadata only.
// Balance, PIN, wallets, rewards and referral state must never be written to
// client-writable Supabase user_metadata.
async function updateUserRecord(token, metadataUpdates = {}) {
  const client = getClient();
  const admin = getAdminClient();
  const safeKeys = ['nickname', 'phone', 'avatar'];
  const safeUpdates = {};
  for (const key of safeKeys) {
    if (metadataUpdates[key] !== undefined) safeUpdates[key] = metadataUpdates[key];
  }
  if (!Object.keys(safeUpdates).length || !client || !admin) {
    return { synced: false, reason: 'admin sync not configured' };
  }

  try {
    const { data: { user }, error } = await client.auth.getUser(token);
    if (error || !user) return { synced: false, reason: 'invalid session' };

    const merged = { ...(user.user_metadata || {}), ...safeUpdates };
    const { error: updateError } = await admin.auth.admin.updateUserById(user.id, {
      user_metadata: merged
    });
    if (updateError) return { synced: false, reason: updateError.message };
    return { synced: true };
  } catch (err) {
    console.error('[Supabase] updateUserRecord error:', err.message);
    return { synced: false, reason: err.message };
  }
}

// 4. Verify a bearer token with Supabase and return identity/profile only.
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
      vipLevel: Number(metadata.vipLevel) || 1
    };
  } catch (e) {
    return null;
  }
}

module.exports = {
  isConfigured,
  getClient,
  signUpUser,
  signInUser,
  updateUserRecord,
  verifyToken
};
