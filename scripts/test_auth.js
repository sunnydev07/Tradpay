const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_KEY before running this script.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function testAuth() {
  console.log('Testing Supabase Auth...');
  const testEmail = `trader_${Date.now()}@example.com`;
  const testPassword = 'Password123!';
  
  const { data, error } = await supabase.auth.signUp({
    email: testEmail,
    password: testPassword,
    options: {
      data: {
        phone: '+919876543210',
        nickname: 'Trader Test'
      }
    }
  });

  if (error) {
    console.log('Auth signUp error:', error.message);
  } else {
    console.log('Auth signUp success! User ID:', data.user?.id, 'Email:', data.user?.email);
  }
}

testAuth();
