const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tradepay-deposit-safety-'));
process.env.TRADEPAY_DB_FILE = path.join(tmpDir, 'db.json');
process.env.ALLOW_SIMULATION = 'false';
process.env.NODE_ENV = 'test';

const db = require('../server/engine/db');
const paymentEngine = require('../server/engine/paymentEngine');
const usdt = require('../server/engine/usdt');

const USDT_ENV_KEYS = Object.values(usdt.ENV_KEYS);

function clearUsdtEnv() {
  for (const key of USDT_ENV_KEYS) delete process.env[key];
}

function seedUser(userId) {
  const state = db.get();
  state.users[userId] = {
    id: userId,
    userId,
    phone: '9876543210',
    nickname: 'DepositTester',
    avatar: '/static/user/profile.png',
    balance: 0,
    totalBalance: 0,
    pendingWithdrawal: 0,
    totalDeposited: 0,
    wallets: [],
    claimedOrders: [],
    ledgerBaseline: 0
  };
  return state;
}

test.after(() => {
  clearUsdtEnv();
  try { db.flush(); } catch (e) { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

test('USDT stays disabled unless a real, valid receiving address is configured', () => {
  clearUsdtEnv();
  assert.equal(usdt.getConfig().enabled, false);
  assert.deepEqual(usdt.getConfig().chains, []);

  // The old placeholder value must never enable the gateway.
  process.env.USDT_TRC20_ADDRESS = 'TLxK9y5Bsq27Pz5vF7nK9yTRC20EXAMPLE';
  assert.equal(usdt.getConfig().enabled, false);

  // A malformed EVM address must also be ignored.
  process.env.USDT_BSC_ADDRESS = '0xnot-a-real-address';
  assert.equal(usdt.getConfig().enabled, false);

  const trc20 = `T${'1'.repeat(33)}`;
  const bsc = `0x${'a'.repeat(40)}`;
  process.env.USDT_TRC20_ADDRESS = trc20;
  process.env.USDT_BSC_ADDRESS = bsc;

  const config = usdt.getConfig();
  assert.equal(config.enabled, true);
  assert.deepEqual(config.chains, ['TRC20', 'BSC']);
  assert.equal(config.addresses.TRC20, trc20);
  assert.equal(config.addresses.BSC, bsc);

  assert.equal(usdt.normalizeChain('trc20'), 'TRC20');
  assert.equal(usdt.normalizeChain('Polygon'), 'Polygon');
  assert.equal(usdt.normalizeChain('solana'), null);

  clearUsdtEnv();
});

test('deposits fail closed instead of falling back to a user wallet', async () => {
  db.reset();
  const userId = 'deposit-safety-user';
  const state = seedUser(userId);

  // No active system wallet. Wallet 101 is an active wallet owned by another
  // trader, and the second wallet is a user wallet falsely marked official.
  for (const wallet of state.wallets) {
    if (wallet.isOfficial) wallet.status = 0;
  }
  state.wallets.push({
    id: 777,
    userId,
    isOfficial: true,
    status: 1,
    ctName: 'Attacker UPI',
    account: 'attacker@upi'
  });

  const depositsBefore = Object.keys(state.deposits || {}).length;
  await assert.rejects(
    () => paymentEngine.createDeposit({ userId, amount: 500 }),
    /No official deposit wallet is configured/
  );
  assert.equal(Object.keys(state.deposits || {}).length, depositsBefore);
});

test('deposits use the active system-owned official wallet', async () => {
  db.reset();
  const userId = 'deposit-official-user';
  const state = seedUser(userId);

  const deposit = await paymentEngine.createDeposit({ userId, amount: 500 });
  assert.equal(deposit.payeeWalletId, 1);
  assert.equal(deposit.payeeVpa, '9588856526@ybl');
  assert.equal(deposit.payeeName, 'TradePay Official');
  assert.match(deposit.upiUri, /^upi:\/\/pay\?pa=9588856526@ybl/);
});
