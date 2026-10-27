const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_KEY before running this script.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function testInsertProfile() {
  const userId = '05ba05ca-4877-4811-a5b2-3d899d1e3164';
  const email = 'trader_1793127084463@example.com';
  
  const { data, error } = await supabase.from('profiles').insert([
    {
      id: userId,
      email: email,
      role: 'trader'
    }
  ]).select();

  console.log('Profile insert result:', data, 'error:', error);
}

testInsertProfile();
