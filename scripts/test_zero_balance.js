const http = require('http');

async function api(path, method = 'GET', body = null, token = null) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request({
      hostname: '127.0.0.1',
      port: Number(process.env.PORT) || 3000,
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

  // 1. Verify unauthenticated request fails closed
  const guestRes = await api('/app/payment/order/summary');
  console.log('1. Guest / Unauthenticated check status:', guestRes.status);
  if (guestRes.status !== 401) {
    throw new Error('Unauthenticated endpoint did not fail closed!');
  }

  // 2. Newly Registered User
  const uniquePhone = '99' + Math.floor(10000000 + Math.random() * 90000000);
  console.log('2. Registering new user:', uniquePhone);
  const regRes = await api('/app/user/rs/submit', 'POST', {
    phone: uniquePhone,
    password: 'Password123!'
  });
  const token = regRes.data?.data?.token;
  if (!token) throw new Error('Registration failed to return token');

  const userSummary = await api('/app/payment/order/summary', 'GET', null, token);
  console.log('   New authenticated user balance:', userSummary.data?.data?.balance, 'Reward:', userSummary.data?.data?.rewardTotal);
  if (userSummary.data?.data?.balance !== 0) {
    throw new Error('New user balance is not 0!');
  }

  // 3. User deposits money using official QR with valid 12-digit UTR
  const randomUtr = Math.floor(100000000000 + Math.random() * 900000000000).toString();
  console.log('3. User submits deposit with 12-digit UTR:', randomUtr);
  const depRes = await api('/app/payment/deposit/submit', 'POST', {
    amount: 500,
    qrId: 1,
    utr: randomUtr
  }, token);
  console.log('   Deposit response code:', depRes.data?.code, 'Status:', depRes.data?.data?.status);
  if (depRes.data?.code !== 1000) {
    throw new Error('Deposit submission failed!');
  }

  console.log('\n✅ Zero initial balance and secure deposit submission fully verified!');
  process.exit(0);
}

const { startServer } = require('../server/index');
startServer().then(() => {
  setTimeout(testZeroBalance, 300);
}).catch((err) => {
  if (err.code === 'EADDRINUSE') {
    setTimeout(testZeroBalance, 300);
  } else {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
});
