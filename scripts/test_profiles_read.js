const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://vhzfbacpvfjdpkthxvej.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZoemZiYWNwdmZqZHBrdGh4dmVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3MzQxNjYsImV4cCI6MjEwNTMxMDE2Nn0.iDkE1RvfZrneScBhjP9xryTsv7lKqwqMzEl6Fepe8cM';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function checkProfiles() {
  const { data, error } = await supabase.from('profiles').select('*');
  console.log('Profiles data:', data, 'error:', error);
}

checkProfiles();
