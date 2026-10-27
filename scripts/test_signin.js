const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://vhzfbacpvfjdpkthxvej.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZoemZiYWNwdmZqZHBrdGh4dmVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3MzQxNjYsImV4cCI6MjEwNTMxMDE2Nn0.iDkE1RvfZrneScBhjP9xryTsv7lKqwqMzEl6Fepe8cM';

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
