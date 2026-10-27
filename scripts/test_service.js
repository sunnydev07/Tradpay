const supabaseService = require('../server/engine/supabaseService');

async function testService() {
  console.log('Testing Supabase Service...');
  const testPhone = '98765' + Math.floor(10000 + Math.random() * 90000);
  const password = 'Password123!';

  // 1. Sign up
  console.log('1. Signing up user:', testPhone);
  const reg = await supabaseService.signUpUser({
    identifier: testPhone,
    phone: '+91' + testPhone,
    password,
    nickname: 'Pro Trader ' + testPhone.slice(-4)
  });
  console.log('Signed up user:', reg.user.id, 'Nickname:', reg.user.nickname, 'Wallets:', reg.user.wallets?.length);

  // 2. Sign in
  console.log('2. Signing in user...');
  const login = await supabaseService.signInUser({
    identifier: testPhone,
    password
  });
  console.log('Login successful! Balance: ₹' + login.user.balance, 'Invite Code:', login.user.inviteCode);

  // 3. Verify Token
  console.log('3. Verifying token...');
  const verified = await supabaseService.verifyToken(login.token);
  console.log('Token verified for UID:', verified.id, 'Email:', verified.email);

  console.log('\nAll Supabase service tests passed!');
  process.exit(0);
}

testService().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
