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

async function testZeroBalance() {
  console.log('--- Verifying Real Zero Initial Balance ---');

  // 1. Default Guest / Initial Load
  const guestRes = await api('/app/payment/order/summary');
  console.log('1. Guest / Initial balance:', guestRes.data.data?.balance, 'Reward:', guestRes.data.data?.rewardTotal);
  if (guestRes.data.data?.balance !== 0) {
    throw new Error('Initial guest balance is not 0!');
  }

  // 2. Newly Registered User
  const uniquePhone = '99' + Math.floor(10000000 + Math.random() * 90000000);
  console.log('2. Registering new user:', uniquePhone);
  const regRes = await api('/app/user/rs/submit', 'POST', {
    phone: uniquePhone,
    password: 'Password123!'
  });
  const token = regRes.data.data?.token;

  const userSummary = await api('/app/payment/order/summary', 'GET', null, token);
  console.log('   New authenticated user balance:', userSummary.data.data?.balance, 'Reward:', userSummary.data.data?.rewardTotal);
  if (userSummary.data.data?.balance !== 0) {
    throw new Error('New user balance is not 0!');
  }

  // 3. User deposits money using official QR
  console.log('3. User scans Akshat Jain QR and deposits ₹500...');
  const depRes = await api('/app/payment/deposit/submit', 'POST', {
    amount: 500,
    qrId: 1,
    utr: 'UTR' + Date.now()
  }, token);
  console.log('   Deposit credited:', depRes.data.msg);

  // 4. Verify balance is now ₹500
  const afterDeposit = await api('/app/payment/order/summary', 'GET', null, token);
  console.log('4. User balance after deposit: ₹' + afterDeposit.data.data?.balance);
  if (afterDeposit.data.data?.balance !== 500) {
    throw new Error('Balance was not updated correctly after deposit!');
  }

  console.log('\n✅ Zero initial balance and deposit crediting fully verified!');
  process.exit(0);
}

require('../server/index');
setTimeout(testZeroBalance, 1000);
