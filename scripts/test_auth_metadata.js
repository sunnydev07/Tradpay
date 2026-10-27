const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://vhzfbacpvfjdpkthxvej.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZoemZiYWNwdmZqZHBrdGh4dmVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3MzQxNjYsImV4cCI6MjEwNTMxMDE2Nn0.iDkE1RvfZrneScBhjP9xryTsv7lKqwqMzEl6Fepe8cM';

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
