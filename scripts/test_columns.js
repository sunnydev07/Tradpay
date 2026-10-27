const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://vhzfbacpvfjdpkthxvej.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZoemZiYWNwdmZqZHBrdGh4dmVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3MzQxNjYsImV4cCI6MjEwNTMxMDE2Nn0.iDkE1RvfZrneScBhjP9xryTsv7lKqwqMzEl6Fepe8cM';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const candidates = [
  'id', 'user_id', 'email', 'phone', 'username', 'name', 'full_name', 
  'avatar_url', 'created_at', 'updated_at', 'role', 'balance', 'pin',
  'data', 'metadata', 'wallets', 'orders', 'status', 'is_admin'
];

async function testCols() {
  for (const c of candidates) {
    const { error } = await supabase.from('profiles').select(c).limit(1);
    if (!error) {
      console.log(`Column '${c}' EXISTS!`);
    } else if (!error.message.includes('Could not find')) {
      console.log(`Column '${c}' error:`, error.message);
    }
  }
}

testCols();
