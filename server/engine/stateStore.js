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
  if (!String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()) {
    return 'TRADEPAY_STATE_BACKEND=supabase requires SUPABASE_SERVICE_ROLE_KEY (server-only)';
  }
  return null;
}

function isEnabled() {
  if (!isSupabaseRequested() || getConfigError()) return false;
  // getAdminClient() uses the service-role key and is the only client allowed
  // to read or write the authoritative state row.
  return Boolean(supabaseService.getAdminClient());
}

function getTable() {
  return TABLE;
}

function getId() {
  return ROW_ID;
}

async function load() {
  const client = supabaseService.getAdminClient();
  if (!client) {
    throw new Error('Supabase admin client is not configured');
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
  const client = supabaseService.getAdminClient();
  if (!client) {
    throw new Error('Supabase admin client is not configured');
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
