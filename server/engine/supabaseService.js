const { createClient } = require('@supabase/supabase-js');
const { loadLocalEnv } = require('./env');

// Load local .env values only when the host environment does not provide them.
loadLocalEnv();

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

// 1. Sign up user via Supabase Auth with identity metadata only. Financial and
// PIN state is created by the server ledger after the first authenticated call.
async function signUpUser({ identifier, password, nickname = '', phone = '' }) {
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

  const initialMetadata = {
    nickname: cleanNick,
    phone: userPhone,
    identifier: identifierValue,
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
      avatar: metadata.avatar || '/static/user/profile.png'
    }
  };
}

// 3. Update user metadata in Supabase
async function updateUserRecord(token, metadataUpdates = {}, userId = null) {
  if (!isConfigured()) return { synced: false, reason: 'not configured' };
  if (!metadataUpdates || !Object.keys(metadataUpdates).length) {
    return { synced: true };
  }

  const admin = getAdminClient();

  // Path A: Use admin client if configured
  if (admin) {
    try {
      const client = getClient();
      let targetUserId = userId || null;
      if (!targetUserId && token) {
        const { data: { user } } = await client.auth.getUser(token);
        if (user) targetUserId = user.id;
      }
      if (targetUserId) {
        const { error } = await admin.auth.admin.updateUserById(targetUserId, {
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

// 4. Sync display/profile fields only. Money, wallets, claimed orders and PIN
// state stay in the server ledger and are never written to user_metadata.
function buildSyncPayload(user) {
  return {
    nickname: user.nickname || 'Trader',
    phone: user.phone || '',
    avatar: user.avatar || '/static/user/profile.png',
    updatedAt: new Date().toISOString()
  };
}

async function syncUserData(user, token = null) {
  if (!user || !user.id) return { synced: false };
  const authToken = token || user._lastToken;
  return updateUserRecord(authToken, buildSyncPayload(user), user.id);
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
      createdAt: user.created_at
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
  buildSyncPayload,
  syncUserData,
  verifyToken
};
