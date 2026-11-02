const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tradepay-admin-ctrl-'));
process.env.TRADEPAY_DB_FILE = path.join(tmpDir, 'db.json');
process.env.ALLOW_SIMULATION = 'false';
process.env.NODE_ENV = 'test';
process.env.ADMIN_USER_IDS = 'admin-user-99';
process.env.ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef';

const db = require('../server/engine/db');
const paymentEngine = require('../server/engine/paymentEngine');
const ledger = require('../server/engine/ledger');
const adminAuth = require('../server/engine/adminAuth');
const apiRouter = require('../server/routes/api');

test.after(() => {
  try { db.flush(); } catch (e) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
});

test('admin can view users, manipulate user balances, and details', () => {
  db.reset();
  const state = db.get();

  const userId = 'trader-balance-test-1';
  state.users[userId] = {
    id: userId,
    userId,
    phone: '9988776655',
    nickname: 'BalanceTrader',
    balance: 100.00,
    totalBalance: 100.00,
    pendingWithdrawal: 0.00,
    rewardTotal: 0.00,
    totalDeposited: 100.00,
    totalWithdrawn: 0.00
  };

  // 1. Get all users
  const users = paymentEngine.getAllUsersForAdmin();
  const found = users.find(u => u.id === userId);
  assert.ok(found, 'User should be found in admin users list');
  assert.equal(found.balance, 100);

  // 2. Credit balance
  const creditRes = paymentEngine.adjustUserBalance({
    userId,
    action: 'credit',
    amount: 500,
    reason: 'VIP welcome gift'
  });
  assert.equal(creditRes.newBalance, 600);
  assert.equal(state.users[userId].balance, 600);

  // 3. Debit balance
  const debitRes = paymentEngine.adjustUserBalance({
    userId,
    action: 'debit',
    amount: 150,
    reason: 'Correction penalty'
  });
  assert.equal(debitRes.newBalance, 450);
  assert.equal(state.users[userId].balance, 450);

  // 4. Set balance directly
  const setRes = paymentEngine.adjustUserBalance({
    userId,
    action: 'set',
    amount: 2500,
    reason: 'Set exact balance override'
  });
  assert.equal(setRes.newBalance, 2500);
  assert.equal(state.users[userId].balance, 2500);
  assert.equal(state.users[userId].totalBalance, 2500);

  // 5. Update user details
  const updatedUser = paymentEngine.updateUserDetails({
    userId,
    updates: {
      nickname: 'SuperTrader',
      vipLevel: 3,
      points: 888
    }
  });
  assert.equal(updatedUser.nickname, 'SuperTrader');
  assert.equal(updatedUser.vipLevel, 3);
  assert.equal(updatedUser.points, 888);

  // 6. Ledger reconciliation matches
  const rec = ledger.reconcileUser(state, userId);
  assert.equal(rec.matches, true, 'Ledger should reconcile after balance manipulations');
});

