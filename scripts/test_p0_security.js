const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tradepay-p0-'));
process.env.TRADEPAY_DB_FILE = path.join(tmpDir, 'db.json');
process.env.ALLOW_SIMULATION = 'false';
process.env.NODE_ENV = 'test';

const db = require('../server/engine/db');
const orderEngine = require('../server/engine/orderEngine');
const security = require('../server/engine/security');
const money = require('../server/engine/money');
const apiRouter = require('../server/routes/api');

test.after(() => {
  try { db.flush(); } catch (e) { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

test('protected endpoints fail closed and public endpoints stay public', async () => {
  const app = express();
  app.use(express.json());
  app.use('/', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();

  try {
    const info = await fetch(`http://127.0.0.1:${port}/app/user/info`);
    assert.equal(info.status, 401);
    assert.equal((await info.json()).code, 401);

    const wallets = await fetch(`http://127.0.0.1:${port}/app/ct/app/collection/getWalletList`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(wallets.status, 401);

    const v2Submit = await fetch(`http://127.0.0.1:${port}/app/ct/app/collection/v2/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(v2Submit.status, 401);

    // Express routes case-insensitively; the auth guard must not be bypassable
    // by changing the case of the path.
    const upper = await fetch(`http://127.0.0.1:${port}/APP/user/info`);
    assert.equal(upper.status, 401);

    const confirm = await fetch(`http://127.0.0.1:${port}/app/user/login/confirm`, { method: 'POST' });
    assert.equal(confirm.status, 410);

    // The order catalog is authenticated business data, not a public listing.
    const orders = await fetch(`http://127.0.0.1:${port}/app/payment/order`);
    assert.equal(orders.status, 401);

    const dispatchRule = await fetch(`http://127.0.0.1:${port}/app/payment/order/dispatchRule`);
    assert.equal(dispatchRule.status, 401);

    // Marketing/configuration endpoints remain public.
    const notices = await fetch(`http://127.0.0.1:${port}/app/news/notice`);
    assert.equal(notices.status, 200);
    assert.equal((await notices.json()).code, 1000);

    const walletTypes = await fetch(`http://127.0.0.1:${port}/app/ct/type/listEnabledCtTypes`);
    assert.equal(walletTypes.status, 200);
    assert.equal((await walletTypes.json()).code, 1000);

    // Public-route matching must be case-insensitive in both directions.
    const upperTypes = await fetch(`http://127.0.0.1:${port}/APP/CT/TYPE/LISTENABLEDCTTYPES`);
    assert.equal(upperTypes.status, 200);

    // This read-only endpoint is a POST, so it is not in the public allowlist.
    const carouselPost = await fetch(`http://127.0.0.1:${port}/app/app/carousel/manager/carouselManager`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(carouselPost.status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('claim is atomic and ownership is enforced', async () => {
  db.reset();

  const results = await Promise.allSettled([
    orderEngine.claimOrder({ payOrderId: 'PO20261028001', payoutWalletId: 101, userId: '10086' }),
    orderEngine.claimOrder({ payOrderId: 'PO20261028001', payoutWalletId: 101, userId: '10086' })
  ]);

  const fulfilled = results.filter(r => r.status === 'fulfilled');
  assert.equal(fulfilled.length, 1, 'exactly one concurrent claim should succeed');
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);

  const claimed = fulfilled[0].value;
  assert.equal(claimed.status, 'pending');
  assert.equal(orderEngine.getOrderInfo(claimed.buyId, 'someone-else'), null);
  assert.throws(
    () => orderEngine.submitOrder({ buyId: claimed.buyId, utr: '123456789012', userId: 'someone-else' }),
    /Order not found/
  );
  assert.throws(
    () => orderEngine.cancelOrder({ buyId: claimed.buyId, userId: 'someone-else' }),
    /Order not found/
  );
});

test('submit is idempotent, UTR-validated and cannot be replayed', async () => {
  db.reset();

  const claimed = await orderEngine.claimOrder({
    payOrderId: 'PO20261028001',
    payoutWalletId: 101,
    userId: '10086'
  });

  assert.throws(
    () => orderEngine.submitOrder({ buyId: claimed.buyId, utr: '123', userId: '10086' }),
    /12-digit/
  );

  const submitted = orderEngine.submitOrder({
    buyId: claimed.buyId,
    utr: '123456789012',
    userId: '10086'
  });
  assert.equal(submitted.status, 'verifying');
  assert.equal(db.get().users['10086'].balance, 0, 'balance must not be credited during verification');

  assert.throws(
    () => orderEngine.submitOrder({ buyId: claimed.buyId, utr: '123456789012', userId: '10086' }),
    /cannot be submitted/
  );

  assert.throws(
    () => orderEngine.cancelOrder({ buyId: claimed.buyId, userId: '10086' }),
    /under admin verification/
  );

  const completed = orderEngine.verifyOrder({
    buyId: claimed.buyId,
    adminId: 'admin-1',
    action: 'confirm'
  });
  assert.equal(completed.status, 'completed');
  assert.equal(
    db.get().hangSales.find(o => o.payOrderId === 'PO20261028001').status,
    'completed'
  );
  const balanceAfterFirst = db.get().users['10086'].balance;
  assert.ok(balanceAfterFirst > 0, 'balance credited after admin confirmation');

  assert.throws(
    () => orderEngine.cancelOrder({ buyId: claimed.buyId, userId: '10086' }),
    /Completed orders cannot be cancelled/
  );

  const second = await orderEngine.claimOrder({
    payOrderId: 'PO20261028002',
    payoutWalletId: 101,
    userId: '10086'
  });
  assert.throws(
    () => orderEngine.submitOrder({ buyId: second.buyId, utr: '123456789012', userId: '10086' }),
    /already been used/
  );
});

test('cancelled orders are restored exactly once and cannot be replayed', async () => {
  db.reset();

  const claimed = await orderEngine.claimOrder({
    payOrderId: 'PO20261028001',
    payoutWalletId: 101,
    userId: '10086'
  });

  const result = orderEngine.cancelOrder({ buyId: claimed.buyId, userId: '10086' });
  assert.equal(result.success, true);
  assert.equal(db.get().claimedOrders[claimed.buyId].status, 'cancelled');
  assert.equal(db.get().hangSales.find(o => o.payOrderId === 'PO20261028001').status, 'pending');
  assert.throws(
    () => orderEngine.cancelOrder({ buyId: claimed.buyId, userId: '10086' }),
    /already cancelled/
  );
});

test('PINs are hashed and never exposed by the public user DTO', () => {
  const hashed = security.hashPin('654321');
  const user = { id: 'u1', pinHash: hashed.hash, pinSalt: hashed.salt, pin: '654321', token: 'secret' };

  assert.equal(security.verifyPin('654321', user), true);
  assert.equal(security.verifyPin('123456', user), false);

  const safe = security.publicUser(user);
  assert.equal(safe.pin, undefined);
  assert.equal(safe.pinHash, undefined);
  assert.equal(safe.pinSalt, undefined);
  assert.equal(safe.token, undefined);
  assert.equal(typeof safe.isAdmin, 'boolean');
});

test('admin status is server-derived and never client-supplied', () => {
  const previous = process.env.ADMIN_USER_IDS;
  process.env.ADMIN_USER_IDS = 'admin-1, admin-2';

  try {
    assert.equal(security.publicUser({ id: 'admin-1' }).isAdmin, true);
    assert.equal(security.publicUser({ id: 'someone-else', isAdmin: true }).isAdmin, false);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = previous;
  }
});

test('money arithmetic is paise-exact', () => {
  assert.equal(money.add(0.1, 0.2), 0.3);
  assert.equal(money.subtract(0.3, 0.1), 0.2);
  assert.equal(money.percentage(1500, 1.2), 18);
  assert.equal(money.multiply(100, 91.5), 9150);
  assert.equal(money.fromPaise(money.toPaise(1.005)), 1.01);
  assert.equal(money.equals(19.99, 19.990), true);
});

