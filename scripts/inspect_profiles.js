const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_KEY before running this script.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function inspectProfiles() {
  // Let's test what columns profiles accepts by trying an insert of {} or checking error details
  const { data, error } = await supabase.from('profiles').insert([{ test_col: 'value' }]);
  console.log('Insert test:', error);
}

inspectProfiles();