test('admin can control withdrawal amount (change amount on pending request) and settle updated amount', () => {
  db.reset();
  const state = db.get();

  const userId = 'trader-wth-test-2';
  state.users[userId] = {
    id: userId,
    userId,
    phone: '9911223344',
    nickname: 'WthTrader',
    balance: 5000.00,
    totalBalance: 5000.00,
    pendingWithdrawal: 0.00,
    totalDeposited: 5000.00,
    totalWithdrawn: 0.00
  };

  // 1. Trader requests withdrawal of ₹3,000
  const wth = paymentEngine.requestWithdrawal({
    userId,
    amount: 3000,
    payoutType: 'upi',
    payoutDetails: { upiId: 'wthtrader@upi' }
  });
  assert.equal(wth.status, 'pending');
  assert.equal(wth.amount, 3000);
  assert.equal(state.users[userId].balance, 2000);
  assert.equal(state.users[userId].pendingWithdrawal, 3000);

  // 2. Admin changes withdrawal amount from ₹3,000 to ₹2,000 (reduction)
  const modified1 = paymentEngine.editWithdrawalAmount({
    withdrawalId: wth.id,
    newAmount: 2000,
    adminId: 'admin-user-99',
    reason: 'Daily max payout limit is ₹2,000'
  });
  assert.equal(modified1.amount, 2000);
  assert.equal(modified1.originalAmount, 3000);
  // User balance must have ₹1,000 refunded back to available balance!
  assert.equal(state.users[userId].balance, 3000, 'Difference ₹1,000 should be refunded to balance');
  assert.equal(state.users[userId].pendingWithdrawal, 2000);

  // 3. Admin changes withdrawal amount from ₹2,000 to ₹2,500 (increase)
  const modified2 = paymentEngine.editWithdrawalAmount({
    withdrawalId: wth.id,
    newAmount: 2500,
    adminId: 'admin-user-99',
    reason: 'Adjusted up to ₹2,500'
  });
  assert.equal(modified2.amount, 2500);
  assert.equal(state.users[userId].balance, 2500);
  assert.equal(state.users[userId].pendingWithdrawal, 2500);

  // 4. Admin confirms payment sent with the new amount of ₹2,500
  const confirmed = paymentEngine.verifyWithdrawal({
    withdrawalId: wth.id,
    adminId: 'admin-user-99',
    action: 'confirm',
    txRef: 'IMPS99887766'
  });
  assert.equal(confirmed.status, 'completed');
  assert.equal(confirmed.amount, 2500);
  assert.equal(state.users[userId].pendingWithdrawal, 0);
  assert.equal(state.users[userId].totalWithdrawn, 2500);
  assert.equal(state.users[userId].balance, 2500);

  // 5. Ledger reconciliation matches
  const rec = ledger.reconcileUser(state, userId);
  assert.equal(rec.matches, true, 'Ledger should reconcile after withdrawal edits and settlement');
});

test('admin can delete transactions (orders, deposits, withdrawals)', () => {
  db.reset();
  const state = db.get();

  const userId = 'trader-del-test-3';
  state.users[userId] = {
    id: userId,
    userId,
    phone: '9900112233',
    nickname: 'DelTrader',
    balance: 1000.00,
    totalBalance: 1000.00,
    pendingWithdrawal: 0.00
  };

  // 1. Add sample deposit, order, and withdrawal
  state.deposits['DEP_TEST_1'] = {
    id: 'DEP_TEST_1',
    depositId: 'DEP_TEST_1',
    userId,
    amount: 500,
    status: 'completed',
    createdAt: new Date().toISOString()
  };

  state.claimedOrders['ORD_TEST_1'] = {
    buyId: 'ORD_TEST_1',
    orderNo: 'ORD_TEST_1',
    userId,
    amount: 1500,
    status: 'completed',
    createdAt: new Date().toISOString()
  };

  state.withdrawals['WTH_TEST_1'] = {
    id: 'WTH_TEST_1',
    withdrawalId: 'WTH_TEST_1',
    userId,
    amount: 200,
    status: 'completed',
    createdAt: new Date().toISOString()
  };

  // Check all exist
  const allBefore = paymentEngine.getAllUnifiedTransactionsForAdmin();
  assert.ok(allBefore.some(t => t.id === 'DEP_TEST_1'));
  assert.ok(allBefore.some(t => t.id === 'ORD_TEST_1'));
  assert.ok(allBefore.some(t => t.id === 'WTH_TEST_1'));

  // Delete deposit
  paymentEngine.deleteTransaction({ type: 'deposit', id: 'DEP_TEST_1' });
  assert.equal(state.deposits['DEP_TEST_1'], undefined);

  // Delete order
  paymentEngine.deleteTransaction({ type: 'order', id: 'ORD_TEST_1' });
  assert.equal(state.claimedOrders['ORD_TEST_1'], undefined);

  // Delete withdrawal
  paymentEngine.deleteTransaction({ type: 'withdrawal', id: 'WTH_TEST_1' });
  assert.equal(state.withdrawals['WTH_TEST_1'], undefined);

  // Check all are gone
  const allAfter = paymentEngine.getAllUnifiedTransactionsForAdmin();
  assert.equal(allAfter.some(t => t.id === 'DEP_TEST_1'), false);
  assert.equal(allAfter.some(t => t.id === 'ORD_TEST_1'), false);
  assert.equal(allAfter.some(t => t.id === 'WTH_TEST_1'), false);
});

