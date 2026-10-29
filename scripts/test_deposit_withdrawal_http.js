const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { app, startServer } = require('../server/index');
const db = require('../server/engine/db');
const auth = require('../server/engine/auth');

test('HTTP API: Deposit & Withdrawal Endpoints End-to-End', async (t) => {
  const PORT = 3099;
  const server = await startServer(PORT);

  const testUserId = 'test_http_user_' + Date.now();
  const testToken = 'test_token_' + Date.now();

  const state = db.get();
  state.users[testUserId] = {
    id: testUserId,
    userId: testUserId,
    phone: '+919876500000',
    nickname: 'HttpTester',
    balance: 0.00,
    totalBalance: 0.00,
    totalDeposited: 0.00,
    totalWithdrawn: 0.00,
    pendingWithdrawal: 0.00,
    isPinSet: false
  };

  // Mock token in auth
  const originalAuth = auth.authenticateToken;
  auth.authenticateToken = async (tok) => {
    if (tok === testToken) return state.users[testUserId];
    return null;
  };

  const adminKey = process.env.ADMIN_KEY || 'dev780@$$';

  async function req(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: '127.0.0.1',
        port: PORT,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers
        }
      };
      const r = http.request(opts, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) });
          } catch (e) {
            resolve({ status: res.statusCode, raw: data });
          }
        });
      });
      r.on('error', reject);
      if (body) r.write(JSON.stringify(body));
      r.end();
    });
  }

  try {
    // 1. Create Deposit via HTTP
    const createRes = await req('POST', '/app/deposit/create', { amount: 2500 }, { Authorization: `Bearer ${testToken}` });
    assert.equal(createRes.status, 200);
    assert.equal(createRes.data.code, 1000);
    const depositId = createRes.data.data.id;
    assert.ok(depositId);
    assert.equal(createRes.data.data.amount, 2500);

    // 2. Submit UTR via HTTP
    const utr = '98' + Math.floor(1000000000 + Math.random() * 9000000000);
    const submitRes = await req('POST', '/app/deposit/submit', { depositId, utr }, { Authorization: `Bearer ${testToken}` });
    assert.equal(submitRes.status, 200);
    assert.equal(submitRes.data.data.status, 'verifying');

    // 3. Admin gets pending deposits
    const pendingDepRes = await req('GET', '/api/admin/deposits/pending', null, { 'x-admin-key': adminKey });
    assert.equal(pendingDepRes.status, 200);
    assert.ok(pendingDepRes.data.data.records.some(d => d.id === depositId));

    // 4. Admin verifies deposit
    const verifyDepRes = await req('POST', '/api/admin/deposit/verify', { depositId, action: 'confirm' }, { 'x-admin-key': adminKey });
    assert.equal(verifyDepRes.status, 200);
    assert.equal(verifyDepRes.data.data.status, 'completed');
    assert.equal(state.users[testUserId].balance, 2500);

    // 5. User requests withdrawal of 1500 via HTTP
    const wthReqRes = await req('POST', '/app/withdraw/request', {
      amount: 1500,
      payoutType: 'upi',
      payoutDetails: { upiId: 'test@ybl', accountName: 'Http Tester' }
    }, { Authorization: `Bearer ${testToken}` });
    assert.equal(wthReqRes.status, 200);
    assert.equal(wthReqRes.data.data.amount, 1500);
    assert.equal(state.users[testUserId].balance, 1000);
    assert.equal(state.users[testUserId].pendingWithdrawal, 1500);
    const withdrawalId = wthReqRes.data.data.id;

    // 6. Admin checks pending withdrawals
    const pendingWthRes = await req('GET', '/api/admin/withdrawals/pending', null, { 'x-admin-key': adminKey });
    assert.equal(pendingWthRes.status, 200);
    assert.ok(pendingWthRes.data.data.records.some(w => w.id === withdrawalId));

    // 7. Admin marks withdrawal paid
    const confirmWthRes = await req('POST', '/api/admin/withdraw/verify', {
      withdrawalId,
      action: 'confirm',
      txRef: 'IMPS99887766'
    }, { 'x-admin-key': adminKey });
    assert.equal(confirmWthRes.status, 200);
    assert.equal(confirmWthRes.data.data.status, 'completed');
    assert.equal(state.users[testUserId].pendingWithdrawal, 0);
    assert.equal(state.users[testUserId].totalWithdrawn, 1500);

    // 8. User requests withdrawal of 500, then admin rejects -> refunded
    const wthReq2 = await req('POST', '/app/withdraw/request', {
      amount: 500,
      payoutType: 'upi',
      payoutDetails: { upiId: 'invalid@upi' }
    }, { Authorization: `Bearer ${testToken}` });
    assert.equal(state.users[testUserId].balance, 500);

    const rejWthRes = await req('POST', '/api/admin/withdraw/verify', {
      withdrawalId: wthReq2.data.data.id,
      action: 'reject',
      rejectReason: 'Bank rejected UPI VPA'
    }, { 'x-admin-key': adminKey });
    assert.equal(rejWthRes.status, 200);
    assert.equal(state.users[testUserId].balance, 1000); // 500 refunded back to 1000!

    // 9. Unified transactions
    const txRes = await req('GET', '/app/user/transactions/all', null, { Authorization: `Bearer ${testToken}` });
    assert.equal(txRes.status, 200);
    assert.ok(txRes.data.data.length >= 3);
  } finally {
    auth.authenticateToken = originalAuth;
    delete state.users[testUserId];
    await new Promise(r => server.close(r));
    process.exit(0);
  }
});
