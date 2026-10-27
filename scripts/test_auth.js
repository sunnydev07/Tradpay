const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://vhzfbacpvfjdpkthxvej.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZoemZiYWNwdmZqZHBrdGh4dmVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3MzQxNjYsImV4cCI6MjEwNTMxMDE2Nn0.iDkE1RvfZrneScBhjP9xryTsv7lKqwqMzEl6Fepe8cM';

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