test('HTTP admin routes for users, balance, withdrawal edit and transaction delete', async () => {
  db.reset();
  const state = db.get();

  const userId = 'trader-http-test-4';
  state.users[userId] = {
    id: userId,
    userId,
    phone: '9888777666',
    nickname: 'HttpTrader',
    balance: 1000.00,
    totalBalance: 1000.00,
    pendingWithdrawal: 0.00
  };

  const app = express();
  app.use(express.json());
  app.use('/', apiRouter);

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminHeaders = {
    'Content-Type': 'application/json',
    'x-admin-key': process.env.ADMIN_KEY
  };

  try {
    // 1. GET /api/admin/users
    const usersRes = await fetch(`${baseUrl}/api/admin/users`, { headers: adminHeaders });
    assert.equal(usersRes.status, 200);
    const usersJson = await usersRes.json();
    assert.equal(usersJson.code, 1000);
    assert.ok(usersJson.data.records.some(u => u.id === userId));

    // 2. GET /api/admin/user/:userId
    const userDetailRes = await fetch(`${baseUrl}/api/admin/user/${userId}`, { headers: adminHeaders });
    assert.equal(userDetailRes.status, 200);
    const userDetailJson = await userDetailRes.json();
    assert.equal(userDetailJson.code, 1000);
    assert.equal(userDetailJson.data.user.nickname, 'HttpTrader');

    // 3. POST /api/admin/user/balance - Credit
    const balRes = await fetch(`${baseUrl}/api/admin/user/balance`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        userId,
        action: 'credit',
        amount: 250,
        reason: 'HTTP test credit'
      })
    });
    assert.equal(balRes.status, 200);
    const balJson = await balRes.json();
    assert.equal(balJson.code, 1000);
    assert.equal(balJson.data.newBalance, 1250);
    assert.equal(state.users[userId].balance, 1250);

    // 4. Create withdrawal and test POST /api/admin/withdrawal/edit-amount
    state.withdrawals['WTH_HTTP_1'] = {
      id: 'WTH_HTTP_1',
      withdrawalId: 'WTH_HTTP_1',
      userId,
      amount: 500,
      status: 'pending',
      payoutType: 'upi',
      payoutDetails: { upiId: 'http@upi' },
      createdAt: new Date().toISOString()
    };
    state.users[userId].balance = 750;
    state.users[userId].pendingWithdrawal = 500;

    const editWthRes = await fetch(`${baseUrl}/api/admin/withdrawal/edit-amount`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        withdrawalId: 'WTH_HTTP_1',
        newAmount: 300,
        reason: 'Adjusting payout to ₹300'
      })
    });
    assert.equal(editWthRes.status, 200);
    const editWthJson = await editWthRes.json();
    assert.equal(editWthJson.code, 1000);
    assert.equal(editWthJson.data.amount, 300);
    // ₹200 returned to available balance: 750 + 200 = 950
    assert.equal(state.users[userId].balance, 950);

    // 5. GET /api/admin/transactions/all
    const txRes = await fetch(`${baseUrl}/api/admin/transactions/all`, { headers: adminHeaders });
    assert.equal(txRes.status, 200);
    const txJson = await txRes.json();
    assert.equal(txJson.code, 1000);
    assert.ok(txJson.data.records.some(t => t.id === 'WTH_HTTP_1'));

    // 5b. POST /api/admin/transaction/edit - Admin edits transaction amount
    const editTxRes = await fetch(`${baseUrl}/api/admin/transaction/edit`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        type: 'withdrawal',
        id: 'WTH_HTTP_1',
        newAmount: 450,
        adjustUserBalance: true,
        reason: 'Adjusting to ₹450'
      })
    });
    assert.equal(editTxRes.status, 200);
    const editTxJson = await editTxRes.json();
    assert.equal(editTxJson.code, 1000);
    assert.equal(editTxJson.data.newAmount, 450);
    assert.equal(state.withdrawals['WTH_HTTP_1'].amount, 450);

    // 6. POST /api/admin/transaction/delete
    const delRes = await fetch(`${baseUrl}/api/admin/transaction/delete`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        type: 'withdrawal',
        id: 'WTH_HTTP_1',
        refundHold: true
      })
    });
    assert.equal(delRes.status, 200);
    const delJson = await delRes.json();
    assert.equal(delJson.code, 1000);
    assert.equal(state.withdrawals['WTH_HTTP_1'], undefined);

    // 7. POST /api/admin/user/erase - Completely erase user from app & database
    const eraseRes = await fetch(`${baseUrl}/api/admin/user/erase`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ userId })
    });
    assert.equal(eraseRes.status, 200);
    const eraseJson = await eraseRes.json();
    assert.equal(eraseJson.code, 1000);
    assert.equal(state.users[userId], undefined, 'User must be completely erased from state.users');
  } finally {
    server.close();
  }
});

