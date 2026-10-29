const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { app, startServer } = require('../server/index');
const db = require('../server/engine/db');
const auth = require('../server/engine/auth');

function request(port, method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const reqHeaders = { 'Content-Type': 'application/json', ...headers };
    let postData = '';
    if (body) {
      postData = JSON.stringify(body);
      reqHeaders['Content-Length'] = Buffer.byteLength(postData);
    }
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: reqHeaders
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
    if (postData) req.write(postData);
    req.end();
  });
}

test('Direct QR Deposit & Review Flow: instant QR, request-review, amount > 500k, optional UTR, owner confirmation', async () => {
  const PORT = 3097;
  const server = await startServer(PORT);

  try {
    const state = db.get();
    const testUserId = 'test_qr_user_' + Date.now();
    state.users[testUserId] = {
      id: testUserId,
      userId: testUserId,
      phone: '+919876543210',
      nickname: 'DirectQRTrader',
      balance: 100.00,
      totalBalance: 100.00,
      totalDeposited: 0.00,
      totalWithdrawn: 0.00,
      pendingWithdrawal: 0.00,
      isAdmin: false
    };

    // Create admin user for verification
    const adminUserId = 'test_admin_owner_' + Date.now();
    state.users[adminUserId] = {
      id: adminUserId,
      userId: adminUserId,
      phone: '+919999999999',
      nickname: 'SuperAdminOwner',
      balance: 0,
      isAdmin: true,
      roles: ['admin', 'owner']
    };

    const userToken = auth.createToken(testUserId);
    const adminToken = auth.createToken(adminUserId);

    // 1. Test request-review with amount 509999 (as shown in user's screenshot) and empty UTR
    const reqReviewRes = await request(PORT, 'POST', '/app/deposit/request-review', {
      amount: 509999,
      utr: '' // Empty UTR -> should auto-generate 12-digit ref
    }, { Authorization: `Bearer ${userToken}` });

    assert.equal(reqReviewRes.status, 200, 'Should return HTTP 200');
    assert.equal(reqReviewRes.data.code, 1000, 'API response code should be 1000');
    const deposit1 = reqReviewRes.data.data;
    assert.equal(deposit1.amount, 509999, 'Amount should be 509999');
    assert.equal(deposit1.status, 'verifying', 'Status should immediately be verifying');
    assert.ok(deposit1.utr && deposit1.utr.length === 12, 'UTR should be 12 digits');
    assert.ok(deposit1.qrCodeDataUrl, 'QR code should be generated');

    // 2. Admin inspects pending deposits
    const pendingRes = await request(PORT, 'GET', '/api/admin/deposits/pending', null, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(pendingRes.status, 200);
    const pendingList = pendingRes.data.data.records;
    const foundDeposit = pendingList.find(d => d.id === deposit1.id);
    assert.ok(foundDeposit, 'Deposit should appear in Admin pending list');
    assert.equal(foundDeposit.amount, 509999);

    // 3. Admin confirms & verifies deposit
    const verifyRes = await request(PORT, 'POST', '/api/admin/deposit/verify', {
      depositId: deposit1.id,
      action: 'confirm'
    }, { Authorization: `Bearer ${adminToken}` });

    assert.equal(verifyRes.status, 200);
    assert.equal(verifyRes.data.data.status, 'completed');

    // 4. Verify balance is credited on user account
    const userSummaryRes = await request(PORT, 'GET', '/app/user/summary', null, {
      Authorization: `Bearer ${userToken}`
    });
    assert.equal(userSummaryRes.status, 200);
    assert.equal(userSummaryRes.data.data.balance, 100 + 509999);
    assert.equal(userSummaryRes.data.data.totalDeposited, 509999);

    // 5. Test another deposit with custom 12-digit UTR
    const customUtr = '987654123456';
    const reqReviewRes2 = await request(PORT, 'POST', '/app/deposit/request-review', {
      amount: 2500,
      utr: customUtr
    }, { Authorization: `Bearer ${userToken}` });

    assert.equal(reqReviewRes2.status, 200);
    const deposit2 = reqReviewRes2.data.data;
    assert.equal(deposit2.amount, 2500);
    assert.equal(deposit2.utr, customUtr);
    assert.equal(deposit2.status, 'verifying');

    // Admin confirms second deposit
    await request(PORT, 'POST', '/api/admin/deposit/verify', {
      depositId: deposit2.id,
      action: 'confirm'
    }, { Authorization: `Bearer ${adminToken}` });

    const finalSummaryRes = await request(PORT, 'GET', '/app/user/summary', null, {
      Authorization: `Bearer ${userToken}`
    });
    assert.equal(finalSummaryRes.data.data.balance, 100 + 509999 + 2500);
    assert.equal(finalSummaryRes.data.data.totalDeposited, 509999 + 2500);

    console.log('✅ Direct QR Deposit & Review Flow Test passed 100%!');
  } finally {
    await new Promise(r => server.close(r));
    process.exit(0);
  }
});
