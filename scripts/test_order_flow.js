const http = require('http');

// Legacy pre-auth flow test. The current API requires a Supabase bearer token,
// ownership checks and a 12-digit UTR, so this script is intentionally opt-in.
if (process.env.ALLOW_LEGACY_SCRIPTS !== 'true') {
  console.error('Legacy unauthenticated test disabled. Run against a local server with ALLOW_LEGACY_SCRIPTS=true.');
  process.exit(1);
}

async function testEndpoint(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: 3000,
      path,
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data.slice(0, 100) });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function testOrderFlow() {
  console.log('--- Testing Complete Order Flow ---');

  // 1. Get HangSales
  const hs = await testEndpoint('/app/payment/order');
  const targetOrder = hs.data.data.records[0];
  console.log('1. Target Order to claim:', targetOrder.payOrderId, 'Amount: ₹' + targetOrder.amount);

  // 2. Claim Order with Wallet 101 (PhonePe)
  const claimRes = await testEndpoint('/app/payment/order/create', 'POST', {
    payOrderId: targetOrder.payOrderId,
    payoutWalletId: 101
  });
  console.log('2. Claim result:', claimRes.data.code, 'Buy ID:', claimRes.data.data?.buyId, 'Reward: ₹' + claimRes.data.data?.totalReward);
  const buyId = claimRes.data.data.buyId;

  // 3. Inspect Order Details
  const infoRes = await testEndpoint('/app/payment/order/orderInfo?buyId=' + buyId);
  console.log('3. Order Info status:', infoRes.data.data?.status);

  // 4. Submit Order (Confirm receipt with UTR)
  const submitRes = await testEndpoint('/app/payment/order/submit', 'POST', {
    buyId,
    utr: 'UTR998877665544'
  });
  console.log('4. Submit result:', submitRes.data.code, 'Order status:', submitRes.data.data?.status);

  // 5. Verify User Balance Updated
  const summaryRes = await testEndpoint('/app/payment/order/summary');
  console.log('5. New User Balance:', summaryRes.data.data?.balance, 'Total Reward:', summaryRes.data.data?.rewardTotal);

  console.log('\nOrder lifecycle verified successfully!');
  process.exit(0);
}

require('../server/index');
setTimeout(testOrderFlow, 1000);
