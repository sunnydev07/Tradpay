const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_KEY before running this script.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const candidates = [
  'id', 'user_id', 'email', 'phone', 'username', 'name', 'full_name', 
  'avatar_url', 'created_at', 'updated_at', 'role', 'balance', 'pin',
  'data', 'metadata', 'wallets', 'orders', 'status', 'is_admin'
];

async function testCols() {
  for (const c of candidates) {
    const { error } = await supabase.from('profiles').select(c).limit(1);
    if (!error) {
      console.log(`Column '${c}' EXISTS!`);
    } else if (!error.message.includes('Could not find')) {
      console.log(`Column '${c}' error:`, error.message);
    }
  }
}

testCols();
