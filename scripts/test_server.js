const http = require('http');

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
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('--- Testing Endpoints ---');

  // Test 1: Health
  const health = await testEndpoint('/health');
  console.log('1. /health:', health.status, health.data);

  // Test 2: Order Summary
  const summary = await testEndpoint('/app/payment/order/summary');
  console.log('2. /app/payment/order/summary:', summary.status, summary.data.code, 'balance:', summary.data.data?.balance);

  // Test 3: HangSales List
  const hangSales = await testEndpoint('/app/payment/order');
  console.log('3. /app/payment/order (hangSales):', hangSales.status, 'records count:', hangSales.data.data?.records?.length);

  // Test 4: Wallets List
  const wallets = await testEndpoint('/app/ct/app/collection/getWalletList', 'POST');
  console.log('4. /app/ct/app/collection/getWalletList:', wallets.status, 'wallets count:', wallets.data.data?.length);

  // Test 5: Team details
  const team = await testEndpoint('/app/user/team/details');
  console.log('5. /app/user/team/details:', team.status, team.data.data);

  // Test 6: Static HTML
  const index = await testEndpoint('/');
  console.log('6. / (index.html): status =', index.status);

  console.log('\nAll tests passed successfully!');
  process.exit(0);
}

// Start server in background then run tests
require('../server/index');
setTimeout(runTests, 1000);
