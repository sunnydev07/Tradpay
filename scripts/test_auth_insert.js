const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://vhzfbacpvfjdpkthxvej.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZoemZiYWNwdmZqZHBrdGh4dmVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3MzQxNjYsImV4cCI6MjEwNTMxMDE2Nn0.iDkE1RvfZrneScBhjP9xryTsv7lKqwqMzEl6Fepe8cM';

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
