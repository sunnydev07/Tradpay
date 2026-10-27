const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://vhzfbacpvfjdpkthxvej.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZoemZiYWNwdmZqZHBrdGh4dmVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3MzQxNjYsImV4cCI6MjEwNTMxMDE2Nn0.iDkE1RvfZrneScBhjP9xryTsv7lKqwqMzEl6Fepe8cM';

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
