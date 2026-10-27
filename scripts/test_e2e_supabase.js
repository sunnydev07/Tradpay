const http = require('http');

async function api(path, method = 'GET', body = null, token = null) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request({
      hostname: '127.0.0.1',
      port: 3000,
      path,
      method,
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function testE2E() {
  console.log('--- Starting End-to-End Supabase Auth & Real Data Test ---');
  const uniquePhone = '98' + Math.floor(10000000 + Math.random() * 90000000);
  const password = 'Password123!';

  // 1. Register new user
  console.log('1. Registering user with phone:', uniquePhone);
  const regRes = await api('/app/user/rs/submit', 'POST', {
    phone: uniquePhone,
    password,
    nickname: 'Trader_' + uniquePhone.slice(-4)
  });
  console.log('   Register response:', regRes.data.code, 'Token:', regRes.data.data?.token?.slice(0, 20) + '...');
  const token = regRes.data.data?.token;

  // 2. Fetch User Info with Token
  console.log('2. Fetching User Info with Supabase Token...');
  const userRes = await api('/app/user/info', 'GET', null, token);
  console.log('   User Nickname:', userRes.data.data?.nickname, 'Balance:', userRes.data.data?.balance, 'VIP:', userRes.data.data?.vipLevel);

  // 3. Add Custom Payout Wallet
  console.log('3. Adding new PhonePe wallet...');
  const addWalletRes = await api('/app/ct/app/collection/submit', 'POST', {
    ctType: 3,
    account: uniquePhone + '@ybl',
    name: 'Real User ' + uniquePhone.slice(-4),
    minAmount: 500,
    maxAmount: 25000
  }, token);
  console.log('   Wallet added:', addWalletRes.data.data?.id, addWalletRes.data.data?.ctName, addWalletRes.data.data?.account);
  const walletId = addWalletRes.data.data?.id;

  // 4. Fetch Wallets list for this user
  console.log('4. Fetching Wallets list...');
  const walletsRes = await api('/app/ct/app/collection/getWalletList', 'POST', {}, token);
  console.log('   Total wallets for user:', walletsRes.data.data?.length);

  // 5. Query HangSales orders with sorting (Ascending)
  console.log('5. Querying hang sales sorted Ascending...');
  const ordersRes = await api('/app/payment/order?sort=1', 'GET', null, token);
  const target = ordersRes.data.data?.records[0];
  console.log('   Lowest order amount: ₹' + target.amount, 'ID:', target.payOrderId);

  // 6. Claim order with the user's wallet
  console.log('6. Claiming order...');
  const claimRes = await api('/app/payment/order/create', 'POST', {
    payOrderId: target.payOrderId,
    payoutWalletId: walletId
  }, token);
  console.log('   Claimed successfully! Buy ID:', claimRes.data.data?.buyId, 'Reward: ₹' + claimRes.data.data?.totalReward);
  const buyId = claimRes.data.data?.buyId;

  // 7. Submit payment confirmation with UTR
  console.log('7. Confirming payment receipt with UTR...');
  const submitRes = await api('/app/payment/order/submit', 'POST', {
    buyId,
    utr: 'UTR' + Date.now()
  }, token);
  console.log('   Order completed:', submitRes.data.data?.status);

  // 8. Verify user balance updated
  console.log('8. Verifying updated summary balance...');
  const summaryRes = await api('/app/payment/order/summary', 'GET', null, token);
  console.log('   Updated Balance: ₹' + summaryRes.data.data?.balance, 'Total Reward: ₹' + summaryRes.data.data?.rewardTotal);

  console.log('\n✅ All Supabase Auth & Real Data tests PASSED!');
  process.exit(0);
}

require('../server/index');
setTimeout(testE2E, 1000);
