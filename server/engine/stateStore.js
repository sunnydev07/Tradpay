const { createClient } = require('@supabase/supabase-js');
const supabaseService = require('./supabaseService');

const TABLE = 'tradepay_state';
const ROW_ID = String(process.env.TRADEPAY_STATE_ID || 'primary').trim() || 'primary';

function backend() {
  return String(process.env.TRADEPAY_STATE_BACKEND || '').trim().toLowerCase();
}

function isSupabaseRequested() {
  return backend() === 'supabase';
}

function getConfigError() {
  if (!isSupabaseRequested()) return null;

  if (!String(process.env.SUPABASE_URL || '').trim()) {
    return 'TRADEPAY_STATE_BACKEND=supabase requires SUPABASE_URL';
  }
  if (!String(process.env.SUPABASE_KEY || '').trim()) {
    return 'TRADEPAY_STATE_BACKEND=supabase requires SUPABASE_KEY';
  }

  const stateUrl = String(process.env.SUPABASE_STATE_URL || '').trim();
  if (stateUrl) {
    // A dedicated state project must use its own service key. Never send the
    // Auth project's service key to a different project.
    if (!String(process.env.SUPABASE_STATE_SERVICE_ROLE_KEY || '').trim()) {
      return 'SUPABASE_STATE_URL requires SUPABASE_STATE_SERVICE_ROLE_KEY (server-only)';
    }
  } else if (!String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()) {
    return 'TRADEPAY_STATE_BACKEND=supabase requires SUPABASE_SERVICE_ROLE_KEY (server-only)';
  }

  return null;
}

let dedicatedStateClient = null;
let dedicatedStateClientConfig = '';

function getStateClient() {
  const stateUrl = String(process.env.SUPABASE_STATE_URL || '').trim();

  // Backward compatibility: one project for Auth and state.
  if (!stateUrl) {
    return supabaseService.getAdminClient();
  }

  const stateKey = String(process.env.SUPABASE_STATE_SERVICE_ROLE_KEY || '').trim();
  if (!stateKey) return null;

  const configKey = `${stateUrl}\u0000${stateKey}`;
  if (!dedicatedStateClient || dedicatedStateClientConfig !== configKey) {
    dedicatedStateClient = createClient(stateUrl, stateKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      // Bound state requests so startup cannot hang indefinitely.
      db: { timeout: 20000 }
    });
    dedicatedStateClientConfig = configKey;
  }
  return dedicatedStateClient;
}

function isEnabled() {
  return Boolean(isSupabaseRequested() && !getConfigError() && getStateClient());
}

function getTable() {
  return TABLE;
}

function getId() {
  return ROW_ID;
}

async function load() {
  const client = getStateClient();
  if (!client) {
    throw new Error('Supabase state client is not configured');
  }

  const { data, error } = await client
    .from(TABLE)
    .select('id,revision,state,updated_at')
    .eq('id', ROW_ID)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Supabase state load failed: ${error.message}. ` +
      'Run supabase/schema.sql and verify the service-role key.'
    );
  }
  return data || null;
}

async function save(state, revision) {
  const client = getStateClient();
  if (!client) {
    throw new Error('Supabase state client is not configured');
  }

  const { data, error } = await client.rpc('save_tradepay_state', {
    p_id: ROW_ID,
    p_state: state,
    p_revision: revision
  });

  if (error) {
    throw new Error(
      `Supabase state save failed: ${error.message}. ` +
      'Run supabase/schema.sql and verify the service-role key.'
    );
  }
  return data;
}

module.exports = {
  TABLE,
  ROW_ID,
  backend,
  isSupabaseRequested,
  getConfigError,
  isEnabled,
  getTable,
  getId,
  load,
  save
};
