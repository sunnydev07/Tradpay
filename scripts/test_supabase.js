const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://vhzfbacpvfjdpkthxvej.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZoemZiYWNwdmZqZHBrdGh4dmVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3MzQxNjYsImV4cCI6MjEwNTMxMDE2Nn0.iDkE1RvfZrneScBhjP9xryTsv7lKqwqMzEl6Fepe8cM';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function check() {
  console.log('Testing Supabase Connection...');
  
  // Try querying profiles, users, orders, wallets
  const tables = ['users', 'profiles', 'orders', 'wallets', 'tradepay_orders', 'tradepay_wallets'];
  for (const t of tables) {
    const { data, error } = await supabase.from(t).select('*').limit(1);
    if (error) {
      console.log(`Table '${t}': error ->`, error.message, `(code: ${error.code})`);
    } else {
      console.log(`Table '${t}': EXISTS! Found ${data.length} rows`);
    }
  }
}

check();
