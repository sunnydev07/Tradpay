const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_KEY before running this script.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const tables = [
  'todos', 'posts', 'items', 'products', 'accounts', 'transactions',
  'user_profiles', 'app_users', 'wallet_list', 'order_list',
  'messages', 'notifications', 'settings', 'logs'
];

async function scan() {
  for (const t of tables) {
    const { data, error } = await supabase.from(t).select('*').limit(1);
    if (!error) {
      console.log(`Table '${t}' EXISTS! Rows: ${data.length}`);
    }
  }
}

scan();
