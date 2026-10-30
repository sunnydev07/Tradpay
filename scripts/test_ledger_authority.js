const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tradepay-ledger-'));
process.env.TRADEPAY_DB_FILE = path.join(tmpDir, 'db.json');
process.env.ALLOW_SIMULATION = 'false';
process.env.NODE_ENV = 'test';

const db = require('../server/engine/db');
const ledger = require('../server/engine/ledger');
const auth = require('../server/engine/auth');
const supabaseService = require('../server/engine/supabaseService');
const paymentEngine = require('../server/engine/paymentEngine');
const security = require('../server/engine/security');

test.after(() => {
  try { db.flush(); } catch (e) { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

function fakeToken(subject) {
  const payload = Buffer.from(JSON.stringify({
    sub: subject,
    exp: Math.floor(Date.now() / 1000) + 3600
  })).toString('base64url');
  return `header.${payload}.signature`;
}

async function withVerifiedUser(user, run) {
  const original = supabaseService.verifyToken;
  supabaseService.verifyToken = async () => user;
  try {
    return await run();
  } finally {
    supabaseService.verifyToken = original;
  }
}

test('new local accounts ignore hostile Supabase metadata', async () => {
  db.reset();
  auth.clearAuthCache();

  const hostile = {
    id: 'hostile-user-1',
    email: 'hostile@example.com',
    phone: '9999999999',
    nickname: 'Hostile',
    avatar: '/static/user/profile.png',
    createdAt: new Date().toISOString(),
    // Everything below is user-writable metadata and must be ignored.
    balance: 1000000000,
    totalBalance: 1000000000,
    rewardTotal: 1000000000,
    pending: 500000,
    points: 999999,
    vipLevel: 99,
    inviteCode: 'HACKED',
    isPinSet: true,
    pinHash: 'deadbeef',
    pinSalt: 'deadbeef',
    wallets: [{ id: 999, userId: 'hostile-user-1', account: 'attacker@upi', status: 1 }],
    claimedOrders: ['forged-order'],
    claimedMissions: [1, 2, 3, 4],
    newcomerRewardClaimed: true
  };

  const user = await withVerifiedUser(hostile, () =>
    auth.authenticateToken(fakeToken('hostile-user-1'))
  );

  assert.ok(user);
  assert.equal(user.balance, 0);
  assert.equal(user.totalBalance, 0);
  assert.equal(user.rewardTotal, 0);
  assert.equal(user.pending, 0);
  assert.equal(user.points, 0);
  assert.equal(user.vipLevel, 1);
  assert.equal(user.isPinSet, false);
  assert.equal(user.pinHash, null);
  assert.equal(user.pinSalt, null);
  assert.deepEqual(user.wallets, []);
  assert.deepEqual(user.claimedOrders, []);
  assert.deepEqual(user.claimedMissions, []);
  assert.equal(user.newcomerRewardClaimed, false);
  assert.notEqual(user.inviteCode, 'HACKED');
  assert.match(user.inviteCode, /^LP/);
  assert.equal(user.ledgerBaseline, 0);
});

test('existing server balances and PINs are never overwritten by metadata', async () => {
  db.reset();
  auth.clearAuthCache();

  const state = db.get();
  const hashed = security.hashPin('654321');
  state.users['existing-user-1'] = {
    id: 'existing-user-1',
    userId: 'existing-user-1',
    phone: '9876543210',
    nickname: 'Existing',
    avatar: '/static/user/profile.png',
    balance: 500,
    totalBalance: 500,
    rewardTotal: 0,
    pendingWithdrawal: 0,
    pinHash: hashed.hash,
    pinSalt: hashed.salt,
    isPinSet: true,
    wallets: [],
    claimedOrders: [],
    ledgerBaseline: 500
  };

  const metadata = {
    id: 'existing-user-1',
    email: 'existing@example.com',
    phone: '9876543210',
    nickname: 'Renamed',
    avatar: '/static/user/profile.png',
    createdAt: new Date().toISOString(),
    balance: 0,
    isPinSet: false,
    wallets: [{ id: 777, userId: 'existing-user-1', account: 'wrong@upi', status: 1 }],
    claimedOrders: ['forged-order']
  };

  const user = await withVerifiedUser(metadata, () =>
    auth.authenticateToken(fakeToken('existing-user-1'))
  );

  assert.equal(user.balance, 500, 'local ledger balance must win');
  assert.equal(user.totalBalance, 500);
  assert.equal(user.isPinSet, true, 'PIN flag must be derived from the local hash');
  assert.equal(security.verifyPin('654321', user), true);
  assert.equal(security.verifyPin('000000', user), false);
  assert.equal(user.nickname, 'Renamed', 'display fields may still refresh');
  assert.deepEqual(user.wallets, []);
  assert.deepEqual(user.claimedOrders, []);

  const ledgerUser = db.get().users['existing-user-1'];
  assert.equal(ledgerUser.inviteCode.length >= 4, true);
});

test('Supabase sync payload contains display fields only', () => {
  const payload = supabaseService.buildSyncPayload({
    nickname: 'Trader',
    phone: '9876543210',
    avatar: '/static/user/profile.png',
    balance: 999999,
    totalBalance: 999999,
    rewardTotal: 999999,
    pending: 10,
    points: 50,
    vipLevel: 9,
    inviteCode: 'LP9999',
    isPinSet: true,
    pinHash: 'secret-hash',
    pinSalt: 'secret-salt',
    wallets: [{ account: 'attacker@upi' }],
    claimedOrders: ['forged'],
    claimedMissions: [1, 2],
    newcomerRewardClaimed: true
  });

  assert.deepEqual(Object.keys(payload).sort(), ['avatar', 'nickname', 'phone', 'updatedAt']);
  for (const forbidden of [
    'balance', 'totalBalance', 'rewardTotal', 'pending', 'points', 'vipLevel',
    'inviteCode', 'isPinSet', 'pinHash', 'pinSalt', 'wallets', 'claimedOrders',
    'claimedMissions', 'newcomerRewardClaimed'
  ]) {
    assert.equal(payload[forbidden], undefined, `${forbidden} must not be synced`);
  }
});

test('withdrawals fail closed when the PIN flag has no hash and work with the correct PIN', () => {
  db.reset();
  const state = db.get();
  const userId = 'pin-user-1';
  state.users[userId] = {
    id: userId,
    userId,
    phone: '9876543210',
    nickname: 'PinUser',
    balance: 1000,
    totalBalance: 1000,
    pendingWithdrawal: 0,
    pinHash: null,
    pinSalt: null,
    isPinSet: true, // stale flag, for example from old metadata
    wallets: [],
    claimedOrders: [],
    ledgerBaseline: 1000
  };

  assert.throws(
    () => paymentEngine.requestWithdrawal({
      userId,
      amount: 100,
      payoutType: 'upi',
      payoutDetails: { upiId: 'pin@upi' },
      pin: '123456'
    }),
    /PIN is not configured correctly/
  );

  const hashed = security.hashPin('123456');
  state.users[userId].pinHash = hashed.hash;
  state.users[userId].pinSalt = hashed.salt;
  state.users[userId].isPinSet = true;

  assert.throws(
    () => paymentEngine.requestWithdrawal({
      userId,
      amount: 100,
      payoutType: 'upi',
      payoutDetails: { upiId: 'pin@upi' },
      pin: '000000'
    }),
    /Invalid Payment Security PIN/
  );

  const withdrawal = paymentEngine.requestWithdrawal({
    userId,
    amount: 100,
    payoutType: 'upi',
    payoutDetails: { upiId: 'pin@upi' },
    pin: '123456'
  });

  assert.equal(state.users[userId].balance, 900);
  assert.equal(state.users[userId].pendingWithdrawal, 100);

  paymentEngine.verifyWithdrawal({
    withdrawalId: withdrawal.id,
    adminId: 'admin-1',
    action: 'confirm',
    txRef: 'PAYREF123'
  });

  assert.equal(state.users[userId].balance, 900);
  assert.equal(state.users[userId].pendingWithdrawal, 0);
  assert.equal(state.users[userId].totalWithdrawn, 100);
  assert.equal(ledger.reconcileUser(state, userId).matches, true);
});

test('ledger entries are idempotent, enforce funds and reconcile exactly', () => {
  db.reset();
  const state = db.get();
  const userId = 'ledger-user-1';
  state.users[userId] = {
    id: userId,
    userId,
    balance: 0,
    totalBalance: 0,
    pendingWithdrawal: 0,
    wallets: [],
    claimedOrders: [],
    ledgerBaseline: 0
  };

  const first = ledger.credit(state, userId, 100.25, {
    type: 'test_credit',
    idempotencyKey: 'test-credit-1'
  });
  const second = ledger.credit(state, userId, 100.25, {
    type: 'test_credit',
    idempotencyKey: 'test-credit-1'
  });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(state.users[userId].balance, 100.25);
  assert.equal(state.ledger.entries.length, 1);

  ledger.debit(state, userId, 0.25, {
    type: 'test_debit',
    idempotencyKey: 'test-debit-1'
  });
  assert.equal(state.users[userId].balance, 100);

  assert.throws(
    () => ledger.debit(state, userId, 1000, {
      type: 'test_debit',
      idempotencyKey: 'test-debit-2'
    }),
    /Insufficient available balance/
  );

  ledger.hold(state, userId, 40, {
    type: 'test_hold',
    idempotencyKey: 'test-hold-1'
  });
  assert.equal(state.users[userId].balance, 60);
  assert.equal(state.users[userId].pendingWithdrawal, 40);

  ledger.refund(state, userId, 40, {
    type: 'test_refund',
    idempotencyKey: 'test-refund-1'
  });
  assert.equal(state.users[userId].balance, 100);
  assert.equal(state.users[userId].pendingWithdrawal, 0);

  const reconciliation = ledger.reconcileUser(state, userId);
  assert.equal(reconciliation.matches, true);
  assert.equal(reconciliation.actual, 100);
  assert.equal(reconciliation.entryCount, 4);
});

test('deposit verification credits through the ledger exactly once', async () => {
  db.reset();
  const state = db.get();
  const userId = 'deposit-user-1';
  state.users[userId] = {
    id: userId,
    userId,
    balance: 0,
    totalBalance: 0,
    totalDeposited: 0,
    pendingWithdrawal: 0,
    wallets: [],
    claimedOrders: [],
    ledgerBaseline: 0
  };

  const deposit = await paymentEngine.createDeposit({ userId, amount: 500 });
  paymentEngine.submitDepositUtr({
    depositId: deposit.id,
    utr: '123456789012',
    userId
  });

  paymentEngine.verifyDeposit({
    depositId: deposit.id,
    adminId: 'admin-1',
    action: 'confirm'
  });

  assert.equal(state.users[userId].balance, 500);
  assert.equal(state.users[userId].totalDeposited, 500);
  const entries = state.ledger.entries.filter(e => e.refId === deposit.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, 'deposit_credit');
  assert.equal(ledger.reconcileUser(state, userId).matches, true);

  assert.throws(
    () => paymentEngine.verifyDeposit({
      depositId: deposit.id,
      adminId: 'admin-1',
      action: 'confirm'
    }),
    /cannot be verified/
  );
  assert.equal(state.users[userId].balance, 500);
});
