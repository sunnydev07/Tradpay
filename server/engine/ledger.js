const crypto = require('crypto');
const money = require('./money');

// The ledger is the single source of truth for money movements. Balances on
// user records are a cached projection of the entries in this ledger; they are
// never imported from Supabase user_metadata or supplied by a client.
//
// Entries are append-only. Idempotency keys make money operations safe to
// retry (admin double-click, network retry, duplicated webhook, etc.).

const MAX_AMOUNT_PAISE = 1000000000000; // ₹10,00,00,00,000 safety ceiling

function ensureState(state) {
  if (!state || typeof state !== 'object') throw new Error('Ledger state is unavailable');
  if (!state.ledger || typeof state.ledger !== 'object') state.ledger = {};
  if (!Array.isArray(state.ledger.entries)) state.ledger.entries = [];
  if (!state.ledger.idempotency || typeof state.ledger.idempotency !== 'object') {
    state.ledger.idempotency = {};
  }
  return state.ledger;
}

function newEntryId() {
  return `LED${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
}

function userEntries(state, userId) {
  ensureState(state);
  return state.ledger.entries.filter(entry => String(entry.userId) === String(userId));
}

/**
 * Establish the opening balance for accounts created before the ledger existed.
 * baseline = current balance - sum(already recorded entries), so reconciliation
 * remains exact without rewriting historical entries.
 */
function ensureBaseline(state, user) {
  if (!user) return 0;
  if (user.ledgerBaseline != null && Number.isFinite(Number(user.ledgerBaseline))) {
    return Number(user.ledgerBaseline);
  }
  const recordedPaise = userEntries(state, user.id).reduce(
    (sum, entry) => sum + (Number(entry.availableDeltaPaise) || 0),
    0
  );
  const baseline = money.subtract(Number(user.balance) || 0, money.fromPaise(recordedPaise));
  user.ledgerBaseline = baseline;
  return baseline;
}

function apply(state, {
  userId,
  type,
  amount,
  availableDelta,
  pendingDelta = 0,
  refType = null,
  refId = null,
  idempotencyKey = null,
  actorId = null,
  meta = null
}) {
  ensureState(state);
  if (!userId) throw new Error('Ledger entry requires a user');
  if (!type || typeof type !== 'string') throw new Error('Ledger entry requires a type');

  const user = state.users && state.users[userId];
  if (!user) throw new Error('Ledger account not found');

  const amountPaise = money.toPaise(amount);
  if (!Number.isFinite(amountPaise) || amountPaise <= 0 || amountPaise > MAX_AMOUNT_PAISE) {
    throw new Error('Ledger amount must be a positive, finite value');
  }

  const availableDeltaPaise = money.toPaise(availableDelta);
  const pendingDeltaPaise = money.toPaise(pendingDelta);
  if (!Number.isFinite(availableDeltaPaise) || Math.abs(availableDeltaPaise) > MAX_AMOUNT_PAISE) {
    throw new Error('Invalid ledger available-balance delta');
  }

  const key = String(
    idempotencyKey || `${type}:${refType || 'none'}:${refId || crypto.randomUUID()}`
  );

  const existingId = state.ledger.idempotency[key];
  if (existingId) {
    const existing = state.ledger.entries.find(entry => entry.id === existingId);
    if (existing) {
      if (String(existing.userId) !== String(userId) || Number(existing.amountPaise) !== amountPaise) {
        throw new Error('Idempotency key was reused for a different ledger entry');
      }
      return { entry: existing, duplicate: true };
    }
    // Rebuild a missing index instead of silently double-crediting.
    delete state.ledger.idempotency[key];
  }

  ensureBaseline(state, user);

  const balanceBeforePaise = money.toPaise(user.balance || 0);
  const pendingBeforePaise = money.toPaise(user.pendingWithdrawal || 0);
  const balanceAfterPaise = balanceBeforePaise + availableDeltaPaise;
  const pendingAfterPaise = pendingBeforePaise + pendingDeltaPaise;

  if (balanceAfterPaise < 0) {
    throw new Error('Insufficient available balance');
  }
  if (pendingAfterPaise < 0) {
    throw new Error('Pending withdrawal balance is out of sync');
  }

  user.balance = money.fromPaise(balanceAfterPaise);
  user.totalBalance = user.balance;
  user.pendingWithdrawal = money.fromPaise(pendingAfterPaise);

  const entry = {
    id: newEntryId(),
    userId: String(userId),
    type,
    amount: money.fromPaise(amountPaise),
    amountPaise,
    availableDelta: money.fromPaise(availableDeltaPaise),
    availableDeltaPaise,
    pendingDelta: money.fromPaise(pendingDeltaPaise),
    pendingDeltaPaise,
    balanceBefore: money.fromPaise(balanceBeforePaise),
    balanceAfter: user.balance,
    pendingBefore: money.fromPaise(pendingBeforePaise),
    pendingAfter: user.pendingWithdrawal,
    refType,
    refId: refId == null ? null : String(refId),
    idempotencyKey: key,
    actorId: actorId == null ? null : String(actorId),
    meta: meta && typeof meta === 'object' ? meta : null,
    createdAt: new Date().toISOString()
  };

  state.ledger.entries.push(entry);
  state.ledger.idempotency[key] = entry.id;

  return { entry, duplicate: false };
}

function credit(state, userId, amount, options = {}) {
  return apply(state, {
    ...options,
    userId,
    amount,
    availableDelta: amount,
    pendingDelta: 0
  });
}

function debit(state, userId, amount, options = {}) {
  return apply(state, {
    ...options,
    userId,
    amount,
    availableDelta: money.multiply(amount, -1),
    pendingDelta: 0
  });
}

// Move money from available balance into the pending-withdrawal bucket.
function hold(state, userId, amount, options = {}) {
  return apply(state, {
    ...options,
    userId,
    amount,
    availableDelta: money.multiply(amount, -1),
    pendingDelta: amount
  });
}

// The payout was sent: release the hold without changing available balance.
function settle(state, userId, amount, options = {}) {
  return apply(state, {
    ...options,
    userId,
    amount,
    availableDelta: 0,
    pendingDelta: money.multiply(amount, -1)
  });
}

// The payout failed: return held money to the available balance.
function refund(state, userId, amount, options = {}) {
  return apply(state, {
    ...options,
    userId,
    amount,
    availableDelta: amount,
    pendingDelta: money.multiply(amount, -1)
  });
}

function reconcileUser(state, userId) {
  ensureState(state);
  const user = state.users && state.users[userId];
  if (!user) throw new Error('Ledger account not found');
  const baseline = ensureBaseline(state, user);
  const entries = userEntries(state, userId);
  const deltaPaise = entries.reduce(
    (sum, entry) => sum + (Number(entry.availableDeltaPaise) || 0),
    0
  );
  const expected = money.add(baseline, money.fromPaise(deltaPaise));
  return {
    userId: String(userId),
    expected,
    actual: Number(user.balance) || 0,
    matches: money.equals(expected, user.balance),
    entryCount: entries.length
  };
}

function reconcileAll(state) {
  ensureState(state);
  return Object.keys(state.users || {}).map(userId => reconcileUser(state, userId));
}

module.exports = {
  ensureState,
  ensureBaseline,
  apply,
  credit,
  debit,
  hold,
  settle,
  refund,
  reconcileUser,
  reconcileAll
};
