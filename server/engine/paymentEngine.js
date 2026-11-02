const db = require('./db');
const qrService = require('./qrService');
const security = require('./security');
const money = require('./money');
const ledger = require('./ledger');

let wsBroadcaster = null;

function setBroadcaster(fn) {
  wsBroadcaster = fn;
}

function broadcast(type, payload) {
  if (typeof wsBroadcaster === 'function') {
    wsBroadcaster({ type, payload, timestamp: Date.now() });
  }
}

function generateId(prefix = 'DEP') {
  const now = new Date();
  const ymd = now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const rnd = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}${ymd}${rnd}`;
}

/**
 * Get the active official receiving wallet for deposits.
 *
 * Deposits must only ever be paid into a wallet explicitly owned by the
 * system. Falling back to "the first active wallet" would send user money to
 * another trader's UPI account, so this fails closed when no system wallet is
 * configured instead of guessing.
 */
function getOfficialReceivingWallet(state) {
  const wallets = Array.isArray(state && state.wallets) ? state.wallets : [];
  const official = wallets.find(wallet => {
    if (!wallet || wallet.isOfficial !== true) return false;
    if (Number(wallet.status) !== 1) return false;
    if (String(wallet.userId) !== 'system') return false;
    const account = String(wallet.account || wallet.vpa || '').trim();
    return account.includes('@');
  });

  if (!official) {
    const error = new Error(
      'No official deposit wallet is configured. Deposits are temporarily unavailable.'
    );
    error.status = 503;
    throw error;
  }

  return {
    walletId: official.id,
    vpa: String(official.account || official.vpa).trim(),
    name: official.name || 'TradePay Official',
    qrImage: official.qrImage || '/static/qr/scr2.jpeg'
  };
}

/**
 * 1. DEPOSIT: Create a new deposit order with official QR code and UPI details
 */
async function createDeposit({ userId, amount }) {
  if (!userId) throw new Error('Authentication required');
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('Please enter a valid deposit amount');
  }
  if (numericAmount < 100) {
    throw new Error('Minimum deposit amount is ₹100');
  }
  if (numericAmount > 10000000) {
    throw new Error('Maximum single deposit amount is ₹1,00,00,000');
  }

  const state = db.get();
  const user = state.users[userId];
  if (!user) throw new Error('User not found');

  const depositId = generateId('DEP');
  const receiving = getOfficialReceivingWallet(state);

  // Construct NPCI standard UPI URI
  const upiUri = qrService.buildUpiUri({
    vpa: receiving.vpa,
    name: receiving.name,
    amount: numericAmount,
    note: `Deposit ${depositId}`
  });

  // Generate dynamic QR code data URL (Base64 PNG)
  let qrCodeDataUrl = '';
  try {
    qrCodeDataUrl = await qrService.getQrDataUrl(upiUri, { width: 320 });
  } catch (e) {
    console.warn('[PaymentEngine] Error generating dynamic QR:', e.message);
  }

  const depositRecord = {
    id: depositId,
    depositId,
    userId: String(userId),
    userPhone: user.phone || '',
    userNickname: user.nickname || 'Trader',
    amount: numericAmount,
    status: 'pending', // pending user payment & UTR submission
    payeeWalletId: receiving.walletId,
    payeeVpa: receiving.vpa,
    payeeName: receiving.name,
    qrImage: receiving.qrImage,
    qrCodeDataUrl,
    upiUri,
    utr: null,
    proofUrl: null,
    createdAt: new Date().toISOString(),
    submittedAt: null,
    verifiedAt: null,
    rejectedAt: null,
    rejectReason: null,
    verifiedBy: null
  };

  if (!state.deposits || typeof state.deposits !== 'object') {
    state.deposits = {};
  }
  state.deposits[depositId] = depositRecord;
  db.save();

  return depositRecord;
}

/**
 * 2. DEPOSIT: User submits payment confirmation with 12-digit UTR
 */
function submitDepositUtr({ depositId, utr = '', proofUrl = '', userId }) {
  if (!userId) throw new Error('Authentication required');
  let cleanUtr = String(utr || '').trim();

  // If user did not provide a valid 12-digit UTR, auto-generate a valid 12-digit reference
  if (!security.isValidUtr(cleanUtr)) {
    cleanUtr = String(Date.now()).slice(-9) + String(Math.floor(100 + Math.random() * 900));
  }

  const state = db.get();
  if (!state.deposits || !state.deposits[depositId]) {
    throw new Error('Deposit order not found');
  }

  const deposit = state.deposits[depositId];
  if (String(deposit.userId) !== String(userId)) {
    throw new Error('Deposit order not found');
  }

  if (deposit.status === 'completed') {
    throw new Error('This deposit has already been verified and credited');
  }

  if (deposit.status === 'verifying') {
    // If user re-submits or updates UTR while verifying
    deposit.utr = cleanUtr;
    deposit.proofUrl = typeof proofUrl === 'string' ? proofUrl.slice(0, 500) : deposit.proofUrl;
    db.save();
    return deposit;
  }

  // Prevent duplicate UTR usage across all deposits and orders
  const duplicateInDeposits = Object.values(state.deposits || {}).some(
    d => d.id !== depositId && d.utr && String(d.utr) === cleanUtr && d.status !== 'rejected'
  );
  const duplicateInOrders = Object.values(state.claimedOrders || {}).some(
    o => o.utr && String(o.utr) === cleanUtr && o.status !== 'rejected'
  );

  if (duplicateInDeposits || duplicateInOrders) {
    throw new Error('This 12-digit UTR has already been submitted for verification');
  }

  deposit.status = 'verifying';
  deposit.utr = cleanUtr;
  deposit.proofUrl = typeof proofUrl === 'string' ? proofUrl.slice(0, 500) : '';
  deposit.submittedAt = new Date().toISOString();

  db.save();

  const user = state.users[deposit.userId];

  // Notify user via WebSocket
  broadcast('DEPOSIT_SUBMITTED', {
    userId: deposit.userId,
    depositId: deposit.id,
    amount: deposit.amount,
    utr: cleanUtr,
    status: 'verifying',
    msg: `Deposit of ₹${deposit.amount} submitted with Ref No. ${cleanUtr}. Waiting for admin verification.`
  });

  // Notify admin console in real-time
  broadcast('ADMIN_DEPOSIT_NEEDS_VERIFICATION', {
    depositId: deposit.id,
    userId: deposit.userId,
    userPhone: user ? user.phone : deposit.userPhone,
    userNickname: user ? user.nickname : deposit.userNickname,
    amount: deposit.amount,
    utr: cleanUtr,
    submittedAt: deposit.submittedAt,
    payeeVpa: deposit.payeeVpa
  });

  return deposit;
}

/**
 * 3. DEPOSIT: Admin verifies and credits (or rejects) the deposit
 */
function verifyDeposit({ depositId, adminId = 'admin', action = 'confirm', reason = '' }) {
  const state = db.get();
  if (!state.deposits || !state.deposits[depositId]) {
    throw new Error('Deposit order not found');
  }

  const deposit = state.deposits[depositId];
  if (deposit.status !== 'verifying') {
    throw new Error(`Deposit cannot be verified from status "${deposit.status}"`);
  }

  const user = state.users[deposit.userId];
  if (!user) throw new Error('Target user account not found');

  if (action === 'confirm') {
    // Credit through the ledger first so a failed entry leaves the deposit
    // untouched and retryable.
    const credit = ledger.credit(state, deposit.userId, deposit.amount, {
      type: 'deposit_credit',
      refType: 'deposit',
      refId: deposit.id,
      idempotencyKey: `deposit_credit:${deposit.id}`,
      actorId: adminId
    });

    deposit.status = 'completed';
    deposit.verifiedAt = new Date().toISOString();
    deposit.verifiedBy = String(adminId);

    if (!credit.duplicate) {
      user.totalDeposited = money.add(user.totalDeposited || 0, deposit.amount);
    }

    db.save();

    // Sync with Supabase if configured
    try {
      const supabaseService = require('./supabaseService');
      supabaseService.syncUserData(user).catch(() => {});
    } catch (e) {}

    // Broadcast to user: balance updated!
    broadcast('DEPOSIT_VERIFIED', {
      userId: deposit.userId,
      depositId: deposit.id,
      amount: deposit.amount,
      utr: deposit.utr,
      balance: user.balance,
      status: 'completed',
      msg: `Deposit of ₹${deposit.amount} confirmed by admin! ₹${deposit.amount} has been added to your balance.`
    });

    broadcast('BALANCE_UPDATED', {
      userId: deposit.userId,
      balance: user.balance,
      totalBalance: user.totalBalance,
      delta: deposit.amount,
      type: 'deposit_credit'
    });

    return deposit;
  } else if (action === 'reject') {
    deposit.status = 'rejected';
    deposit.rejectedAt = new Date().toISOString();
    deposit.rejectReason = String(reason || 'Bank reference / UTR could not be verified').slice(0, 200);
    deposit.verifiedBy = String(adminId);

    db.save();

    broadcast('DEPOSIT_REJECTED', {
      userId: deposit.userId,
      depositId: deposit.id,
      amount: deposit.amount,
      utr: deposit.utr,
      status: 'rejected',
      reason: deposit.rejectReason,
      msg: `Deposit verification failed for UTR ${deposit.utr}: ${deposit.rejectReason}`
    });

    return deposit;
  } else {
    throw new Error(`Invalid action: "${action}". Must be "confirm" or "reject"`);
  }
}

/**
 * 4. WITHDRAWAL: User requests money withdrawal
 */
function requestWithdrawal({ userId, amount, payoutType = 'upi', payoutDetails = {}, pin = '' }) {
  if (!userId) throw new Error('Authentication required');
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('Please enter a valid withdrawal amount');
  }
  if (numericAmount < 100) {
    throw new Error('Minimum withdrawal amount is ₹100');
  }

  const state = db.get();
  const user = state.users[userId];
  if (!user) throw new Error('User not found');

  // Verify PIN if configured. Fail closed when the PIN flag is set but the
  // hash is missing (for example after a metadata-only restore).
  const pinConfigured = Boolean(user.pinHash && user.pinSalt);
  if (pinConfigured || user.isPinSet) {
    if (!pinConfigured) {
      throw new Error('Payment Security PIN is not configured correctly. Please set a new PIN.');
    }
    if (!pin) {
      throw new Error('Payment Security PIN is required for withdrawals');
    }
    if (!security.verifyPin(pin, user)) {
      throw new Error('Invalid Payment Security PIN');
    }
  }

  // Check sufficient available balance
  const currentBalance = Number(user.balance) || 0;
  if (currentBalance < numericAmount) {
    throw new Error(`Insufficient available balance. Available: ₹${currentBalance.toFixed(2)}`);
  }

  // Validate payout account details
  let cleanDetails = {};
  if (payoutType === 'bank') {
    const accountNo = String(payoutDetails.accountNumber || '').trim();
    const ifsc = String(payoutDetails.ifsc || '').trim().toUpperCase();
    const holderName = String(payoutDetails.accountName || user.nickname || '').trim();
    const bankName = String(payoutDetails.bankName || 'Bank Transfer').trim();

    if (!accountNo || accountNo.length < 6) {
      throw new Error('Please provide a valid bank account number');
    }
    if (!ifsc || ifsc.length < 4) {
      throw new Error('Please provide a valid bank IFSC code');
    }

    cleanDetails = {
      bankName,
      accountNumber: accountNo,
      ifsc,
      accountName: holderName
    };
  } else {
    // UPI
    const upiId = String(payoutDetails.upiId || payoutDetails.account || '').trim();
    const holderName = String(payoutDetails.accountName || user.nickname || 'Trader').trim();

    if (!upiId || !upiId.includes('@')) {
      throw new Error('Please provide a valid UPI ID (e.g. mobile@ybl or user@upi)');
    }

    cleanDetails = {
      upiId,
      accountName: holderName
    };
  }

  const withdrawalId = generateId('WTH');

  // Move funds from available balance into the pending-withdrawal bucket in a
  // single ledger entry so the hold cannot drift from the balance.
  ledger.hold(state, user.id, numericAmount, {
    type: 'withdrawal_hold',
    refType: 'withdrawal',
    refId: withdrawalId,
    idempotencyKey: `withdrawal_hold:${withdrawalId}`,
    actorId: user.id
  });

  const withdrawalRecord = {
    id: withdrawalId,
    withdrawalId,
    userId: String(userId),
    userPhone: user.phone || '',
    userNickname: user.nickname || 'Trader',
    amount: numericAmount,
    payoutType,
    payoutDetails: cleanDetails,
    status: 'pending', // pending admin transfer confirmation
    txRef: null,
    createdAt: new Date().toISOString(),
    processedAt: null,
    processedBy: null,
    rejectReason: null
  };

  if (!state.withdrawals || typeof state.withdrawals !== 'object') {
    state.withdrawals = {};
  }
  state.withdrawals[withdrawalId] = withdrawalRecord;

  db.save();

  // Sync updated balance to Supabase
  try {
    const supabaseService = require('./supabaseService');
    supabaseService.syncUserData(user).catch(() => {});
  } catch (e) {}

  // Broadcast to user
  broadcast('WITHDRAWAL_REQUESTED', {
    userId: withdrawalRecord.userId,
    withdrawalId: withdrawalRecord.id,
    amount: withdrawalRecord.amount,
    balance: user.balance,
    status: 'pending',
    msg: `Withdrawal request of ₹${withdrawalRecord.amount} submitted. Admin will process your payout.`
  });

  broadcast('BALANCE_UPDATED', {
    userId: withdrawalRecord.userId,
    balance: user.balance,
    totalBalance: user.totalBalance,
    delta: -withdrawalRecord.amount,
    type: 'withdrawal_pending'
  });

  // Broadcast to admin console in real-time
  broadcast('ADMIN_WITHDRAWAL_NEEDS_ACTION', {
    withdrawalId: withdrawalRecord.id,
    userId: withdrawalRecord.userId,
    userPhone: user.phone,
    userNickname: user.nickname,
    amount: withdrawalRecord.amount,
    payoutType: withdrawalRecord.payoutType,
    payoutDetails: withdrawalRecord.payoutDetails,
    createdAt: withdrawalRecord.createdAt
  });

  return withdrawalRecord;
}

/**
 * 5. WITHDRAWAL: Admin confirms payout sent OR rejects with refund
 */
function verifyWithdrawal({ withdrawalId, adminId = 'admin', action = 'confirm', txRef = '', reason = '' }) {
  const state = db.get();
  if (!state.withdrawals || !state.withdrawals[withdrawalId]) {
    throw new Error('Withdrawal request not found');
  }

  const withdrawal = state.withdrawals[withdrawalId];
  if (withdrawal.status !== 'pending') {
    throw new Error(`Withdrawal cannot be processed from status "${withdrawal.status}"`);
  }

  const user = state.users[withdrawal.userId];
  if (!user) throw new Error('Target user account not found');

  if (action === 'confirm') {
    const settlement = ledger.settle(state, withdrawal.userId, withdrawal.amount, {
      type: 'withdrawal_settle',
      refType: 'withdrawal',
      refId: withdrawal.id,
      idempotencyKey: `withdrawal_settle:${withdrawal.id}`,
      actorId: adminId
    });

    withdrawal.status = 'completed';
    withdrawal.txRef = String(txRef || `PAY${Date.now()}`).trim();
    withdrawal.processedAt = new Date().toISOString();
    withdrawal.processedBy = String(adminId);

    // Update user total withdrawn; the ledger released the held amount.
    if (!settlement.duplicate) {
      user.totalWithdrawn = money.add(user.totalWithdrawn || 0, withdrawal.amount);
    }

    db.save();

    try {
      const supabaseService = require('./supabaseService');
      supabaseService.syncUserData(user).catch(() => {});
    } catch (e) {}

    broadcast('WITHDRAWAL_COMPLETED', {
      userId: withdrawal.userId,
      withdrawalId: withdrawal.id,
      amount: withdrawal.amount,
      txRef: withdrawal.txRef,
      status: 'completed',
      msg: `Withdrawal of ₹${withdrawal.amount} completed! Funds transferred via ${String(withdrawal.payoutType || 'payout').toUpperCase()} (Ref: ${withdrawal.txRef}).`
    });

    return withdrawal;
  } else if (action === 'reject') {
    // AUTOMATIC REFUND BACK TO USER BALANCE
    ledger.refund(state, withdrawal.userId, withdrawal.amount, {
      type: 'withdrawal_refund',
      refType: 'withdrawal',
      refId: withdrawal.id,
      idempotencyKey: `withdrawal_refund:${withdrawal.id}`,
      actorId: adminId
    });

    withdrawal.status = 'rejected';
    withdrawal.rejectReason = String(reason || 'Payment could not be completed / invalid payout details').slice(0, 200);
    withdrawal.processedAt = new Date().toISOString();
    withdrawal.processedBy = String(adminId);

    db.save();

    try {
      const supabaseService = require('./supabaseService');
      supabaseService.syncUserData(user).catch(() => {});
    } catch (e) {}

    broadcast('WITHDRAWAL_REJECTED', {
      userId: withdrawal.userId,
      withdrawalId: withdrawal.id,
      amount: withdrawal.amount,
      balance: user.balance,
      status: 'rejected',
      reason: withdrawal.rejectReason,
      msg: `Withdrawal of ₹${withdrawal.amount} was rejected (${withdrawal.rejectReason}). ₹${withdrawal.amount} refunded back to your balance.`
    });

    broadcast('BALANCE_UPDATED', {
      userId: withdrawal.userId,
      balance: user.balance,
      totalBalance: user.totalBalance,
      delta: withdrawal.amount,
      type: 'withdrawal_refund'
    });

    return withdrawal;
  } else {
    throw new Error(`Invalid action: "${action}". Must be "confirm" or "reject"`);
  }
}

/**
 * Get all pending deposits awaiting admin verification
 */
function getPendingDeposits() {
  const state = db.get();
  const list = Object.values(state.deposits || {})
    .filter(d => d && d.status === 'verifying')
    .sort((a, b) => new Date(b.submittedAt || b.createdAt) - new Date(a.submittedAt || a.createdAt));

  return list.map(d => {
    const user = state.users[d.userId];
    return {
      ...d,
      userNickname: user ? user.nickname : d.userNickname || 'Trader',
      userPhone: user ? user.phone : d.userPhone || ''
    };
  });
}

/**
 * Get all deposits for admin audit
 */
function getAllDepositsForAdmin(filter = 'all') {
  const state = db.get();
  let list = Object.values(state.deposits || {});
  if (filter && filter !== 'all') {
    list = list.filter(d => d && d.status === filter);
  }
  list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  return list.map(d => {
    const user = state.users[d.userId];
    return {
      ...d,
      userNickname: user ? user.nickname : d.userNickname || 'Trader',
      userPhone: user ? user.phone : d.userPhone || ''
    };
  });
}

/**
 * Get all pending withdrawals awaiting admin payout confirmation
 */
function getPendingWithdrawals() {
  const state = db.get();
  const list = Object.values(state.withdrawals || {})
    .filter(w => w && w.status === 'pending')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)); // FIFO for payouts

  return list.map(w => {
    const user = state.users[w.userId];
    return {
      ...w,
      userNickname: user ? user.nickname : w.userNickname || 'Trader',
      userPhone: user ? user.phone : w.userPhone || '',
      userBalance: user ? user.balance : 0
    };
  });
}

/**
 * Get all withdrawals for admin audit
 */
function getAllWithdrawalsForAdmin(filter = 'all') {
  const state = db.get();
  let list = Object.values(state.withdrawals || {});
  if (filter && filter !== 'all') {
    list = list.filter(w => w && w.status === filter);
  }
  list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  return list.map(w => {
    const user = state.users[w.userId];
    return {
      ...w,
      userNickname: user ? user.nickname : w.userNickname || 'Trader',
      userPhone: user ? user.phone : w.userPhone || '',
      userBalance: user ? user.balance : 0
    };
  });
}

/**
 * Query user deposits history
 */
function getUserDeposits(userId) {
  if (!userId) return [];
  const state = db.get();
  return Object.values(state.deposits || {})
    .filter(d => d && String(d.userId) === String(userId))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

/**
 * Query user withdrawals history
 */
function getUserWithdrawals(userId) {
  if (!userId) return [];
  const state = db.get();
  return Object.values(state.withdrawals || {})
    .filter(w => w && String(w.userId) === String(userId))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

/**
 * Unified user transaction history combining Orders, Deposits, and Withdrawals
 */
function getUserUnifiedTransactions(userId) {
  if (!userId) return [];
  const state = db.get();

  const orders = Object.values(state.claimedOrders || {})
    .filter(o => o && String(o.userId) === String(userId))
    .map(o => ({
      txType: 'order',
      id: o.buyId || o.id,
      orderNo: o.orderNo,
      amount: o.amount,
      reward: o.totalReward || 0,
      status: o.status,
      utr: o.utr,
      rejectReason: o.rejectReason,
      createdAt: o.createdAt,
      updatedAt: o.completedAt || o.submittedAt || o.createdAt
    }));

  const deposits = Object.values(state.deposits || {})
    .filter(d => d && String(d.userId) === String(userId))
    .map(d => ({
      txType: 'deposit',
      id: d.id,
      orderNo: d.depositId,
      amount: d.amount,
      reward: 0,
      status: d.status,
      utr: d.utr,
      rejectReason: d.rejectReason,
      createdAt: d.createdAt,
      updatedAt: d.verifiedAt || d.submittedAt || d.createdAt
    }));

  const withdrawals = Object.values(state.withdrawals || {})
    .filter(w => w && String(w.userId) === String(userId))
    .map(w => ({
      txType: 'withdrawal',
      id: w.id,
      orderNo: w.withdrawalId,
      amount: w.amount,
      reward: 0,
      totalReward: 0,
      status: w.status,
      txRef: w.txRef,
      payoutType: w.payoutType,
      payoutDetails: w.payoutDetails,
      rejectReason: w.rejectReason,
      createdAt: w.createdAt,
      updatedAt: w.processedAt || w.createdAt
    }));

  const all = [...orders, ...deposits, ...withdrawals];
  all.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return all;
}

/**
 * 6. WITHDRAWAL AMOUNT CONTROL: Admin modifies the withdrawal amount on a pending request
 */
function editWithdrawalAmount({ withdrawalId, newAmount, adminId = 'admin', reason = '' }) {
  const numericAmount = Number(newAmount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('New withdrawal amount must be a positive number');
  }

  const state = db.get();
  if (!state.withdrawals || !state.withdrawals[withdrawalId]) {
    throw new Error('Withdrawal request not found');
  }

  const withdrawal = state.withdrawals[withdrawalId];
  if (withdrawal.status !== 'pending') {
    throw new Error(`Cannot modify withdrawal amount when status is "${withdrawal.status}" (only "pending" can be modified)`);
  }

  const user = state.users[withdrawal.userId];
  if (!user) throw new Error('Target user account not found');

  const oldAmount = Number(withdrawal.amount);
  const diff = money.subtract(numericAmount, oldAmount);

  if (money.equals(diff, 0)) {
    return withdrawal;
  }

  if (diff < 0) {
    // Reduced withdrawal: refund difference back to user available balance
    const refundDiff = Math.abs(diff);
    ledger.apply(state, {
      userId: user.id,
      type: 'withdrawal_amount_reduced',
      amount: refundDiff,
      availableDelta: refundDiff,
      pendingDelta: money.multiply(refundDiff, -1),
      refType: 'withdrawal',
      refId: withdrawal.id,
      idempotencyKey: `wth_edit_${withdrawal.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      actorId: adminId,
      meta: { oldAmount, newAmount: numericAmount, reason }
    });
  } else {
    // Increased withdrawal: hold additional diff from balance
    const currentBalance = Number(user.balance) || 0;
    if (currentBalance < diff) {
      // Auto-credit shortfall if current balance is lower than required extra hold
      const shortfall = money.subtract(diff, currentBalance);
      ledger.credit(state, user.id, shortfall, {
        type: 'admin_withdrawal_adjustment_credit',
        refType: 'withdrawal',
        refId: withdrawal.id,
        idempotencyKey: `wth_credit_${withdrawal.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        actorId: adminId,
        meta: { reason: `Auto-credit for withdrawal increase: ${reason}` }
      });
    }

    ledger.apply(state, {
      userId: user.id,
      type: 'withdrawal_amount_increased',
      amount: diff,
      availableDelta: money.multiply(diff, -1),
      pendingDelta: diff,
      refType: 'withdrawal',
      refId: withdrawal.id,
      idempotencyKey: `wth_edit_${withdrawal.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      actorId: adminId,
      meta: { oldAmount, newAmount: numericAmount, reason }
    });
  }

  if (!withdrawal.originalAmount) {
    withdrawal.originalAmount = oldAmount;
  }
  withdrawal.amount = numericAmount;
  withdrawal.amountModifiedAt = new Date().toISOString();
  withdrawal.amountModifiedBy = String(adminId);
  withdrawal.modificationReason = String(reason || 'Amount adjusted by admin in console').slice(0, 200);

  db.save();

  try {
    const supabaseService = require('./supabaseService');
    supabaseService.syncUserData(user).catch(() => {});
  } catch (e) {}

  broadcast('WITHDRAWAL_AMOUNT_MODIFIED', {
    userId: withdrawal.userId,
    withdrawalId: withdrawal.id,
    oldAmount,
    newAmount: withdrawal.amount,
    reason: withdrawal.modificationReason,
    balance: user.balance,
    msg: `Your withdrawal request #${withdrawal.id} amount was adjusted from ₹${oldAmount} to ₹${withdrawal.amount}.`
  });

  broadcast('BALANCE_UPDATED', {
    userId: withdrawal.userId,
    balance: user.balance,
    totalBalance: user.totalBalance,
    delta: -diff,
    type: 'withdrawal_adjustment'
  });

  return withdrawal;
}

/**
 * 7. USER BALANCE MANIPULATION: Admin directly sets, credits or debits user balance
 */
function adjustUserBalance({ userId, action, amount, reason = '', adminId = 'admin' }) {
  if (!userId) throw new Error('User ID is required');
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount < 0) {
    throw new Error('Amount must be a non-negative number');
  }

  const state = db.get();
  const user = state.users[userId];
  if (!user) throw new Error('User not found');

  const currentBalance = Number(user.balance) || 0;
  let delta = 0;
  let ledgerType = '';

  if (action === 'set') {
    delta = money.subtract(numericAmount, currentBalance);
    ledgerType = delta >= 0 ? 'admin_balance_set_credit' : 'admin_balance_set_debit';
  } else if (action === 'credit') {
    delta = numericAmount;
    ledgerType = 'admin_credit';
  } else if (action === 'debit') {
    delta = money.multiply(numericAmount, -1);
    ledgerType = 'admin_debit';
  } else {
    throw new Error(`Invalid balance action: "${action}". Must be "set", "credit", or "debit"`);
  }

  if (money.equals(delta, 0)) {
    return {
      user: security.publicUser(user),
      delta: 0,
      oldBalance: currentBalance,
      newBalance: currentBalance,
      action
    };
  }

  const newBalance = money.add(currentBalance, delta);
  if (newBalance < 0) {
    throw new Error(`Cannot debit ₹${Math.abs(delta)}. Current balance is ₹${currentBalance}, which would result in a negative balance.`);
  }

  if (delta > 0) {
    ledger.credit(state, user.id, delta, {
      type: ledgerType,
      refType: 'admin_adjustment',
      refId: `ADJ${Date.now()}`,
      idempotencyKey: `adj_${user.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      actorId: adminId,
      meta: { action, reason: reason || 'Admin balance adjustment', oldBalance: currentBalance, newBalance }
    });
  } else {
    ledger.debit(state, user.id, Math.abs(delta), {
      type: ledgerType,
      refType: 'admin_adjustment',
      refId: `ADJ${Date.now()}`,
      idempotencyKey: `adj_${user.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      actorId: adminId,
      meta: { action, reason: reason || 'Admin balance adjustment', oldBalance: currentBalance, newBalance }
    });
  }

  user.updatedAt = new Date().toISOString();
  db.save();

  try {
    const supabaseService = require('./supabaseService');
    supabaseService.syncUserData(user).catch(() => {});
  } catch (e) {}

  broadcast('BALANCE_UPDATED', {
    userId: user.id,
    balance: user.balance,
    totalBalance: user.totalBalance,
    delta,
    type: ledgerType,
    msg: `Your balance was updated by admin: ${delta > 0 ? '+' : ''}₹${delta} (${reason || 'Adjustment'}). New balance: ₹${user.balance}`
  });

  broadcast('ADMIN_USER_UPDATED', {
    userId: user.id,
    balance: user.balance,
    totalBalance: user.totalBalance
  });

  return {
    user: security.publicUser(user),
    oldBalance: currentBalance,
    newBalance: user.balance,
    delta,
    action,
    reason
  };
}

/**
 * 8. UPDATE USER DETAILS: Admin edits nickname, phone, VIP level, points, or resets PIN
 */
function updateUserDetails({ userId, updates = {}, adminId = 'admin' }) {
  if (!userId) throw new Error('User ID is required');
  const state = db.get();
  const user = state.users[userId];
  if (!user) throw new Error('User not found');

  if (updates.nickname !== undefined && typeof updates.nickname === 'string') {
    user.nickname = updates.nickname.trim().slice(0, 40) || user.nickname;
  }
  if (updates.phone !== undefined && typeof updates.phone === 'string') {
    user.phone = updates.phone.trim();
  }
  if (updates.vipLevel !== undefined) {
    const vip = Number(updates.vipLevel);
    if (Number.isFinite(vip) && vip >= 0) user.vipLevel = vip;
  }
  if (updates.points !== undefined) {
    const pts = Number(updates.points);
    if (Number.isFinite(pts) && pts >= 0) user.points = pts;
  }
  if (updates.onSellStatus !== undefined) {
    user.onSellStatus = Number(updates.onSellStatus) ? 1 : 0;
  }
  if (updates.resetPin === true) {
    user.pinHash = null;
    user.pinSalt = null;
    user.isPinSet = false;
  }

  user.updatedAt = new Date().toISOString();
  db.save();

  try {
    const supabaseService = require('./supabaseService');
    supabaseService.syncUserData(user).catch(() => {});
  } catch (e) {}

  broadcast('ADMIN_USER_UPDATED', {
    userId: user.id,
    user: security.publicUser(user)
  });

  return security.publicUser(user);
}

/**
 * 9. DELETE TRANSACTION: Admin deletes any transaction (order, deposit, withdrawal, ledger)
 */
function deleteTransaction({ type, id, adminId = 'admin', refundHold = true }) {
  if (!type || !id) throw new Error('Transaction type and ID are required');
  const state = db.get();

  let found = false;
  let affectedUserId = null;
  const cleanId = String(id).trim();

  if (type === 'order') {
    const orderKey = Object.keys(state.claimedOrders || {}).find(
      k => k === cleanId || state.claimedOrders[k]?.buyId === cleanId || state.claimedOrders[k]?.orderNo === cleanId || state.claimedOrders[k]?.id === cleanId
    );
    if (orderKey && state.claimedOrders[orderKey]) {
      const order = state.claimedOrders[orderKey];
      affectedUserId = order.userId;
      delete state.claimedOrders[orderKey];
      found = true;
    }
    if (affectedUserId && state.users[affectedUserId]) {
      const user = state.users[affectedUserId];
      if (Array.isArray(user.claimedOrders)) {
        user.claimedOrders = user.claimedOrders.filter(
          o => (o.buyId !== cleanId && o.id !== cleanId && o.orderNo !== cleanId)
        );
      }
    }
  } else if (type === 'deposit') {
    const depKey = Object.keys(state.deposits || {}).find(
      k => k === cleanId || state.deposits[k]?.id === cleanId || state.deposits[k]?.depositId === cleanId
    );
    if (depKey && state.deposits[depKey]) {
      affectedUserId = state.deposits[depKey].userId;
      delete state.deposits[depKey];
      found = true;
    }
  } else if (type === 'withdrawal') {
    const wthKey = Object.keys(state.withdrawals || {}).find(
      k => k === cleanId || state.withdrawals[k]?.id === cleanId || state.withdrawals[k]?.withdrawalId === cleanId
    );
    if (wthKey && state.withdrawals[wthKey]) {
      const wth = state.withdrawals[wthKey];
      affectedUserId = wth.userId;
      // If withdrawal is pending and refundHold is requested, refund held balance!
      if (wth.status === 'pending' && refundHold) {
        try {
          ledger.refund(state, wth.userId, wth.amount, {
            type: 'withdrawal_delete_refund',
            refType: 'withdrawal',
            refId: wth.id,
            idempotencyKey: `wth_del_ref_${wth.id}_${Date.now()}`,
            actorId: adminId
          });
        } catch (e) {
          console.warn('[PaymentEngine] Refund on withdrawal deletion note:', e.message);
        }
      }
      delete state.withdrawals[wthKey];
      found = true;
    }
  } else if (type === 'ledger') {
    if (state.ledger && Array.isArray(state.ledger.entries)) {
      const idx = state.ledger.entries.findIndex(e => e.id === cleanId);
      if (idx !== -1) {
        affectedUserId = state.ledger.entries[idx].userId;
        state.ledger.entries.splice(idx, 1);
        found = true;
      }
    }
  } else {
    throw new Error(`Unsupported transaction type: "${type}"`);
  }

  if (!found) {
    throw new Error(`Transaction of type "${type}" with ID "${id}" was not found`);
  }

  db.save();

  if (affectedUserId && state.users[affectedUserId]) {
    const user = state.users[affectedUserId];
    try {
      const supabaseService = require('./supabaseService');
      supabaseService.syncUserData(user).catch(() => {});
    } catch (e) {}

    broadcast('BALANCE_UPDATED', {
      userId: user.id,
      balance: user.balance,
      totalBalance: user.totalBalance,
      delta: 0,
      type: 'transaction_deleted'
    });
  }

  broadcast('TRANSACTION_DELETED', {
    type,
    id: cleanId,
    adminId,
    timestamp: new Date().toISOString()
  });

  return { success: true, type, id: cleanId, affectedUserId };
}

/**
 * 9b. EDIT TRANSACTION: Admin modifies the amount, status, or details of any transaction
 * (deposit, withdrawal, order, ledger), immediately reflecting in the user's history and balance.
 */
function editTransaction({
  type,
  id,
  newAmount,
  newStatus,
  newUtr,
  adjustUserBalance = true,
  adminId = 'admin',
  reason = ''
}) {
  if (!type || !id) throw new Error('Transaction type and ID are required');
  const numericAmount = Number(newAmount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('Valid positive amount is required');
  }

  const state = db.get();
  const cleanId = String(id).trim();
  let found = false;
  let affectedUserId = null;
  let oldAmount = 0;
  let updatedRecord = null;
  let delta = 0;

  if (type === 'deposit') {
    const depKey = Object.keys(state.deposits || {}).find(
      k => k === cleanId || state.deposits[k]?.id === cleanId || state.deposits[k]?.depositId === cleanId
    );
    if (!depKey || !state.deposits[depKey]) {
      throw new Error(`Deposit "${id}" not found`);
    }
    const dep = state.deposits[depKey];
    affectedUserId = dep.userId;
    oldAmount = Number(dep.amount) || 0;
    delta = money.subtract(numericAmount, oldAmount);

    dep.amount = numericAmount;
    if (dep.originalAmount == null) dep.originalAmount = oldAmount;
    if (newStatus && typeof newStatus === 'string') dep.status = newStatus;
    if (newUtr && typeof newUtr === 'string') dep.utr = newUtr.trim();
    dep.updatedAt = new Date().toISOString();
    dep.adminEdited = {
      adminId,
      editedAt: new Date().toISOString(),
      oldAmount,
      newAmount: numericAmount,
      reason
    };

    // User balance adjustment if deposit is completed
    const user = state.users[affectedUserId];
    if (user && adjustUserBalance && dep.status === 'completed' && delta !== 0) {
      if (delta > 0) {
        ledger.credit(state, user.id, delta, {
          type: 'admin_deposit_adjust_credit',
          refType: 'deposit',
          refId: dep.id,
          actorId: adminId,
          reason: reason || `Admin adjusted deposit #${dep.id} from ₹${oldAmount} to ₹${numericAmount}`
        });
      } else {
        ledger.debit(state, user.id, Math.abs(delta), {
          type: 'admin_deposit_adjust_debit',
          refType: 'deposit',
          refId: dep.id,
          actorId: adminId,
          reason: reason || `Admin adjusted deposit #${dep.id} from ₹${oldAmount} to ₹${numericAmount}`
        });
      }
      user.totalDeposited = Math.max(0, money.add(user.totalDeposited || 0, delta));
    }

    // Update associated ledger entry if present
    if (state.ledger?.entries) {
      const depLedger = state.ledger.entries.find(
        e => e.refId === dep.id || e.refId === dep.depositId || e.referenceId === dep.id || e.referenceId === dep.depositId
      );
      if (depLedger) depLedger.amount = numericAmount;
    }

    found = true;
    updatedRecord = dep;
  } else if (type === 'withdrawal') {
    const wthKey = Object.keys(state.withdrawals || {}).find(
      k => k === cleanId || state.withdrawals[k]?.id === cleanId || state.withdrawals[k]?.withdrawalId === cleanId
    );
    if (!wthKey || !state.withdrawals[wthKey]) {
      throw new Error(`Withdrawal "${id}" not found`);
    }
    const wth = state.withdrawals[wthKey];
    affectedUserId = wth.userId;
    oldAmount = Number(wth.amount) || 0;
    delta = money.subtract(numericAmount, oldAmount);

    wth.amount = numericAmount;
    if (wth.originalAmount == null) wth.originalAmount = oldAmount;
    if (newStatus && typeof newStatus === 'string') wth.status = newStatus;
    if (newUtr && typeof newUtr === 'string') wth.txRef = newUtr.trim();
    wth.updatedAt = new Date().toISOString();
    wth.adminEdited = {
      adminId,
      editedAt: new Date().toISOString(),
      oldAmount,
      newAmount: numericAmount,
      reason
    };

    const user = state.users[affectedUserId];
    if (user && adjustUserBalance) {
      if (wth.status === 'pending') {
        if (delta < 0) {
          const reduction = Math.abs(delta);
          ledger.apply(state, {
            type: 'withdrawal_amount_reduced',
            userId: user.id,
            amount: reduction,
            availableDelta: reduction,
            pendingDelta: money.multiply(reduction, -1),
            refType: 'withdrawal',
            refId: wth.id,
            actorId: adminId,
            reason: reason || `Admin reduced withdrawal #${wth.id} from ₹${oldAmount} to ₹${numericAmount}`
          });
        } else if (delta > 0) {
          const addition = delta;
          if (user.balance < addition) {
            ledger.credit(state, user.id, money.subtract(addition, user.balance), {
              type: 'admin_credit_withdrawal_cover',
              refType: 'withdrawal',
              refId: wth.id,
              actorId: adminId,
              reason: 'Auto credit to cover withdrawal increase'
            });
          }
          ledger.apply(state, {
            type: 'withdrawal_amount_increased',
            userId: user.id,
            amount: addition,
            availableDelta: money.multiply(addition, -1),
            pendingDelta: addition,
            refType: 'withdrawal',
            refId: wth.id,
            actorId: adminId,
            reason: reason || `Admin increased withdrawal #${wth.id} from ₹${oldAmount} to ₹${numericAmount}`
          });
        }
      } else if (wth.status === 'completed' && delta !== 0) {
        if (delta > 0) {
          ledger.debit(state, user.id, delta, {
            type: 'admin_withdrawal_adjust_debit',
            refType: 'withdrawal',
            refId: wth.id,
            actorId: adminId,
            reason: reason || `Admin increased settled withdrawal #${wth.id} from ₹${oldAmount} to ₹${numericAmount}`
          });
        } else {
          ledger.credit(state, user.id, Math.abs(delta), {
            type: 'admin_withdrawal_adjust_credit',
            refType: 'withdrawal',
            refId: wth.id,
            actorId: adminId,
            reason: reason || `Admin reduced settled withdrawal #${wth.id} from ₹${oldAmount} to ₹${numericAmount}`
          });
        }
        user.totalWithdrawn = Math.max(0, money.add(user.totalWithdrawn || 0, delta));
      }
    }

    if (state.ledger?.entries) {
      const wthLedger = state.ledger.entries.find(
        e => e.refId === wth.id || e.refId === wth.withdrawalId
      );
      if (wthLedger) wthLedger.amount = numericAmount;
    }

    found = true;
    updatedRecord = wth;
  } else if (type === 'order') {
    const orderKey = Object.keys(state.claimedOrders || {}).find(
      k => k === cleanId || state.claimedOrders[k]?.buyId === cleanId || state.claimedOrders[k]?.orderNo === cleanId || state.claimedOrders[k]?.id === cleanId
    );
    if (!orderKey || !state.claimedOrders[orderKey]) {
      throw new Error(`Order "${id}" not found`);
    }
    const order = state.claimedOrders[orderKey];
    affectedUserId = order.userId;
    oldAmount = Number(order.amount) || 0;
    delta = money.subtract(numericAmount, oldAmount);

    order.amount = numericAmount;
    if (order.originalAmount == null) order.originalAmount = oldAmount;
    if (newStatus && typeof newStatus === 'string') order.status = newStatus;
    if (newUtr && typeof newUtr === 'string') order.utr = newUtr.trim();
    if (order.totalReward != null) {
      order.totalReward = Math.round(numericAmount * 0.05 * 100) / 100;
    }
    order.updatedAt = new Date().toISOString();
    order.adminEdited = {
      adminId,
      editedAt: new Date().toISOString(),
      oldAmount,
      newAmount: numericAmount,
      reason
    };

    const user = state.users[affectedUserId];
    if (user && Array.isArray(user.claimedOrders)) {
      const o = user.claimedOrders.find(
        x => x.buyId === cleanId || x.orderNo === cleanId || x.id === cleanId
      );
      if (o) {
        o.amount = numericAmount;
        if (order.totalReward != null) o.totalReward = order.totalReward;
        if (newStatus) o.status = newStatus;
      }
    }

    if (user && adjustUserBalance && order.status === 'completed' && delta !== 0) {
      if (delta > 0) {
        ledger.credit(state, user.id, delta, {
          type: 'admin_order_adjust_credit',
          refType: 'order',
          refId: order.buyId || order.id,
          actorId: adminId,
          reason: reason || `Admin adjusted match order amount from ₹${oldAmount} to ₹${numericAmount}`
        });
      } else {
        ledger.debit(state, user.id, Math.abs(delta), {
          type: 'admin_order_adjust_debit',
          refType: 'order',
          refId: order.buyId || order.id,
          actorId: adminId,
          reason: reason || `Admin adjusted match order amount from ₹${oldAmount} to ₹${numericAmount}`
        });
      }
    }

    found = true;
    updatedRecord = order;
  } else if (type === 'ledger') {
    if (state.ledger?.entries) {
      const entry = state.ledger.entries.find(e => e.id === cleanId);
      if (!entry) throw new Error(`Ledger entry "${id}" not found`);
      affectedUserId = entry.userId;
      oldAmount = Number(entry.amount) || 0;
      entry.amount = numericAmount;
      entry.updatedAt = new Date().toISOString();
      found = true;
      updatedRecord = entry;
    }
  } else {
    throw new Error(`Unsupported transaction type: "${type}"`);
  }

  if (!found) {
    throw new Error(`Transaction of type "${type}" with ID "${id}" was not found`);
  }

  db.save();

  if (affectedUserId && state.users[affectedUserId]) {
    const user = state.users[affectedUserId];
    try {
      const supabaseService = require('./supabaseService');
      supabaseService.syncUserData(user).catch(() => {});
    } catch (e) {}

    broadcast('BALANCE_UPDATED', {
      userId: user.id,
      balance: user.balance,
      totalBalance: user.totalBalance,
      delta,
      type: 'transaction_amount_adjusted'
    });
  }

  broadcast('TRANSACTION_UPDATED', {
    type,
    id: cleanId,
    userId: affectedUserId,
    oldAmount,
    newAmount: numericAmount,
    status: updatedRecord.status,
    adminId,
    timestamp: new Date().toISOString()
  });

  return {
    success: true,
    type,
    id: cleanId,
    oldAmount,
    newAmount: numericAmount,
    delta,
    status: updatedRecord.status,
    affectedUserId,
    userBalance: state.users[affectedUserId]?.balance
  };
}

/**
 * 10. GET ALL USERS FOR ADMIN: Full details, balances, order counts, deposit/withdrawal summaries
 */
function getAllUsersForAdmin(search = '') {
  const state = db.get();
  const users = Object.values(state.users || {});
  const cleanSearch = String(search || '').toLowerCase().trim();

  let list = users;
  if (cleanSearch) {
    list = list.filter(u =>
      String(u.id || '').toLowerCase().includes(cleanSearch) ||
      String(u.phone || '').toLowerCase().includes(cleanSearch) ||
      String(u.nickname || '').toLowerCase().includes(cleanSearch) ||
      String(u.inviteCode || '').toLowerCase().includes(cleanSearch)
    );
  }

  return list.map(u => {
    const userWallets = (state.wallets || []).filter(w => String(w.userId) === String(u.id));
    const userOrders = Object.values(state.claimedOrders || {}).filter(o => String(o.userId) === String(u.id));
    const userDeposits = Object.values(state.deposits || {}).filter(d => String(d.userId) === String(u.id));
    const userWithdrawals = Object.values(state.withdrawals || {}).filter(w => String(w.userId) === String(u.id));

    return {
      id: u.id,
      userId: u.userId || u.id,
      phone: u.phone || '',
      nickname: u.nickname || 'Trader',
      avatar: u.avatar || '/static/user/profile.png',
      balance: Number(u.balance) || 0,
      totalBalance: Number(u.totalBalance) || Number(u.balance) || 0,
      pendingWithdrawal: Number(u.pendingWithdrawal) || 0,
      totalDeposited: Number(u.totalDeposited) || 0,
      totalWithdrawn: Number(u.totalWithdrawn) || 0,
      rewardTotal: Number(u.rewardTotal) || 0,
      points: Number(u.points) || 0,
      vipLevel: u.vipLevel || 1,
      inviteCode: u.inviteCode || '',
      isPinSet: Boolean(u.pinHash && u.pinSalt),
      onSellStatus: u.onSellStatus !== undefined ? u.onSellStatus : 1,
      createdAt: u.createdAt || '',
      walletsCount: userWallets.length,
      ordersCount: userOrders.length,
      depositsCount: userDeposits.length,
      withdrawalsCount: userWithdrawals.length
    };
  }).sort((a, b) => (b.balance || 0) - (a.balance || 0));
}

/**
 * 11. GET USER DEEP DETAILS FOR ADMIN: Full profile, wallets, all transactions, ledger history
 */
function getUserDetailsForAdmin(userId) {
  if (!userId) throw new Error('User ID is required');
  const state = db.get();
  const user = state.users[userId];
  if (!user) throw new Error('User not found');

  const wallets = (state.wallets || []).filter(w => String(w.userId) === String(userId));
  const orders = Object.values(state.claimedOrders || {}).filter(o => String(o.userId) === String(userId));
  const deposits = Object.values(state.deposits || {}).filter(d => String(d.userId) === String(userId));
  const withdrawals = Object.values(state.withdrawals || {}).filter(w => String(w.userId) === String(userId));
  const ledgerEntries = (state.ledger && Array.isArray(state.ledger.entries))
    ? state.ledger.entries.filter(e => String(e.userId) === String(userId)).slice(-50)
    : [];

  return {
    user: {
      id: user.id,
      userId: user.userId || user.id,
      phone: user.phone || '',
      nickname: user.nickname || 'Trader',
      avatar: user.avatar || '/static/user/profile.png',
      balance: Number(user.balance) || 0,
      totalBalance: Number(user.totalBalance) || Number(user.balance) || 0,
      pendingWithdrawal: Number(user.pendingWithdrawal) || 0,
      totalDeposited: Number(user.totalDeposited) || 0,
      totalWithdrawn: Number(user.totalWithdrawn) || 0,
      rewardTotal: Number(user.rewardTotal) || 0,
      points: Number(user.points) || 0,
      vipLevel: user.vipLevel || 1,
      inviteCode: user.inviteCode || '',
      isPinSet: Boolean(user.pinHash && user.pinSalt),
      onSellStatus: user.onSellStatus !== undefined ? user.onSellStatus : 1,
      createdAt: user.createdAt || '',
      updatedAt: user.updatedAt || user.createdAt || ''
    },
    wallets,
    orders,
    deposits,
    withdrawals,
    ledgerEntries,
    unifiedTransactions: getUserUnifiedTransactions(userId)
  };
}

/**
 * 12. GET ALL UNIFIED TRANSACTIONS FOR ADMIN: Orders, Deposits, Withdrawals
 */
function getAllUnifiedTransactionsForAdmin({ type = 'all', status = 'all', search = '' } = {}) {
  const state = db.get();
  const cleanSearch = String(search || '').toLowerCase().trim();

  let list = [];

  if (type === 'all' || type === 'order') {
    for (const o of Object.values(state.claimedOrders || {})) {
      if (!o) continue;
      const u = state.users[o.userId];
      list.push({
        txType: 'order',
        id: o.buyId || o.id,
        orderNo: o.orderNo || o.buyId,
        userId: o.userId,
        userNickname: u ? u.nickname : o.userNickname || 'Trader',
        userPhone: u ? u.phone : o.userPhone || '',
        amount: Number(o.amount) || 0,
        reward: Number(o.totalReward || o.reward) || 0,
        status: o.status,
        utr: o.utr || null,
        payoutAccount: o.payoutAccount || '',
        rejectReason: o.rejectReason || null,
        createdAt: o.createdAt,
        updatedAt: o.completedAt || o.submittedAt || o.createdAt
      });
    }
  }

  if (type === 'all' || type === 'deposit') {
    for (const d of Object.values(state.deposits || {})) {
      if (!d) continue;
      const u = state.users[d.userId];
      list.push({
        txType: 'deposit',
        id: d.id || d.depositId,
        orderNo: d.depositId || d.id,
        userId: d.userId,
        userNickname: u ? u.nickname : d.userNickname || 'Trader',
        userPhone: u ? u.phone : d.userPhone || '',
        amount: Number(d.amount) || 0,
        reward: 0,
        status: d.status,
        utr: d.utr || null,
        payoutAccount: d.payeeVpa || '',
        rejectReason: d.rejectReason || null,
        createdAt: d.createdAt,
        updatedAt: d.verifiedAt || d.submittedAt || d.createdAt
      });
    }
  }

  if (type === 'all' || type === 'withdrawal') {
    for (const w of Object.values(state.withdrawals || {})) {
      if (!w) continue;
      const u = state.users[w.userId];
      const accountDesc = w.payoutType === 'bank'
        ? `${w.payoutDetails?.bankName || 'Bank'}: ${w.payoutDetails?.accountNumber || ''} (${w.payoutDetails?.ifsc || ''})`
        : `UPI: ${w.payoutDetails?.upiId || ''}`;
      list.push({
        txType: 'withdrawal',
        id: w.id || w.withdrawalId,
        orderNo: w.withdrawalId || w.id,
        userId: w.userId,
        userNickname: u ? u.nickname : w.userNickname || 'Trader',
        userPhone: u ? u.phone : w.userPhone || '',
        amount: Number(w.amount) || 0,
        originalAmount: w.originalAmount ? Number(w.originalAmount) : null,
        modificationReason: w.modificationReason || null,
        reward: 0,
        status: w.status,
        payoutType: w.payoutType,
        payoutDetails: w.payoutDetails,
        payoutAccount: accountDesc,
        txRef: w.txRef || null,
        rejectReason: w.rejectReason || null,
        createdAt: w.createdAt,
        updatedAt: w.processedAt || w.amountModifiedAt || w.createdAt
      });
    }
  }

  if (status && status !== 'all') {
    list = list.filter(t => t.status === status);
  }

  if (cleanSearch) {
    list = list.filter(t =>
      String(t.id || '').toLowerCase().includes(cleanSearch) ||
      String(t.orderNo || '').toLowerCase().includes(cleanSearch) ||
      String(t.userId || '').toLowerCase().includes(cleanSearch) ||
      String(t.userPhone || '').toLowerCase().includes(cleanSearch) ||
      String(t.userNickname || '').toLowerCase().includes(cleanSearch) ||
      String(t.utr || '').toLowerCase().includes(cleanSearch) ||
      String(t.txRef || '').toLowerCase().includes(cleanSearch) ||
      String(t.payoutAccount || '').toLowerCase().includes(cleanSearch)
    );
  }

  list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return list;
}

/**
 * 13. ERASE USER: Completely erase the user and all their records from app & database
 */
function eraseUser({ userId, adminId = 'admin' }) {
  if (!userId) throw new Error('User ID is required');
  const state = db.get();
  let user = state.users[userId];
  let resolvedUserId = String(userId);

  if (!user) {
    const foundEntry = Object.entries(state.users || {}).find(([k, u]) =>
      k === String(userId) ||
      (u && String(u.id) === String(userId)) ||
      (u && String(u.userId) === String(userId)) ||
      (u && String(u.phone) === String(userId))
    );
    if (foundEntry) {
      resolvedUserId = foundEntry[0];
      user = foundEntry[1];
    }
  }
  if (!user) throw new Error(`User "${userId}" not found in database`);

  const canonicalId = String(user.id || user.userId || resolvedUserId);
  const deletedNickname = user.nickname || 'Trader';
  const deletedPhone = user.phone || '';

  // 1. Remove user record under all known keys
  delete state.users[resolvedUserId];
  if (user.id && state.users[user.id]) delete state.users[user.id];
  if (user.userId && state.users[user.userId]) delete state.users[user.userId];

  // 2. Remove all user's bound wallets
  if (Array.isArray(state.wallets)) {
    state.wallets = state.wallets.filter(w =>
      String(w.userId) !== canonicalId && String(w.userId) !== String(userId)
    );
  }

  // 3. Clean up user's claimed match orders
  let deletedOrdersCount = 0;
  if (state.claimedOrders && typeof state.claimedOrders === 'object') {
    for (const [buyId, order] of Object.entries(state.claimedOrders)) {
      if (order && (String(order.userId) === canonicalId || String(order.userId) === String(userId))) {
        if (order.status === 'pending' || order.status === 'verifying') {
          const hangSale = (state.hangSales || []).find(
            h => h.payOrderId === order.payOrderId || h.orderNo === order.orderNo
          );
          if (hangSale && hangSale.status === 'processing') {
            hangSale.status = 'pending';
          }
        }
        delete state.claimedOrders[buyId];
        deletedOrdersCount++;
      }
    }
  }

  // 4. Remove all user's deposits
  let deletedDepositsCount = 0;
  if (state.deposits && typeof state.deposits === 'object') {
    for (const [depId, dep] of Object.entries(state.deposits)) {
      if (dep && (String(dep.userId) === canonicalId || String(dep.userId) === String(userId))) {
        delete state.deposits[depId];
        deletedDepositsCount++;
      }
    }
  }

  // 5. Remove all user's withdrawals
  let deletedWithdrawalsCount = 0;
  if (state.withdrawals && typeof state.withdrawals === 'object') {
    for (const [wthId, wth] of Object.entries(state.withdrawals)) {
      if (wth && (String(wth.userId) === canonicalId || String(wth.userId) === String(userId))) {
        delete state.withdrawals[wthId];
        deletedWithdrawalsCount++;
      }
    }
  }

  // 6. Clean up user's ledger entries and idempotency keys
  let deletedLedgerCount = 0;
  if (state.ledger && Array.isArray(state.ledger.entries)) {
    const userEntries = state.ledger.entries.filter(e =>
      String(e.userId) === canonicalId || String(e.userId) === String(userId)
    );
    state.ledger.entries = state.ledger.entries.filter(e =>
      String(e.userId) !== canonicalId && String(e.userId) !== String(userId)
    );
    deletedLedgerCount = userEntries.length;
    if (state.ledger.idempotency) {
      for (const entry of userEntries) {
        if (entry.idempotencyKey) {
          delete state.ledger.idempotency[entry.idempotencyKey];
        }
      }
    }
  }

  // 7. Revoke active tokens for this user
  if (!state.revokedTokens) state.revokedTokens = {};
  state.revokedTokens[canonicalId] = Date.now() + 30 * 24 * 60 * 60 * 1000;
  if (userId !== canonicalId) {
    state.revokedTokens[userId] = Date.now() + 30 * 24 * 60 * 60 * 1000;
  }

  db.save();

  // 8. Delete from Supabase Auth if integrated
  try {
    const supabaseService = require('./supabaseService');
    if (typeof supabaseService.deleteUserRecord === 'function') {
      supabaseService.deleteUserRecord(canonicalId).catch(() => {});
    }
  } catch (e) {}

  // 9. Broadcast real-time deletion
  broadcast('USER_DELETED', {
    userId: canonicalId,
    adminId,
    timestamp: new Date().toISOString()
  });

  return {
    success: true,
    userId: canonicalId,
    deletedNickname,
    deletedPhone,
    stats: {
      deletedOrdersCount,
      deletedDepositsCount,
      deletedWithdrawalsCount,
      deletedLedgerCount
    }
  };
}

module.exports = {
  createDeposit,
  submitDepositUtr,
  verifyDeposit,
  requestWithdrawal,
  verifyWithdrawal,
  editWithdrawalAmount,
  adjustUserBalance,
  updateUserDetails,
  eraseUser,
  deleteTransaction,
  editTransaction,
  getAllUsersForAdmin,
  getUserDetailsForAdmin,
  getAllUnifiedTransactionsForAdmin,
  getPendingDeposits,
  getAllDepositsForAdmin,
  getPendingWithdrawals,
  getAllWithdrawalsForAdmin,
  getUserDeposits,
  getUserWithdrawals,
  getUserUnifiedTransactions,
  setBroadcaster
};

