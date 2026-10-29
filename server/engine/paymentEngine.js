const db = require('./db');
const qrService = require('./qrService');
const security = require('./security');
const money = require('./money');

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
 * Get active official receiving wallet for deposits
 */
function getOfficialReceivingWallet(state) {
  const wallets = state.wallets || [];
  // Prefer system official wallet
  const official = wallets.find(w => w.isOfficial && w.status === 1) ||
                   wallets.find(w => w.status === 1) ||
                   wallets[0];

  if (official) {
    return {
      walletId: official.id,
      vpa: official.account || official.vpa || '9588856526@ybl',
      name: official.name || 'TradePay Official',
      qrImage: official.qrImage || '/static/qr/scr2.jpeg'
    };
  }

  return {
    walletId: 1,
    vpa: '9588856526@ybl',
    name: 'TradePay Official',
    qrImage: '/static/qr/scr2.jpeg'
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
    deposit.status = 'completed';
    deposit.verifiedAt = new Date().toISOString();
    deposit.verifiedBy = String(adminId);

    // Credit user's available balance and total balance
    user.balance = money.add(user.balance || 0, deposit.amount);
    user.totalBalance = user.balance;
    user.totalDeposited = money.add(user.totalDeposited || 0, deposit.amount);

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

  // Verify PIN if configured
  if (user.isPinSet && user.pinHash && user.pinSalt) {
    if (!pin) {
      throw new Error('Payment Security PIN is required for withdrawals');
    }
    const pinValid = security.verifyPin(pin, user.pinHash, user.pinSalt);
    if (!pinValid) {
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

  // Deduct immediately from available balance to prevent double-spending
  user.balance = money.subtract(user.balance, numericAmount);
  user.totalBalance = user.balance;
  user.pendingWithdrawal = money.add(user.pendingWithdrawal || 0, numericAmount);

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
    withdrawal.status = 'completed';
    withdrawal.txRef = String(txRef || `PAY${Date.now()}`).trim();
    withdrawal.processedAt = new Date().toISOString();
    withdrawal.processedBy = String(adminId);

    // Update user pending withdrawal and total withdrawn
    user.pendingWithdrawal = money.subtract(user.pendingWithdrawal || 0, withdrawal.amount);
    user.totalWithdrawn = money.add(user.totalWithdrawn || 0, withdrawal.amount);

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
      msg: `Withdrawal of ₹${withdrawal.amount} completed! Funds transferred via ${withdrawal.payoutType.toUpperCase()} (Ref: ${withdrawal.txRef}).`
    });

    return withdrawal;
  } else if (action === 'reject') {
    withdrawal.status = 'rejected';
    withdrawal.rejectReason = String(reason || 'Payment could not be completed / invalid payout details').slice(0, 200);
    withdrawal.processedAt = new Date().toISOString();
    withdrawal.processedBy = String(adminId);

    // AUTOMATIC REFUND BACK TO USER BALANCE
    user.balance = money.add(user.balance || 0, withdrawal.amount);
    user.totalBalance = user.balance;
    user.pendingWithdrawal = money.subtract(user.pendingWithdrawal || 0, withdrawal.amount);

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

module.exports = {
  createDeposit,
  submitDepositUtr,
  verifyDeposit,
  requestWithdrawal,
  verifyWithdrawal,
  getPendingDeposits,
  getAllDepositsForAdmin,
  getPendingWithdrawals,
  getAllWithdrawalsForAdmin,
  getUserDeposits,
  getUserWithdrawals,
  getUserUnifiedTransactions,
  setBroadcaster
};

