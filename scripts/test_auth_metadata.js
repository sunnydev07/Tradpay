const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_KEY before running this script.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function testMetadata() {
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

  console.log('User signed in:', authData.user.id);
  console.log('Initial metadata:', authData.user.user_metadata);

  // Update user metadata in Supabase
  const { data: updateData, error: updateError } = await supabase.auth.updateUser({
    data: {
      balance: 15420.50,
      rewardTotal: 3480.00,
      nickname: 'Alex Supreme',
      pin: '654321',
      wallets: [
        { id: 101, ctType: 3, account: 'alex@ybl', status: 1, minAmount: 500, maxAmount: 25000 }
      ]
    }
  });

  if (updateError) {
    console.log('Update error:', updateError);
  } else {
    console.log('Metadata updated successfully in Supabase!');
    console.log('Updated user metadata:', updateData.user.user_metadata);
  }
}

testMetadata();
