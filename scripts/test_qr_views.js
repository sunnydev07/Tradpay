const http = require('http');

function request(path, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: 3000,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, raw: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runTestSuite() {
  console.log('====================================================');
  console.log('TradePay QR Code & Payment Flow Verification Suite');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  try {
    // 1. Official QRs endpoint & Amount Customization
    console.log('Test 1: GET /app/payment/official-qrs (Default & Dynamic Amount)');
    const qrsRes = await request('/app/payment/official-qrs');
    assert(qrsRes.status === 200, 'Official QRs endpoint responds with 200');
    assert(Array.isArray(qrsRes.data?.data) && qrsRes.data.data.length >= 2, 'Returns at least 2 official QR accounts');
    const qr1 = qrsRes.data.data[0];
    assert(qr1.name && qr1.vpa && qr1.qrImage, 'Official QR has name, VPA, and qrImage screenshot');
    assert(qr1.upiUri && qr1.upiUri.startsWith('upi://pay?'), 'Official QR includes standard upiUri');
    assert(qr1.qrDataUrl && qr1.qrDataUrl.startsWith('data:image/png;base64,'), 'Official QR includes pre-generated PNG QR data URL');

    const dynamicQrRes = await request('/app/payment/official-qrs?amount=2500.50&note=DepositTest');
    const dynamicQr1 = dynamicQrRes.data.data[0];
    assert(dynamicQr1.upiUri.includes('&am=2500.50'), 'Dynamic amount 2500.50 encoded in UPI URI');
    assert(dynamicQr1.upiUri.includes('&tn=DepositTest'), 'Custom transaction note encoded in UPI URI');
    assert(dynamicQr1.qrDataUrl.startsWith('data:image/png;base64,'), 'Dynamic amount generates valid QR data URL');

    // 2. Direct QR Streaming / Image Endpoint
    console.log('\nTest 2: GET /api/qr/image (SVG Image Streaming & Error Handling)');
    const testUri = 'upi://pay?pa=6377276074-2@ybl&am=1500.00&cu=INR';
    const svgRes = await request(`/api/qr/image?text=${encodeURIComponent(testUri)}&size=200`);
    assert(svgRes.status === 200, 'QR image endpoint responds with 200');
    assert(svgRes.headers['content-type']?.includes('image/svg+xml'), 'Content-Type contains image/svg+xml');
    assert(svgRes.raw.includes('<svg') && svgRes.raw.includes('</svg>'), 'Streams valid SVG payload');

    const errRes = await request('/api/qr/image');
    assert(errRes.status === 400, 'Missing parameter returns 400 Bad Request');

    // 3. Static QR Screenshot Images
    console.log('\nTest 3: Static QR Screenshot Files Integrity');
    const scr1 = await request('/static/qr/scr1.jpeg');
    assert(scr1.status === 200, '/static/qr/scr1.jpeg is served successfully');
    const scr2 = await request('/static/qr/scr2.jpeg');
    assert(scr2.status === 200, '/static/qr/scr2.jpeg is served successfully');

    // 4. Order Claim Flow & Amount-Specific QR Attachment
    console.log('\nTest 4: Order Creation & Claim Flow (POST /app/payment/order/create)');
    // Spawn a test order first
    const spawnRes = await request('/api/sim/spawn-order', 'POST');
    const sampleOrder = spawnRes.data.data;
    assert(sampleOrder && sampleOrder.payOrderId, `Sample order spawned with amount ₹${sampleOrder.amount}`);

    // Claim the order with system/official wallet
    const claimRes = await request('/app/payment/order/create', 'POST', {
      payOrderId: sampleOrder.payOrderId,
      payoutWalletId: 1
    });
    assert(claimRes.status === 200 && claimRes.data.code === 1000, 'Order claimed successfully');
    const claimedOrder = claimRes.data.data;
    assert(claimedOrder.buyId, `Claimed order assigned buyId: ${claimedOrder.buyId}`);
    assert(claimedOrder.qrDataUrl && claimedOrder.qrDataUrl.startsWith('data:image/png;base64,'), 'Claimed order includes crisp PNG QR code');
    assert(claimedOrder.upiUri && claimedOrder.upiUri.includes(`&am=${claimedOrder.amount.toFixed(2)}`), `UPI URI corresponds to exact order amount: &am=${claimedOrder.amount.toFixed(2)}`);
    assert(claimedOrder.upiUri.includes(encodeURIComponent(claimedOrder.orderNo)), 'UPI URI corresponds to exact order number in transaction note');
    assert(claimedOrder.payeeVpa, `Payee VPA attached: ${claimedOrder.payeeVpa}`);
    assert(!claimedOrder.payeeName && !claimedOrder.payeeChannel, 'No payee name/channel details attached to order');

    // 5. Order Info Fetch (GET /app/payment/order/orderInfo)
    console.log('\nTest 5: Order Details Retrieval (GET /app/payment/order/orderInfo)');
    const infoRes = await request(`/app/payment/order/orderInfo?buyId=${claimedOrder.buyId}`);
    assert(infoRes.status === 200 && infoRes.data.code === 1000, 'Order details endpoint responds with 200');
    const fetchedOrder = infoRes.data.data;
    assert(fetchedOrder.qrDataUrl && fetchedOrder.upiUri, 'Fetched order preserves QR code and UPI URI');
    assert(fetchedOrder.expireSeconds > 0, 'Countdown timer is active');

    // 6. Wallets List with QR Codes (POST /app/ct/app/collection/getWalletList)
    console.log('\nTest 6: Wallet Accounts & Bound QRs (POST /app/ct/app/collection/getWalletList)');
    const walletsRes = await request('/app/ct/app/collection/getWalletList', 'POST');
    assert(walletsRes.status === 200 && Array.isArray(walletsRes.data.data), 'Wallet list endpoint responds with 200');
    const allWalletsHaveQr = walletsRes.data.data.every(w => w.qrDataUrl && w.upiUri);
    assert(allWalletsHaveQr, 'Every wallet in user wallet list has attached qrDataUrl and upiUri');

    // 7. USDT Crypto Deposit Gateway (GET /app/payment/order/usdtInfo & POST createUsdt)
    console.log('\nTest 7: USDT Crypto Deposit Gateways (GET usdtInfo & POST createUsdt)');
    const usdtInfoRes = await request('/app/payment/order/usdtInfo');
    assert(usdtInfoRes.status === 200 && usdtInfoRes.data.data?.chains?.length === 3, 'USDT info returns supported chains [TRC20, BSC, Polygon]');
    const trc20 = usdtInfoRes.data.data.details?.TRC20;
    assert(trc20 && trc20.qrDataUrl && trc20.address, 'TRC20 gateway has address and QR code data URL');

    const createUsdtRes = await request('/app/payment/order/createUsdt', 'POST', {
      amount: 50,
      chainType: 'BSC'
    });
    assert(createUsdtRes.status === 200, 'USDT order creation responds with 200');
    assert(createUsdtRes.data.data.qrDataUrl && createUsdtRes.data.data.chainType === 'BSC', 'BSC USDT deposit order contains QR data URL');

    // 8. Order Submission / Completion requires UTR (Payment not marked completed merely on QR display)
    console.log('\nTest 8: Payment Verification & Non-automatic Completion Verification');
    const checkUncompleted = await request(`/app/payment/order/orderInfo?buyId=${claimedOrder.buyId}`);
    assert(checkUncompleted.data.data.status === 'pending', 'Order status remains pending after QR display');

    // Submitting with invalid UTR
    const badSubmit = await request('/app/payment/deposit/submit', 'POST', {
      amount: 1000,
      qrId: 1,
      utr: '123'
    });
    assert(badSubmit.data.code === 400, 'Deposit rejected when UTR is invalid (< 6 digits)');

    console.log('\n====================================================');
    console.log(`Results: ${passed} PASSED, ${failed} FAILED`);
    console.log('====================================================\n');

    if (failed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (err) {
    console.error('Test suite exception:', err);
    process.exit(1);
  }
}

// Start server and run tests
require('../server/index');
setTimeout(runTestSuite, 1000);