test('admin can completely erase a user and all their associated records from the app and database', () => {
  db.reset();
  const state = db.get();

  const userId = 'trader-erase-full-5';
  state.users[userId] = {
    id: userId,
    userId,
    phone: '9777666555',
    nickname: 'ToEraseTrader',
    balance: 8888.00,
    totalBalance: 8888.00,
    pendingWithdrawal: 1000.00
  };

  // Add bound wallet
  state.wallets.push({ id: 999, userId, ctType: 3, account: 'erase@upi', status: 1 });

  // Add claimed order
  state.claimedOrders['ORD_ERASE_1'] = { buyId: 'ORD_ERASE_1', userId, amount: 500, status: 'verifying' };

  // Add deposit
  state.deposits['DEP_ERASE_1'] = { id: 'DEP_ERASE_1', userId, amount: 2000, status: 'verifying' };

  // Add withdrawal
  state.withdrawals['WTH_ERASE_1'] = { id: 'WTH_ERASE_1', userId, amount: 1000, status: 'pending' };

  // Add ledger entry
  state.ledger.entries.push({ id: 'LED_ERASE_1', userId, amount: 1000, idempotencyKey: 'key_erase_1' });
  state.ledger.idempotency['key_erase_1'] = 'LED_ERASE_1';

  // Execute complete erasure
  const result = paymentEngine.eraseUser({ userId, adminId: 'admin-user-99' });
  assert.equal(result.success, true);
  assert.equal(result.userId, userId);

  // Verify user is gone from state.users
  assert.equal(state.users[userId], undefined, 'User record must be removed');

  // Verify wallets removed
  assert.equal(state.wallets.some(w => String(w.userId) === String(userId)), false, 'Wallets must be removed');

  // Verify claimed orders removed
  assert.equal(state.claimedOrders['ORD_ERASE_1'], undefined, 'Claimed orders must be removed');

  // Verify deposits removed
  assert.equal(state.deposits['DEP_ERASE_1'], undefined, 'Deposits must be removed');

  // Verify withdrawals removed
  assert.equal(state.withdrawals['WTH_ERASE_1'], undefined, 'Withdrawals must be removed');

  // Verify ledger entries removed
  assert.equal(state.ledger.entries.some(e => String(e.userId) === String(userId)), false, 'Ledger entries must be removed');
  assert.equal(state.ledger.idempotency['key_erase_1'], undefined, 'Idempotency key must be removed');

  // Verify token is revoked
  assert.ok(state.revokedTokens[userId], 'Tokens must be revoked');
});

