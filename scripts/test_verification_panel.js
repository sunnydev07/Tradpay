const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tradepay-verif-'));
process.env.TRADEPAY_DB_FILE = path.join(tmpDir, 'db.json');
process.env.ALLOW_SIMULATION = 'false';
process.env.NODE_ENV = 'test';
process.env.ADMIN_USER_IDS = 'admin-user-1';
process.env.ADMIN_KEY = 'tradepay_admin';

const db = require('../server/engine/db');
const orderEngine = require('../server/engine/orderEngine');
const apiRouter = require('../server/routes/api');

test.after(() => {
  try { db.flush(); } catch (e) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
});

test('full UTR verification workflow: submit -> pending verifying -> admin confirmation -> balance credit', async () => {
  db.reset();
  const state = db.get();

  // Create test user
  const userId = 'trader-user-77';
  state.users[userId] = {
    id: userId,
    userId,
    phone: '9876543210',
    nickname: 'TestTrader',
    balance: 0.00,
    totalBalance: 0.00,
    rewardTotal: 0.00,
    wallets: [{ id: 101, userId, ctType: 3, ctName: 'PhonePe', account: 'trader@ybl', status: 1, minAmount: 100, maxAmount: 50000 }]
  };
  state.wallets = [...state.users[userId].wallets];

  // 1. Claim an order
  const claimed = await orderEngine.claimOrder({
    payOrderId: 'PO20261028001',
    payoutWalletId: 101,
    userId
  });
  assert.equal(claimed.status, 'pending');

  // 2. Trader submits 12-digit UTR
  const utr = '429810982312';
  const submitted = orderEngine.submitOrder({
    buyId: claimed.buyId,
    utr,
    userId
  });

  // Verify status is verifying and user balance is NOT credited immediately
  assert.equal(submitted.status, 'verifying');
  assert.equal(submitted.utr, utr);
  assert.equal(state.users[userId].balance, 0, 'Balance must remain 0 while pending verification');

  // 3. Admin checks pending verification queue
  const pendingList = orderEngine.getPendingVerifications();
  const inQueue = pendingList.find(o => o.buyId === claimed.buyId);
  assert.ok(inQueue, 'Order must be present in pending verification queue');
  assert.equal(inQueue.utr, utr);
  assert.equal(inQueue.userNickname, 'TestTrader');

  // 4. Admin confirms verification
  const confirmed = orderEngine.verifyOrder({
    buyId: claimed.buyId,
    adminId: 'admin-user-1',
    action: 'confirm'
  });
  assert.equal(confirmed.status, 'completed');
  assert.equal(confirmed.verifiedBy, 'admin-user-1');

  // Verify user balance is now credited
  const expectedReward = Number(claimed.totalReward);
  assert.ok(expectedReward > 0);
  assert.equal(state.users[userId].balance, expectedReward, 'User balance must be credited after admin confirmation');
  assert.equal(state.users[userId].rewardTotal, expectedReward);

  // Verify queue is now empty of this order
  const pendingAfter = orderEngine.getPendingVerifications();
  assert.equal(pendingAfter.some(o => o.buyId === claimed.buyId), false);
});

test('admin verification rejection: restores hangSale and records reject reason', async () => {
  db.reset();
  const state = db.get();

  const userId = 'trader-user-77';
  state.users[userId] = {
    id: userId,
    userId,
    phone: '9876543210',
    nickname: 'TestTrader',
    balance: 0.00,
    wallets: [{ id: 101, userId, ctType: 3, ctName: 'PhonePe', account: 'trader@ybl', status: 1, minAmount: 100, maxAmount: 50000 }]
  };
  state.wallets = [...state.users[userId].wallets];

  const claimed = await orderEngine.claimOrder({
    payOrderId: 'PO20261028001',
    payoutWalletId: 101,
    userId
  });

  orderEngine.submitOrder({
    buyId: claimed.buyId,
    utr: '999888777666',
    userId
  });

  // Admin rejects with reason
  const rejected = orderEngine.verifyOrder({
    buyId: claimed.buyId,
    adminId: 'admin-user-1',
    action: 'reject',
    reason: 'UTR not found in bank statement'
  });

  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.rejectReason, 'UTR not found in bank statement');
  assert.equal(state.users[userId].balance, 0, 'Balance must remain 0 on rejection');

  // Original hangSale is restored to pending
  const sale = state.hangSales.find(o => o.payOrderId === 'PO20261028001');
  assert.equal(sale.status, 'pending');
});

test('HTTP Admin Verification endpoints protect with admin key and execute verification', async () => {
  const app = express();
  app.use(express.json());
  app.use('/', apiRouter);

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Unauthorized request without admin key or token
    const unauth = await fetch(`${baseUrl}/api/admin/orders/pending`);
    assert.equal(unauth.status, 403);

    // 2. Authorized request with X-Admin-Key
    const authReq = await fetch(`${baseUrl}/api/admin/orders/pending`, {
      headers: { 'x-admin-key': 'tradepay_admin' }
    });
    assert.equal(authReq.status, 200);
    const json = await authReq.json();
    assert.equal(json.code, 1000);
    assert.ok(Array.isArray(json.data.records));

    // 3. Stats endpoint
    const statsRes = await fetch(`${baseUrl}/api/admin/stats`, {
      headers: { 'x-admin-key': 'tradepay_admin' }
    });
    assert.equal(statsRes.status, 200);
    const statsJson = await statsRes.json();
    assert.equal(statsJson.code, 1000);
    assert.equal(typeof statsJson.data.pendingCount, 'number');

    // 4. Verify Key endpoint
    const verifyKeyRes = await fetch(`${baseUrl}/api/admin/auth/verify-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'tradepay_admin' })
    });
    assert.equal(verifyKeyRes.status, 200);
    assert.equal((await verifyKeyRes.json()).code, 1000);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
