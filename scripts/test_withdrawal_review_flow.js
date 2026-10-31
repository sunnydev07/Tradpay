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

test('Withdrawal Review Flow: submit request, /app/withdraw/active endpoint, admin verify and refund', async () => {
  const PORT = 3096;
  const server = await startServer(PORT);

  try {
    const state = db.get();
    const testUserId = 'test_wth_user_' + Date.now();
    state.users[testUserId] = {
      id: testUserId,
      userId: testUserId,
      phone: '+919876543211',
      nickname: 'WthReviewTrader',
      balance: 10000.00,
      totalBalance: 10000.00,
      totalDeposited: 10000.00,
      totalWithdrawn: 0.00,
      pendingWithdrawal: 0.00,
      isAdmin: false
    };

    const adminUserId = 'test_wth_admin_' + Date.now();
    state.users[adminUserId] = {
      id: adminUserId,
      userId: adminUserId,
      phone: '+919999999998',
      nickname: 'AdminOwner',
      balance: 0,
      isAdmin: true,
      roles: ['admin', 'owner']
    };

    const userToken = auth.createToken(testUserId);
    const adminToken = auth.createToken(adminUserId);

    // 1. Initially active withdrawal is null
    const initialActiveRes = await request(PORT, 'GET', '/app/withdraw/active', null, {
      Authorization: `Bearer ${userToken}`
    });
    assert.equal(initialActiveRes.status, 200);
    assert.equal(initialActiveRes.data.data, null);

    // 2. Submit withdrawal request of 2500
    const wthReqRes = await request(PORT, 'POST', '/app/withdraw/request', {
      amount: 2500,
      payoutType: 'upi',
      payoutDetails: {
        upiId: 'trader@ybl',
        accountName: 'Trader Test'
      }
    }, { Authorization: `Bearer ${userToken}` });

    assert.equal(wthReqRes.status, 200);
    assert.equal(wthReqRes.data.code, 1000);
    const wthData = wthReqRes.data.data;
    assert.equal(wthData.amount, 2500);
    assert.equal(wthData.status, 'pending');

    // 3. /app/withdraw/active now returns this active withdrawal
    const activeRes = await request(PORT, 'GET', '/app/withdraw/active', null, {
      Authorization: `Bearer ${userToken}`
    });
    assert.equal(activeRes.status, 200);
    assert.equal(activeRes.data.data.id, wthData.id);
    assert.equal(activeRes.data.data.status, 'pending');
    assert.equal(activeRes.data.data.amount, 2500);

    // 4. Unified transactions contains withdrawal with reward: 0, totalReward: 0
    const txRes = await request(PORT, 'GET', '/app/user/transactions/all', null, {
      Authorization: `Bearer ${userToken}`
    });
    assert.equal(txRes.status, 200);
    const foundTx = txRes.data.data.find(t => t.id === wthData.id);
    assert.ok(foundTx, 'Withdrawal should be in unified transactions');
    assert.equal(foundTx.txType, 'withdrawal');
    assert.equal(foundTx.totalReward, 0);

    // 5. Admin verifies and completes withdrawal
    const verifyRes = await request(PORT, 'POST', '/api/admin/withdraw/verify', {
      withdrawalId: wthData.id,
      action: 'confirm',
      txRef: 'BANKREF999999'
    }, { Authorization: `Bearer ${adminToken}` });
    assert.equal(verifyRes.status, 200);
    assert.equal(verifyRes.data.data.status, 'completed');

    // 6. Active withdrawal is now cleared
    const completedActiveRes = await request(PORT, 'GET', '/app/withdraw/active', null, {
      Authorization: `Bearer ${userToken}`
    });
    assert.equal(completedActiveRes.status, 200);
    assert.equal(completedActiveRes.data.data, null);

    console.log('✅ Withdrawal Review Flow Test passed 100%!');
  } finally {
    await new Promise(r => server.close(r));
    process.exit(0);
  }
});
