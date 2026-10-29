const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const db = require('../server/engine/db');
const paymentEngine = require('../server/engine/paymentEngine');

test('Deposit & Withdrawal Flow: create, submit UTR, admin verify, request withdrawal, admin payout & refund', async (t) => {
  const testUserId = 'test_user_' + Date.now();
  const state = db.get();

  state.users[testUserId] = {
    id: testUserId,
    userId: testUserId,
    phone: '+919999988888',
    nickname: 'Test_Trader',
    balance: 0.00,
    totalBalance: 0.00,
    totalDeposited: 0.00,
    totalWithdrawn: 0.00,
    pendingWithdrawal: 0.00,
    isPinSet: false
  };

  // 1. Create deposit order
  const deposit = await paymentEngine.createDeposit({ userId: testUserId, amount: 5000 });
  assert.equal(deposit.amount, 5000);
  assert.equal(deposit.status, 'pending');
  assert.ok(deposit.payeeVpa);
  assert.ok(deposit.upiUri.includes('upi://pay'));
  assert.ok(deposit.qrCodeDataUrl.startsWith('data:image/png;base64,'));

  // 2. Submit payment with 12-digit UTR
  const validUtr = '987654321098';
  const submitted = paymentEngine.submitDepositUtr({
    depositId: deposit.id,
    utr: validUtr,
    proofUrl: 'https://example.com/receipt.jpg',
    userId: testUserId
  });
  assert.equal(submitted.status, 'verifying');
  assert.equal(submitted.utr, validUtr);

  // 3. Admin sees pending deposit
  const pendingDeposits = paymentEngine.getPendingDeposits();
  const foundInPending = pendingDeposits.find(d => d.id === deposit.id);
  assert.ok(foundInPending);
  assert.equal(foundInPending.amount, 5000);
  assert.equal(foundInPending.utr, validUtr);

  // 4. Admin confirms deposit
  const confirmed = paymentEngine.verifyDeposit({
    depositId: deposit.id,
    adminId: 'admin_test',
    action: 'confirm'
  });
  assert.equal(confirmed.status, 'completed');

  // Verify balance credited
  const updatedUser = state.users[testUserId];
  assert.equal(updatedUser.balance, 5000);
  assert.equal(updatedUser.totalDeposited, 5000);

  // 5. User requests withdrawal of 2000
  const withdrawal = paymentEngine.requestWithdrawal({
    userId: testUserId,
    amount: 2000,
    payoutType: 'upi',
    payoutDetails: {
      upiId: 'trader@okhdfcbank',
      accountName: 'Test Trader'
    }
  });
  assert.equal(withdrawal.amount, 2000);
  assert.equal(withdrawal.status, 'pending');
  assert.equal(updatedUser.balance, 3000); // 5000 - 2000
  assert.equal(updatedUser.pendingWithdrawal, 2000);

  // 6. Admin sees pending withdrawal
  const pendingWithdrawals = paymentEngine.getPendingWithdrawals();
  const foundWithdrawal = pendingWithdrawals.find(w => w.id === withdrawal.id);
  assert.ok(foundWithdrawal);
  assert.equal(foundWithdrawal.amount, 2000);
  assert.equal(foundWithdrawal.payoutDetails.upiId, 'trader@okhdfcbank');

  // 7. Admin confirms withdrawal payout
  const paidWithdrawal = paymentEngine.verifyWithdrawal({
    withdrawalId: withdrawal.id,
    adminId: 'admin_test',
    action: 'confirm',
    txRef: 'BANKREF123456'
  });
  assert.equal(paidWithdrawal.status, 'completed');
  assert.equal(updatedUser.pendingWithdrawal, 0);
  assert.equal(updatedUser.totalWithdrawn, 2000);
  assert.equal(updatedUser.balance, 3000);

  // 8. User requests another withdrawal of 1000, and Admin rejects it (refund test)
  const withdrawal2 = paymentEngine.requestWithdrawal({
    userId: testUserId,
    amount: 1000,
    payoutType: 'upi',
    payoutDetails: { upiId: 'wrong@upi' }
  });
  assert.equal(updatedUser.balance, 2000); // 3000 - 1000

  const rejectedWithdrawal = paymentEngine.verifyWithdrawal({
    withdrawalId: withdrawal2.id,
    adminId: 'admin_test',
    action: 'reject',
    reason: 'Invalid UPI ID format reported by bank'
  });
  assert.equal(rejectedWithdrawal.status, 'rejected');
  // Balance must be automatically refunded back to 3000!
  assert.equal(updatedUser.balance, 3000);
  assert.equal(updatedUser.pendingWithdrawal, 0);

  // 9. Unified transaction history test
  const history = paymentEngine.getUserUnifiedTransactions(testUserId);
  assert.ok(history.length >= 3);
  const depositTx = history.find(h => h.id === deposit.id);
  const wthTx1 = history.find(h => h.id === withdrawal.id);
  const wthTx2 = history.find(h => h.id === withdrawal2.id);
  assert.ok(depositTx && depositTx.txType === 'deposit' && depositTx.status === 'completed');
  assert.ok(wthTx1 && wthTx1.txType === 'withdrawal' && wthTx1.status === 'completed');
  assert.ok(wthTx2 && wthTx2.txType === 'withdrawal' && wthTx2.status === 'rejected');

  // Clean up test user
  delete state.users[testUserId];
  delete state.deposits[deposit.id];
  delete state.withdrawals[withdrawal.id];
  delete state.withdrawals[withdrawal2.id];
  db.save();
});

