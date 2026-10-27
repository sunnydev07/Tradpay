const assert = require('node:assert/strict');
const express = require('express');
const apiRouter = require('../server/routes/api');
const supabaseService = require('../server/engine/supabaseService');

async function runAuthFlowTests() {
  console.log('=======================================================');
  console.log('🧪 Running TradePay Supabase Authentication Flow Tests');
  console.log('=======================================================');

  const app = express();
  app.use(express.json());
  app.use('/', apiRouter);

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  async function api(path, method = 'GET', body = null, token = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  try {
    // 1. Phone number registration
    const phone = '98' + Math.floor(10000000 + Math.random() * 90000000);
    const password = 'Password123!';
    console.log(`1. Testing User Registration with 10-digit Phone: ${phone}`);
    const regRes = await api('/app/user/rs/submit', 'POST', {
      phone,
      password,
      nickname: 'Trader_' + phone.slice(-4),
      inviteCode: 'LP8899'
    });
    assert.equal(regRes.status, 200, 'Registration HTTP status should be 200');
    assert.equal(regRes.json?.code, 1000, 'API response code should be 1000');
    assert.ok(regRes.json?.data?.token, 'Registration should return a valid JWT token');
    const token = regRes.json.data.token;
    console.log('   ✅ Phone Registration Succeeded with Supabase Token');

    // 2. Authenticated user profile retrieval
    console.log('2. Fetching User Profile (/app/user/info)');
    const infoRes = await api('/app/user/info', 'GET', null, token);
    assert.equal(infoRes.status, 200);
    assert.equal(infoRes.json?.code, 1000);
    assert.equal(infoRes.json?.data?.nickname, 'Trader_' + phone.slice(-4));
    assert.equal(infoRes.json?.data?.balance, 0.00);
    console.log('   ✅ Profile fetched successfully with zero initial balance');

    // 3. Setting Security PIN
    console.log('3. Setting 6-Digit Payment Security PIN');
    const pinRes = await api('/app/user/info/updatePin', 'POST', { newPin: '654321' }, token);
    assert.equal(pinRes.status, 200);
    assert.equal(pinRes.json?.code, 1000);
    console.log('   ✅ Security PIN configured and scrypt-hashed');

    // 4. Adding payout wallet
    console.log('4. Adding Bound UPI Payout Wallet');
    const walletRes = await api('/app/ct/app/collection/submit', 'POST', {
      ctType: 3,
      account: `${phone}@ybl`,
      name: 'PhonePe Wallet',
      minAmount: 500,
      maxAmount: 25000
    }, token);
    assert.equal(walletRes.status, 200);
    assert.equal(walletRes.json?.code, 1000);
    assert.ok(walletRes.json?.data?.id);
    console.log('   ✅ Payout wallet created and bound to user');

    // 5. Login with standard 10-digit phone
    console.log(`5. Signing in with standard phone (${phone})`);
    const login10 = await api('/app/user/login/login', 'POST', {
      identifier: phone,
      password
    });
    assert.equal(login10.status, 200);
    assert.equal(login10.json?.code, 1000);
    assert.ok(login10.json?.data?.token);
    console.log('   ✅ Phone login succeeded');

    // 6. Login with country code format (+91)
    console.log(`6. Signing in with formatted phone (+91${phone})`);
    const login91 = await api('/app/user/login/login', 'POST', {
      identifier: `+91${phone}`,
      password
    });
    assert.equal(login91.status, 200);
    assert.equal(login91.json?.code, 1000);
    assert.ok(login91.json?.data?.token);
    console.log('   ✅ Formatted phone (+91) login resolved and succeeded');

    // 7. Username registration and login
    const username = 'trader_' + Math.floor(10000 + Math.random() * 90000);
    console.log(`7. Testing Username Registration & Sign-in: "${username}"`);
    const userReg = await api('/app/user/rs/submit', 'POST', {
      identifier: username,
      password,
      nickname: 'User ' + username
    });
    assert.equal(userReg.status, 200);
    const userLogin = await api('/app/user/login/login', 'POST', {
      identifier: username,
      password
    });
    assert.equal(userLogin.status, 200);
    assert.equal(userLogin.json?.code, 1000);
    console.log('   ✅ Username account created and authenticated');

    // 8. Wrong password returns clean 401 error message
    console.log('8. Testing Wrong Password Error Handling');
    const wrongPass = await api('/app/user/login/login', 'POST', {
      identifier: phone,
      password: 'IncorrectPassword999!'
    });
    assert.equal(wrongPass.status, 401);
    assert.ok(wrongPass.json?.msg?.includes('Invalid'));
    console.log(`   ✅ Incorrect credentials safely rejected: "${wrongPass.json?.msg}"`);

    // 9. Duplicate registration handling
    console.log('9. Testing Duplicate Account Registration');
    const dupReg = await api('/app/user/rs/submit', 'POST', {
      phone,
      password
    });
    assert.equal(dupReg.status, 400);
    assert.ok(dupReg.json?.msg?.includes('already exists') || dupReg.json?.msg?.includes('registered'));
    console.log(`   ✅ Duplicate registration rejected: "${dupReg.json?.msg}"`);

    console.log('=======================================================');
    console.log('🎉 ALL 9 AUTHENTICATION TESTS PASSED PERFECTLY!');
    console.log('=======================================================');
  } finally {
    server.close();
  }
}

runAuthFlowTests().catch(err => {
  console.error('❌ Auth test suite failed:', err);
  process.exit(1);
});
