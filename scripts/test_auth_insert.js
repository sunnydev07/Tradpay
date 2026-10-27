const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_KEY before running this script.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function testAuthInsert() {
  const testEmail = 'trader_1793127084463@example.com';
  const testPassword = 'Password123!';

  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email: testEmail,
    password: testPassword
  });

  if (authError) {
    console.log('Login error:', authError);
    return;
  }

  console.log('Logged in as:', authData.user.id);

  const { data, error } = await supabase.from('profiles').insert([
    {
      id: authData.user.id,
      email: testEmail,
      role: 'user'
    }
  ]).select();

  console.log('Authenticated insert:', data, 'error:', error);
}

testAuthInsert();