test('admin can manipulate transaction history amounts and details which reflects immediately in user history', () => {
  db.reset();
  const state = db.get();

  const userId = 'trader-tx-manipulate-6';
  state.users[userId] = {
    id: userId,
    userId,
    phone: '9666555444',
    nickname: 'ManipulateTrader',
    balance: 5000.00,
    totalBalance: 5000.00,
    totalDeposited: 40000.00,
    totalWithdrawn: 164.00
  };

  // 1. Create a completed Deposit of ₹40,000 (just like in the user screenshot!)
  state.deposits['DEP_MAN_1'] = {
    id: 'DEP_MAN_1',
    depositId: 'DEP_MAN_1',
    userId,
    amount: 40000,
    status: 'completed',
    utr: '998877665544',
    createdAt: new Date().toISOString()
  };

  // 2. Create a completed Withdrawal of ₹164 (just like in the user screenshot!)
  state.withdrawals['WTH_MAN_1'] = {
    id: 'WTH_MAN_1',
    withdrawalId: 'WTH_MAN_1',
    userId,
    amount: 164,
    status: 'completed',
    txRef: 'IMPS164164',
    createdAt: new Date().toISOString()
  };

  // Initial user history verification
  const initialHistory = paymentEngine.getUserUnifiedTransactions(userId);
  const depBefore = initialHistory.find(t => t.id === 'DEP_MAN_1');
  const wthBefore = initialHistory.find(t => t.id === 'WTH_MAN_1');
  assert.equal(depBefore.amount, 40000);
  assert.equal(wthBefore.amount, 164);

  // 3. Admin edits deposit amount from ₹40,000 to ₹50,000
  const editDepResult = paymentEngine.editTransaction({
    type: 'deposit',
    id: 'DEP_MAN_1',
    newAmount: 50000,
    adjustUserBalance: true,
    reason: 'Bank statement corrected to ₹50,000'
  });
  assert.equal(editDepResult.success, true);
  assert.equal(editDepResult.newAmount, 50000);
  assert.equal(editDepResult.oldAmount, 40000);
  // User balance increased by delta ₹10,000: 5000 + 10000 = 15000
  assert.equal(state.users[userId].balance, 15000);
  assert.equal(state.users[userId].totalDeposited, 50000);

  // 4. Admin edits withdrawal amount from ₹164 to ₹500
  const editWthResult = paymentEngine.editTransaction({
    type: 'withdrawal',
    id: 'WTH_MAN_1',
    newAmount: 500,
    adjustUserBalance: true,
    reason: 'Corrected payout amount to ₹500'
  });
  assert.equal(editWthResult.success, true);
  assert.equal(editWthResult.newAmount, 500);
  assert.equal(editWthResult.oldAmount, 164);
  // Difference is ₹336 (withdrew more, so balance debited): 15000 - 336 = 14664
  assert.equal(state.users[userId].balance, 14664);
  assert.equal(state.users[userId].totalWithdrawn, 500);

  // 5. CRITICAL: Verify that the user's transaction history IMMEDIATELY reflects the new amounts!
  const updatedHistory = paymentEngine.getUserUnifiedTransactions(userId);
  const depAfter = updatedHistory.find(t => t.id === 'DEP_MAN_1');
  const wthAfter = updatedHistory.find(t => t.id === 'WTH_MAN_1');
  assert.equal(depAfter.amount, 50000, 'Deposit in user history must reflect new amount of ₹50,000');
  assert.equal(wthAfter.amount, 500, 'Withdrawal in user history must reflect new amount of ₹500');

  // 6. Admin edits without adjusting balance (pure display / record correction)
  paymentEngine.editTransaction({
    type: 'deposit',
    id: 'DEP_MAN_1',
    newAmount: 52000,
    adjustUserBalance: false,
    reason: 'Display correction only'
  });
  assert.equal(state.users[userId].balance, 14664, 'User balance must remain unchanged when adjustUserBalance is false');
  const finalHistory = paymentEngine.getUserUnifiedTransactions(userId);
  assert.equal(finalHistory.find(t => t.id === 'DEP_MAN_1').amount, 52000, 'User history must show ₹52,000');
});
