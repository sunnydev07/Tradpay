const test = require('node:test');
const assert = require('node:assert/strict');
const orderEngine = require('../server/engine/orderEngine');
const db = require('../server/engine/db');

test('transaction history records all states: pending, verifying, completed, rejected', async () => {
  const state = db.get();
  const testUserId = 'test_history_user_' + Date.now();
  state.users[testUserId] = {
    id: testUserId,
    nickname: 'HistoryTester',
    phone: '9999999999',
    balance: 0,
    claimedOrders: []
  };

  // Add dummy hang sales to claim
  state.hangSales.push(
    { payOrderId: 'sale_hist_1', orderNo: 'ORD_HIST_1', amount: 500, reward: 100, rewardRate: 20, status: 'pending' },
    { payOrderId: 'sale_hist_2', orderNo: 'ORD_HIST_2', amount: 1000, reward: 200, rewardRate: 20, status: 'pending' }
  );

  const wallet = { id: 9991, ctType: 3, ctName: 'Test UPI', account: 'test@upi', minAmount: 100, maxAmount: 50000, status: 1, userId: testUserId };
  state.wallets.push(wallet);
  db.save();

  // 1. Claim Order 1
  const claimed1 = await orderEngine.claimOrder({
    payOrderId: 'sale_hist_1',
    payoutWalletId: wallet.id,
    userId: testUserId
  });
  assert.equal(claimed1.status, 'pending');

  let history = orderEngine.getUserOrdersHistory({ userId: testUserId, filter: 'all' });
  assert.equal(history.total, 1);
  assert.equal(history.records[0].buyId, claimed1.buyId);
  assert.equal(history.records[0].status, 'pending');
  assert.equal(history.summary.pendingCount, 1);

  // 2. Submit UTR for Order 1 -> 'verifying'
  await orderEngine.submitOrder({
    buyId: claimed1.buyId,
    userId: testUserId,
    utr: '987654321001'
  });

  history = orderEngine.getUserOrdersHistory({ userId: testUserId, filter: 'all' });
  assert.equal(history.records[0].status, 'verifying');
  assert.equal(history.records[0].utr, '987654321001');
  assert.equal(history.summary.verifyingCount, 1);

  // 3. Admin rejects Order 1 with reason
  await orderEngine.verifyOrder({
    buyId: claimed1.buyId,
    adminId: 'admin',
    action: 'reject',
    reason: 'Bank UTR not found on statement'
  });

  history = orderEngine.getUserOrdersHistory({ userId: testUserId, filter: 'all' });
  assert.equal(history.total, 1);
  assert.equal(history.records[0].status, 'rejected');
  assert.equal(history.records[0].rejectReason, 'Bank UTR not found on statement');
  assert.equal(history.records[0].utr, '987654321001');
  assert.equal(history.summary.rejectedCount, 1);
  assert.equal(history.summary.completedCount, 0);

  // 4. Claim Order 2, submit, and confirm -> 'completed'
  const claimed2 = await orderEngine.claimOrder({
    payOrderId: 'sale_hist_2',
    payoutWalletId: wallet.id,
    userId: testUserId
  });
  await orderEngine.submitOrder({
    buyId: claimed2.buyId,
    userId: testUserId,
    utr: '987654321002'
  });
  await orderEngine.verifyOrder({
    buyId: claimed2.buyId,
    adminId: 'admin',
    action: 'confirm'
  });

  // Verify all history for user
  history = orderEngine.getUserOrdersHistory({ userId: testUserId, filter: 'all' });
  assert.equal(history.total, 2);
  assert.equal(history.summary.totalCount, 2);
  assert.equal(history.summary.completedCount, 1);
  assert.equal(history.summary.rejectedCount, 1);
  assert.equal(history.summary.totalCredited, 200);
  assert.equal(history.summary.totalVolume, 1000);

  // Test filter: completed only
  const completedOnly = orderEngine.getUserOrdersHistory({ userId: testUserId, filter: 'completed' });
  assert.equal(completedOnly.total, 1);
  assert.equal(completedOnly.records[0].buyId, claimed2.buyId);
  assert.equal(completedOnly.records[0].status, 'completed');

  // Test filter: rejected only
  const rejectedOnly = orderEngine.getUserOrdersHistory({ userId: testUserId, filter: 'rejected' });
  assert.equal(rejectedOnly.total, 1);
  assert.equal(rejectedOnly.records[0].buyId, claimed1.buyId);
  assert.equal(rejectedOnly.records[0].status, 'rejected');
  assert.equal(rejectedOnly.records[0].rejectReason, 'Bank UTR not found on statement');
});
