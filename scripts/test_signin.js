const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_KEY before running this script.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function testSignIn() {
  const testEmail = 'trader_1793127084463@example.com';
  const testPassword = 'Password123!';
  
  const { data, error } = await supabase.auth.signInWithPassword({
    email: testEmail,
    password: testPassword
  });

  if (error) {
    console.log('Auth signIn error:', error.message);
  } else {
    console.log('Auth signIn success! Token:', data.session?.access_token ? 'VALID_JWT' : 'NO_TOKEN');
  }
}

testSignIn();
