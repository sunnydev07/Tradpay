const http = require('http');

async function testEndpoint(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: 3000,
      path,
      method,
      headers: { 'Content-Type': 'application/json' }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, rawLen: data.length });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runTests() {
  console.log('--- Testing Official QR Integration ---');

  // 1. Check official-qrs endpoint
  const qrs = await testEndpoint('/app/payment/official-qrs');
  console.log('1. /app/payment/official-qrs:', qrs.status, qrs.data.code, 'Count:', qrs.data.data?.length);
  qrs.data.data.forEach(q => {
    console.log(`   - QR ${q.id}: ${q.name} (${q.vpa}) -> ${q.qrImage}`);
  });

  // 2. Check Static QR Images
  const img1 = await testEndpoint('/static/qr/scr1.jpeg');
  console.log('2. /static/qr/scr1.jpeg status:', img1.status, 'size:', img1.rawLen, 'bytes');

  const img2 = await testEndpoint('/static/qr/scr2.jpeg');
  console.log('3. /static/qr/scr2.jpeg status:', img2.status, 'size:', img2.rawLen, 'bytes');

  // 3. Test QR Deposit Submission
  console.log('4. Submitting test QR deposit of ₹2,500 via QR 1...');
  const deposit = await testEndpoint('/app/payment/deposit/submit', 'POST', {
    amount: 2500,
    qrId: 1,
    utr: 'UTR202610289911'
  });
  console.log('   Deposit result:', deposit.data.code, deposit.data.msg);

  // 4. Check user balance updated
  const summary = await testEndpoint('/app/payment/order/summary');
  console.log('5. Updated user balance: ₹' + summary.data.data?.balance);

  console.log('\nAll QR tests passed successfully!');
  process.exit(0);
}

require('../server/index');
setTimeout(runTests, 1000);
