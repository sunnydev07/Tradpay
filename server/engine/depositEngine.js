const db = require('./db');
const money = require('./money');
const security = require('./security');

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function findDeposit(state, depositId) {
  return (state.deposits || []).find(d => d.id === String(depositId || ''));
}

function depositView(deposit) {
  if (!deposit) return null;
  const fields = [
    'id', 'userId', 'amount', 'qrId', 'vpa', 'utr', 'status', 'source',
    'createdAt', 'verifiedAt', 'verifiedBy', 'rejectedAt', 'rejectedBy',
    'rejectReason', 'providerId', 'eventId'
  ];
  const out = {};
  for (const field of fields) {
    if (deposit[field] !== undefined) out[field] = deposit[field];
  }
  return out;
}

function creditUser(state, userId, amount) {
  const user = state.users[userId];
  if (!user) throw httpError('Deposit user not found', 404);
  user.balance = money.add(user.balance, amount);
  user.totalBalance = user.balance;
  return user;
}

function creditDeposit(state, deposit, meta = {}) {
  if (deposit.status !== 'pending') {
    throw httpError(`Deposit cannot be credited from status "${deposit.status}"`, 409);
  }

  const credited = creditUser(state, deposit.userId, deposit.amount);
  deposit.status = 'completed';
  deposit.verifiedAt = new Date().toISOString();
  deposit.verifiedBy = meta.verifiedBy || 'system';
  deposit.source = meta.source || 'admin';
  if (meta.providerId) deposit.providerId = String(meta.providerId).slice(0, 200);
  if (meta.eventId) deposit.eventId = String(meta.eventId).slice(0, 200);
  db.save();
  try {
    const supabaseService = require('./supabaseService');
    supabaseService.syncUserData(credited).catch(() => {});
  } catch (e) {}
  return depositView(deposit);
}

function createDeposit({ userId, amount, qrId, vpa, utr, autoCredit = false }) {
  if (!userId) throw httpError('Authentication required', 401);

  const numAmount = Number(amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0 || numAmount > 10000000) {
    throw httpError('Please enter a valid deposit amount', 400);
  }

  const cleanUtr = String(utr || '').trim();
  if (!security.isValidUtr(cleanUtr)) {
    throw httpError('Please enter a valid 12-digit bank UTR reference', 400);
  }

  const state = db.get();
  const duplicateUtr = (state.deposits || []).some(d => String(d.utr) === cleanUtr) ||
    Object.values(state.claimedOrders).some(o => o.utr && String(o.utr) === cleanUtr);
  if (duplicateUtr) {
    throw httpError('This UTR has already been submitted', 409);
  }

  const deposit = {
    id: 'DEP' + Date.now() + Math.floor(Math.random() * 1000),
    userId: String(userId),
    amount: money.fromPaise(money.toPaise(numAmount)),
    qrId: Number(qrId),
    vpa: String(vpa || ''),
    utr: cleanUtr,
    status: 'pending',
    source: 'user',
    createdAt: new Date().toISOString()
  };

  state.deposits.push(deposit);

  if (autoCredit) {
    // Explicit local-development opt-in only; production requires verification.
    return creditDeposit(state, deposit, { verifiedBy: 'system', source: 'auto' });
  }

  db.save();
  return depositView(deposit);
}

function listUserDeposits(userId) {
  const state = db.get();
  return (state.deposits || [])
    .filter(d => String(d.userId) === String(userId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(depositView);
}

function listAllDeposits({ status = '' } = {}) {
  const state = db.get();
  const normalized = String(status || '').toLowerCase();
  const allowed = new Set(['pending', 'completed', 'rejected']);
  if (normalized && !allowed.has(normalized)) {
    throw httpError('Invalid deposit status filter', 400);
  }

  return (state.deposits || [])
    .filter(d => !normalized || d.status === normalized)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(d => {
      const user = state.users[d.userId] || {};
      return {
        ...depositView(d),
        user: {
          id: user.id || d.userId,
          nickname: user.nickname || '',
          phone: user.phone || ''
        }
      };
    });
}

function approveDeposit(depositId, adminId) {
  const state = db.get();
  const deposit = findDeposit(state, depositId);
  if (!deposit) throw httpError('Deposit not found', 404);
  if (deposit.status === 'completed') throw httpError('Deposit already approved', 409);
  if (deposit.status === 'rejected') throw httpError('Deposit was rejected; it cannot be approved', 409);

  return creditDeposit(state, deposit, {
    verifiedBy: String(adminId || 'admin'),
    source: 'admin'
  });
}

function rejectDeposit(depositId, adminId, reason = '') {
  const state = db.get();
  const deposit = findDeposit(state, depositId);
  if (!deposit) throw httpError('Deposit not found', 404);
  if (deposit.status === 'completed') throw httpError('Deposit already approved; it cannot be rejected', 409);
  if (deposit.status === 'rejected') throw httpError('Deposit already rejected', 409);

  deposit.status = 'rejected';
  deposit.rejectedAt = new Date().toISOString();
  deposit.rejectedBy = String(adminId || 'admin');
  deposit.rejectReason = String(reason || 'Rejected by administrator').slice(0, 200);
  db.save();
  return depositView(deposit);
}

// Provider-agnostic reconciliation used by the signed payment webhook.
// A webhook may be retried, so a completed deposit is reported as a duplicate
// instead of being credited twice.
function reconcileDeposit({ utr, amount, providerId = '', eventId = '' }) {
  const cleanUtr = String(utr || '').trim();
  if (!security.isValidUtr(cleanUtr)) {
    throw httpError('A valid 12-digit UTR is required', 400);
  }

  const numAmount = Number(amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    throw httpError('A valid payment amount is required', 400);
  }

  const state = db.get();
  const deposit = (state.deposits || []).find(d => String(d.utr) === cleanUtr);
  if (!deposit) {
    return { matched: false, credited: false, deposit: null };
  }

  if (deposit.status === 'completed') {
    return { matched: true, credited: false, duplicate: true, deposit: depositView(deposit) };
  }
  if (deposit.status !== 'pending') {
    throw httpError(`Deposit is ${deposit.status} and cannot be reconciled`, 409);
  }
  if (!money.equals(deposit.amount, numAmount)) {
    throw httpError('Webhook amount does not match the deposit amount', 409);
  }

  const credited = creditDeposit(state, deposit, {
    verifiedBy: 'psp-webhook',
    source: 'webhook',
    providerId,
    eventId
  });

  return { matched: true, credited: true, deposit: credited };
}

module.exports = {
  createDeposit,
  listUserDeposits,
  listAllDeposits,
  approveDeposit,
  rejectDeposit,
  reconcileDeposit,
  depositView
};
