const express = require('express');
const router = express.Router();
const db = require('../engine/db');
const orderEngine = require('../engine/orderEngine');
const supabaseService = require('../engine/supabaseService');
const qrService = require('../engine/qrService');
const auth = require('../engine/auth');
const security = require('../engine/security');
const depositEngine = require('../engine/depositEngine');
const webhook = require('../engine/webhook');
const money = require('../engine/money');

const { extractToken } = auth;

// Response helpers
function ok(res, data = {}, msg = 'success') {
  return res.json({
    code: 1000,
    data,
    msg
  });
}

function fail(res, msg = 'Request failed', code = 500, data = null) {
  const status = Number(code) >= 400 && Number(code) < 600 ? Number(code) : 200;
  return res.status(status).json({
    code,
    data,
    msg
  });
}

// Paths that are intentionally reachable without a bearer token.
const PUBLIC_ROUTES = new Set([
  'POST /app/user/login/login',
  'POST /app/user/rs/submit',
  'POST /app/user/login/start',
  'POST /app/user/login/confirm',
  'POST /app/user/login/sendOtp',
  'GET /app/user/rs/invite/prefill',
  'GET /app/user/active/activeInfo',
  'GET /app/payment/official-qrs',
  'GET /app/ct/type/listEnabledCtTypes',
  'GET /app/ct/type/configCheck',
  'GET /app/app/carousel/manager/carouselManager',
  'GET /app/news/notice',
  'GET /app/app/notice/reads/list',
  'GET /app/app/notice/reads/unreadCount',
  'GET /app/app/popup/notice/currentList',
  'GET /app/app/official/service/getOfficialServiceData',
  'GET /app/newcomer-rewards/entry'
].map(route => {
  const [method, ...parts] = route.split(' ');
  return `${method.toUpperCase()} ${parts.join(' ').toLowerCase()}`;
}));

// Fail-closed authentication. Every /app route not explicitly public requires
// a valid Supabase token; missing, invalid, expired and revoked tokens get 401.
router.use(async (req, res, next) => {
  // Express matches routes case-insensitively, so the guard must too.
  const requestPath = String(req.path || '').toLowerCase();
  const protectedPath = requestPath.startsWith('/app/') || requestPath.startsWith('/api/sim/');
  if (!protectedPath) return next();

  const routeKey = `${String(req.method).toUpperCase()} ${requestPath}`;
  if (PUBLIC_ROUTES.has(routeKey)) return next();

  try {
    const user = await auth.authenticateToken(extractToken(req));
    if (!user) {
      return res.status(401).json({
        code: 401,
        data: null,
        msg: 'Authentication required'
      });
    }
    req.user = user;
    return next();
  } catch (err) {
    console.error('[Auth] middleware error:', err.message);
    return res.status(401).json({
      code: 401,
      data: null,
      msg: 'Authentication required'
    });
  }
});

function getAuthUser(req) {
  return req.user || null;
}

function requireAdmin(req, res) {
  if (!security.isAdmin(req.user)) {
    fail(res, 'Administrator access required', 403);
    return false;
  }
  return true;
}

const PIN_ATTEMPTS = new Map();
const PIN_LOCK_MS = 5 * 60 * 1000;
const PIN_MAX_ATTEMPTS = 5;

function pinAttemptState(userId) {
  const now = Date.now();
  if (PIN_ATTEMPTS.size > 200) {
    for (const [id, item] of PIN_ATTEMPTS) {
      if (item.lockedUntil < now && item.count === 0) {
        PIN_ATTEMPTS.delete(id);
      }
    }
  }
  let entry = PIN_ATTEMPTS.get(userId);
  if (!entry || entry.lockedUntil < now) {
    entry = { count: 0, lockedUntil: 0 };
    PIN_ATTEMPTS.set(userId, entry);
  }
  return entry;
}

let walletIdCounter = 0;
function nextWalletId(state) {
  if (!walletIdCounter) {
    walletIdCounter = state.wallets.reduce((max, w) => Math.max(max, Number(w.id) || 0), 100);
  }
  walletIdCounter += 1;
  return walletIdCounter;
}

// -------------------------------------------------------------
// DYNAMIC QR CODE RENDERING & STREAMING
// -------------------------------------------------------------
router.get('/api/qr/image', async (req, res) => {
  try {
    const text = req.query.text || req.query.data || req.query.uri;
    if (!text || String(text).length > 2048) {
      return res.status(400).send('Missing or oversized text/uri query parameter');
    }
    const width = Math.min(1024, Math.max(64, Number(req.query.size) || 256));
    const svg = await qrService.getQrSvg(String(text), { width });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(svg);
  } catch (err) {
    console.error('[API] /api/qr/image error:', err.message);
    return res.status(500).send('Error generating QR image');
  }
});

// -------------------------------------------------------------
// OFFICIAL QR CODES & INSTANT DEPOSITS
// -------------------------------------------------------------
router.get('/app/payment/official-qrs', async (req, res) => {
  const state = db.get();
  const rawQrs = state.officialQRs || db.officialQRs || [];
  const amount = req.query.amount ? Number(req.query.amount) : null;
  const note = req.query.note || null;
  const formatted = await Promise.all(
    rawQrs.map(qr => qrService.formatOfficialQr(qr, amount, note))
  );
  return ok(res, formatted);
});

router.post('/app/payment/deposit/submit', async (req, res) => {
  const { amount, qrId, utr } = req.body || {};
  const user = getAuthUser(req);

  const state = db.get();
  const qrs = state.officialQRs || db.officialQRs;
  const qr = qrs.find(q => q.id === Number(qrId) && q.status === 1);
  if (!qr) {
    return fail(res, 'Selected deposit QR is not available', 404);
  }

  try {
    const record = depositEngine.createDeposit({
      userId: user.id,
      amount,
      qrId: qr.id,
      vpa: qr.vpa,
      utr,
      // Explicit local-development opt-in only; production requires verification.
      autoCredit: process.env.ALLOW_AUTO_DEPOSIT === 'true' && process.env.NODE_ENV !== 'production'
    });

    const msg = record.status === 'completed'
      ? `Deposit of ₹${record.amount} credited successfully!`
      : 'Deposit submitted for verification';
    return ok(res, record, msg);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

router.get('/app/payment/deposit/history', (req, res) => {
  const user = getAuthUser(req);
  const records = depositEngine.listUserDeposits(user.id);
  return ok(res, { records, total: records.length });
});

router.get('/app/admin/deposits', (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const records = depositEngine.listAllDeposits({ status: req.query.status });
    return ok(res, { records, total: records.length });
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

router.post('/app/admin/deposits/approve', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { depositId } = req.body || {};
  try {
    const deposit = depositEngine.approveDeposit(depositId, req.user.id);
    return ok(res, deposit, 'Deposit approved and credited');
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

router.post('/app/admin/deposits/reject', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { depositId, reason } = req.body || {};
  try {
    const deposit = depositEngine.rejectDeposit(depositId, req.user.id, reason);
    return ok(res, deposit, 'Deposit rejected');
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// Signed, provider-agnostic payment reconciliation. Retries are idempotent:
// an already-credited deposit is reported as a duplicate and never credited twice.
router.post('/webhooks/payment', (req, res) => {
  const secret = String(process.env.PAYMENT_WEBHOOK_SECRET || '');
  if (!secret) return fail(res, 'Payment webhook is not configured', 503);
  if (!req.rawBody) return fail(res, 'Raw request body is required', 400);

  const signature = req.headers['x-tradepay-signature'] || req.headers['x-webhook-signature'];
  if (!webhook.verifySignature(req.rawBody, signature, secret)) {
    return fail(res, 'Invalid webhook signature', 401);
  }

  const { event, utr, amount, providerId, eventId } = req.body || {};
  if (event && event !== 'payment.captured') {
    return ok(res, { ignored: true });
  }

  try {
    const result = depositEngine.reconcileDeposit({ utr, amount, providerId, eventId });
    return ok(res, result, result.credited ? 'Deposit reconciled' : 'No new deposit to credit');
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// -------------------------------------------------------------
// 1. AUTH & USER (SUPABASE INTEGRATED)
// -------------------------------------------------------------
router.post('/app/user/login/login', async (req, res) => {
  if (!supabaseService.isConfigured()) {
    return fail(res, 'Authentication service is not configured', 503);
  }

  const { phone, identifier, email, password } = req.body || {};
  const idToUse = identifier || phone || email || '';

  if (!String(idToUse).trim() || !password) {
    return fail(res, 'Identifier and password are required', 400);
  }

  try {
    const authRes = await supabaseService.signInUser({
      identifier: idToUse,
      password
    });
    const user = await auth.authenticateToken(authRes.token);
    if (!user) {
      return fail(res, 'Unable to establish a session', 401);
    }
    return ok(res, {
      token: authRes.token,
      ...security.publicUser(user)
    });
  } catch (err) {
    return fail(res, err.message || 'Invalid credentials', 401);
  }
});

router.post('/app/user/rs/submit', async (req, res) => {
  if (!supabaseService.isConfigured()) {
    return fail(res, 'Authentication service is not configured', 503);
  }

  const { phone, identifier, email, password, nickname, inviteCode } = req.body || {};
  const idToUse = identifier || phone || email || '';

  if (!String(idToUse).trim()) {
    return fail(res, 'Phone, email, or username is required', 400);
  }
  if (typeof password !== 'string' || password.length < 6) {
    return fail(res, 'Password must be at least 6 characters', 400);
  }

  try {
    const authRes = await supabaseService.signUpUser({
      identifier: idToUse,
      phone,
      password,
      nickname: nickname || '',
      inviteCode: inviteCode || ''
    });
    const user = await auth.authenticateToken(authRes.token);
    if (!user) {
      return fail(res, 'Unable to establish a session', 401);
    }
    return ok(res, {
      token: authRes.token,
      ...security.publicUser(user)
    });
  } catch (err) {
    return fail(res, err.message, 400);
  }
});

router.post('/app/user/login/start', (req, res) => {
  return fail(res, 'Password or verified OTP login is required', 410);
});

router.post('/app/user/login/confirm', (req, res) => {
  return fail(res, 'Static demo login is disabled', 410);
});

router.post('/app/user/login/sendOtp', (req, res) => {
  return fail(res, 'OTP delivery is not configured', 501);
});

router.get('/app/user/rs/invite/prefill', (req, res) => {
  return ok(res, { inviteCode: 'LP8899' });
});

router.get('/app/user/info', (req, res) => {
  return ok(res, security.publicUser(getAuthUser(req)));
});

router.get('/app/user/info/person', (req, res) => {
  const user = getAuthUser(req);
  return ok(res, {
    id: user.id,
    phone: user.phone,
    nickname: user.nickname,
    avatar: user.avatar,
    vipLevel: user.vipLevel,
    isPinSet: user.isPinSet,
    balance: user.balance
  });
});

router.post('/app/user/info/verifyPin', (req, res) => {
  const { pin } = req.body || {};
  const user = getAuthUser(req);

  if (!user.isPinSet || !user.pinHash) {
    return fail(res, 'Security PIN is not set', 409);
  }

  const attempt = pinAttemptState(user.id);
  if (attempt.lockedUntil > Date.now()) {
    return fail(res, 'Too many incorrect attempts. Try again later.', 429);
  }

  if (!security.verifyPin(pin, user)) {
    attempt.count += 1;
    if (attempt.count >= PIN_MAX_ATTEMPTS) {
      attempt.lockedUntil = Date.now() + PIN_LOCK_MS;
      attempt.count = 0;
    }
    return fail(res, 'Incorrect Security PIN', 400);
  }

  PIN_ATTEMPTS.delete(user.id);
  return ok(res, { verified: true });
});

router.post('/app/user/info/updatePin', (req, res) => {
  const { oldPin, newPin } = req.body || {};
  const user = getAuthUser(req);

  if (!security.isValidPin(newPin)) {
    return fail(res, 'New PIN must be exactly 6 digits', 400);
  }
  if (user.isPinSet && !security.verifyPin(oldPin, user)) {
    return fail(res, 'Current Security PIN is incorrect', 400);
  }

  const hashed = security.hashPin(newPin);
  user.pinHash = hashed.hash;
  user.pinSalt = hashed.salt;
  user.isPinSet = true;
  delete user.pin;
  db.save();

  // Persist updated security PIN credentials to Supabase
  supabaseService.syncUserData(user, extractToken(req)).catch(() => {});

  return ok(res, { success: true });
});

router.post('/app/user/info/updatePassword', (req, res) => {
  return fail(res, 'Password change is not available in this build', 501);
});

router.post('/app/user/info/onSell/:id', (req, res) => {
  const user = getAuthUser(req);
  user.onSellStatus = 1;
  db.save();
  return ok(res, { status: 1 });
});

router.post('/app/user/info/offSell/:id', (req, res) => {
  const user = getAuthUser(req);
  user.onSellStatus = 0;
  db.save();
  return ok(res, { status: 0 });
});

router.get('/app/user/info/getInviterUrl', (req, res) => {
  const user = getAuthUser(req);
  const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const url = `${baseUrl}/#/register?inviteCode=${encodeURIComponent(user.inviteCode || 'LP8899')}`;
  return ok(res, {
    url,
    inviteCode: user.inviteCode || 'LP8899',
    qrCode: url
  });
});

router.get('/app/user/active/activeInfo', (req, res) => {
  return ok(res, { active: true, vipLevel: 2 });
});

router.post('/app/user/info/appLogout', (req, res) => {
  auth.revokeToken(extractToken(req));
  return ok(res, { loggedOut: true });
});

// -------------------------------------------------------------
// 2. ORDERS (WITH SUPABASE REAL DATA SORTING & MANAGING)
// -------------------------------------------------------------
router.get('/app/payment/order', (req, res) => {
  const records = orderEngine.getHangSales(req.query);
  return ok(res, {
    records,
    total: records.length,
    page: Number(req.query.page || 1),
    size: Number(req.query.size || 20)
  });
});

router.get('/app/payment/order/summary', (req, res) => {
  const user = getAuthUser(req);
  const state = db.get();
  return ok(res, {
    balance: user.balance,
    totalBalance: user.totalBalance || user.balance,
    rewardTotal: user.rewardTotal || 0,
    pending: user.pending || 0,
    usdtRechargeRate: state.settings.usdtRechargeRate,
    usdtCashbackRate: state.settings.usdtCashbackRate,
    wallet: user.balance
  });
});

router.get('/app/payment/order/dispatchRule', (req, res) => {
  const state = db.get();
  return ok(res, {
    enabled: true,
    total: state.hangSales.length,
    ranges: state.settings.dispatchRanges
  });
});

router.get('/app/payment/order/nightBonusStatus', (req, res) => {
  const state = db.get();
  const inRange = orderEngine.isNightBonusNow();
  return ok(res, {
    enabled: state.settings.nightBonus.enabled,
    inRangeNow: inRange,
    startTime: state.settings.nightBonus.startTime,
    endTime: state.settings.nightBonus.endTime
  });
});

router.post('/app/payment/order/create', async (req, res) => {
  const { payOrderId, payoutWalletId } = req.body || {};
  const user = getAuthUser(req);
  try {
    const claimed = await orderEngine.claimOrder({
      payOrderId,
      payoutWalletId: Number(payoutWalletId),
      userId: user.id
    });
    return ok(res, claimed);
  } catch (err) {
    return fail(res, err.message, 409);
  }
});

router.get('/app/payment/order/orderInfo', async (req, res) => {
  const { buyId } = req.query || {};
  const user = getAuthUser(req);
  const order = orderEngine.getOrderInfo(buyId, user.id);
  if (!order) {
    return fail(res, 'Order not found', 404);
  }
  try {
    await qrService.attachQrToOrder(order);
  } catch (err) {
    return fail(res, err.message, 409);
  }
  return ok(res, order);
});

router.post('/app/payment/order/submit', (req, res) => {
  const { buyId, utr, proofUrl } = req.body || {};
  const user = getAuthUser(req);
  try {
    const updated = orderEngine.submitOrder({ buyId, utr, proofUrl, userId: user.id });
    return ok(res, updated);
  } catch (err) {
    return fail(res, err.message, 409);
  }
});

router.post('/app/payment/order/cancel', (req, res) => {
  const { buyId, reason } = req.body || {};
  const user = getAuthUser(req);
  try {
    const result = orderEngine.cancelOrder({ buyId, reason, userId: user.id });
    return ok(res, result);
  } catch (err) {
    return fail(res, err.message, 409);
  }
});

router.get('/app/payment/order/history', async (req, res) => {
  const user = getAuthUser(req);
  const state = db.get();
  const orders = Object.values(state.claimedOrders).filter(o => String(o.userId) === String(user.id));
  await Promise.all(orders.map(o => qrService.attachQrToOrder(o).catch(() => o)));
  return ok(res, {
    records: orders,
    total: orders.length
  });
});

router.post('/app/payment/order/changeWallet', async (req, res) => {
  const { buyId, newPayoutWalletId } = req.body || {};
  const user = getAuthUser(req);
  const state = db.get();
  const order = orderEngine.getOrderInfo(buyId, user.id);
  if (!order) return fail(res, 'Order not found', 404);
  if (!['pending', 'confirming'].includes(order.status)) {
    return fail(res, 'Order can no longer change its payout wallet', 409);
  }
  const wallet = state.wallets.find(w =>
    w.id === Number(newPayoutWalletId) && String(w.userId) === String(user.id)
  );
  if (!wallet) return fail(res, 'Wallet not found', 404);
  order.payoutWalletId = wallet.id;
  order.payoutWalletName = wallet.ctName;
  order.payoutAccount = wallet.account;
  try {
    await qrService.attachQrToOrder(order);
  } catch (err) {
    return fail(res, err.message, 409);
  }
  db.save();
  return ok(res, order);
});

router.post('/app/payment/order/createUsdt', async (req, res) => {
  const { amount, chainType = 'TRC20' } = req.body || {};
  const numAmount = Number(amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0 || numAmount > 1000000) {
    return fail(res, 'Please enter a valid USDT amount', 400);
  }
  const state = db.get();
  const usdtId = 'USDT' + Date.now();
  const rate = state.settings?.usdtRechargeRate || 91.50;
  const inrAmount = money.multiply(numAmount, rate);
  const addresses = {
    TRC20: 'TLxK9y5Bsq27Pz5vF7nK9yTRC20EXAMPLE',
    BSC: '0x71C95911e74B39d48b1968848777BSCEXAMPLE',
    Polygon: '0x99A8c829e74B39d48b1968848POLYGONEXAMPLE'
  };
  const address = addresses[chainType] || addresses.TRC20;
  const qrData = await qrService.attachQrToUsdt(chainType, address, numAmount);
  const order = {
    id: usdtId,
    usdtAmount: numAmount,
    inrAmount,
    rate,
    chainType,
    address,
    qrDataUrl: qrData.qrDataUrl,
    qrImageUrl: qrData.qrImageUrl,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  return ok(res, order);
});

router.get('/app/payment/order/usdtInfo', async (req, res) => {
  const chains = ['TRC20', 'BSC', 'Polygon'];
  const addresses = {
    TRC20: 'TLxK9y5Bsq27Pz5vF7nK9yTRC20EXAMPLE',
    BSC: '0x71C95911e74B39d48b1968848777BSCEXAMPLE',
    Polygon: '0x99A8c829e74B39d48b1968848POLYGONEXAMPLE'
  };
  const details = {};
  for (const c of chains) {
    details[c] = await qrService.attachQrToUsdt(c, addresses[c]);
  }
  return ok(res, {
    rate: 91.50,
    chains,
    details
  });
});

router.post('/app/payment/app/buy/order/usdt', (req, res) => {
  return fail(res, 'USDT purchase settlement is not available in this build', 501);
});

// -------------------------------------------------------------
// 3. WALLETS & KYC (PER-USER SUPABASE MANAGEMENT)
// -------------------------------------------------------------
router.post('/app/ct/app/collection/getWalletList', async (req, res) => {
  const user = getAuthUser(req);
  const state = db.get();
  const userWallets = state.wallets.filter(w => String(w.userId) === String(user.id));
  const enhanced = await Promise.all(userWallets.map(w => qrService.attachQrToWallet(w)));
  return ok(res, enhanced);
});

router.post('/app/ct/app/collection/getPayoutWalletList', async (req, res) => {
  const user = getAuthUser(req);
  const state = db.get();
  const userWallets = state.wallets.filter(w =>
    String(w.userId) === String(user.id) && w.status === 1
  );
  const enhanced = await Promise.all(userWallets.map(w => qrService.attachQrToWallet(w)));
  return ok(res, enhanced);
});

router.post('/app/ct/app/collection/memberPayoutWallets', async (req, res) => {
  const user = getAuthUser(req);
  const state = db.get();
  const userWallets = state.wallets.filter(w => String(w.userId) === String(user.id));
  const enhanced = await Promise.all(userWallets.map(w => qrService.attachQrToWallet(w)));
  return ok(res, enhanced);
});

async function createCollectionWallet(req, res) {
  const { ctType, account, name, phone, minAmount = 500, maxAmount = 25000, dailyLimit = 100000 } = req.body || {};
  const user = getAuthUser(req);
  const state = db.get();

  const cleanAccount = String(account || '').trim();
  if (!cleanAccount || cleanAccount.length > 120 || /\s/.test(cleanAccount)) {
    return fail(res, 'Please enter a valid UPI / account', 400);
  }

  const min = Number(minAmount);
  const max = Number(maxAmount);
  const daily = Number(dailyLimit);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0 || min > max) {
    return fail(res, 'Invalid wallet payout range', 400);
  }
  if (!Number.isFinite(daily) || daily <= 0) {
    return fail(res, 'Invalid daily limit', 400);
  }

  const ctNames = {
    1: 'Airtel',
    2: 'Freecharge',
    3: 'PhonePe',
    4: 'Mobikwik',
    5: 'Paytm',
    6: 'Amazon',
    7: 'Paytm Business',
    8: 'PhonePe Business',
    9: 'IndusPay',
    10: 'BharatpeBiz',
    11: 'Navi',
    16: 'Moneyview'
  };

  const baseWallet = {
    id: nextWalletId(state),
    userId: user.id,
    ctType: Number(ctType) || 3,
    ctName: ctNames[ctType] || 'UPI',
    account: cleanAccount,
    phone: phone || user.phone || '',
    name: name || user.nickname || 'Account Holder',
    status: 1,
    minAmount: min,
    maxAmount: max,
    dailyLimit: daily,
    todayTurnover: 0,
    todayCount: 0,
    successRate: 100.0,
    createdAt: new Date().toISOString()
  };

  const newWallet = await qrService.attachQrToWallet(baseWallet);
  state.wallets.push(newWallet);
  if (!Array.isArray(user.wallets)) user.wallets = [];
  user.wallets.push(newWallet);
  db.save();

  // Persist updated collection wallets to Supabase
  supabaseService.syncUserData(user, extractToken(req)).catch(() => {});

  return ok(res, newWallet);
}

router.post('/app/ct/app/collection/submit', createCollectionWallet);
router.post('/app/ct/app/collection/v2/submit', createCollectionWallet);

router.post('/app/ct/app/collection/changeStatus/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  const user = getAuthUser(req);
  const state = db.get();

  const wallet = state.wallets.find(w =>
    w.id === id && String(w.userId) === String(user.id)
  );
  if (!wallet) return fail(res, 'Wallet not found', 404);

  const nextStatus = status != null ? Number(status) : (wallet.status === 1 ? 0 : 1);
  if (nextStatus !== 0 && nextStatus !== 1) {
    return fail(res, 'Invalid wallet status', 400);
  }
  wallet.status = nextStatus;
  if (Array.isArray(user.wallets)) {
    const uw = user.wallets.find(w => w.id === id);
    if (uw) uw.status = nextStatus;
  }
  db.save();

  supabaseService.syncUserData(user, extractToken(req)).catch(() => {});

  return ok(res, wallet);
});

router.post('/app/ct/app/collection/onSell/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = getAuthUser(req);
  const state = db.get();
  const wallet = state.wallets.find(w =>
    w.id === id && String(w.userId) === String(user.id)
  );
  if (!wallet) return fail(res, 'Wallet not found', 404);
  wallet.status = 1;
  if (Array.isArray(user.wallets)) {
    const uw = user.wallets.find(w => w.id === id);
    if (uw) uw.status = 1;
  }
  db.save();
  supabaseService.syncUserData(user, extractToken(req)).catch(() => {});
  return ok(res, { success: true });
});

router.post('/app/ct/app/collection/offSell/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = getAuthUser(req);
  const state = db.get();
  const wallet = state.wallets.find(w =>
    w.id === id && String(w.userId) === String(user.id)
  );
  if (!wallet) return fail(res, 'Wallet not found', 404);
  wallet.status = 0;
  if (Array.isArray(user.wallets)) {
    const uw = user.wallets.find(w => w.id === id);
    if (uw) uw.status = 0;
  }
  db.save();
  supabaseService.syncUserData(user, extractToken(req)).catch(() => {});
  return ok(res, { success: true });
});

router.post('/app/ct/app/collection/updateLimitedRange', (req, res) => {
  const { id, minAmount, maxAmount } = req.body || {};
  const user = getAuthUser(req);
  const state = db.get();
  const wallet = state.wallets.find(w =>
    w.id === Number(id) && String(w.userId) === String(user.id)
  );
  if (!wallet) return fail(res, 'Wallet not found', 404);

  const min = minAmount != null ? Number(minAmount) : Number(wallet.minAmount);
  const max = maxAmount != null ? Number(maxAmount) : Number(wallet.maxAmount);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0 || min > max) {
    return fail(res, 'Invalid wallet payout range', 400);
  }
  wallet.minAmount = min;
  wallet.maxAmount = max;
  db.save();

  return ok(res, wallet);
});

router.post('/app/ct/app/collection/canEditReceiveRange', (req, res) => {
  return ok(res, { canEdit: true });
});

router.get('/app/ct/type/listEnabledCtTypes', (req, res) => {
  return ok(res, [
    { id: 1, name: 'Airtel', code: 'AIRTEL', icon: '/static/wallet/airtel.png' },
    { id: 2, name: 'Freecharge', code: 'FREECHARGE', icon: '/static/wallet/freecharge.png' },
    { id: 3, name: 'PhonePe', code: 'PHONEPE', icon: '/static/wallet/phonepe.png' },
    { id: 4, name: 'Mobikwik', code: 'MOBIKWIK', icon: '/static/wallet/mobikwik.png' },
    { id: 5, name: 'Paytm', code: 'PAYTM', icon: '/static/wallet/paytm.png' },
    { id: 6, name: 'Amazon Pay', code: 'AMAZON', icon: '/static/wallet/amazon.png' },
    { id: 10, name: 'BharatpeBiz', code: 'BHARATPEBIZ', icon: '/static/wallet/bharatpebiz.png' },
    { id: 11, name: 'Navi', code: 'NAVI', icon: '/static/wallet/navi.png' }
  ]);
});

router.get('/app/ct/type/configCheck', (req, res) => {
  return ok(res, {
    enabled: true,
    wallets: [
      { name: 'PhonePe' },
      { name: 'Paytm' },
      { name: 'Freecharge' }
    ]
  });
});

// -------------------------------------------------------------
// 4. TEAM & REFERRAL
// -------------------------------------------------------------
router.get('/app/user/team/details', (req, res) => {
  const user = getAuthUser(req);
  const state = db.get();
  const members = state.team.members.filter(m =>
    String(m.inviterId) === String(user.id) || String(m.userId) === String(user.id)
  );
  const commissionTotal = members.reduce(
    (sum, m) => money.add(sum, m.commission || 0),
    0
  );
  const teamTurnover = members.reduce(
    (sum, m) => money.add(sum, m.turnover || 0),
    0
  );
  const totalCommission = commissionTotal || state.team.commissionTotal || 0;
  const totalTurnover = teamTurnover || state.team.teamTurnover || 0;
  return ok(res, {
    commissionTotal: totalCommission,
    yCommission: totalCommission,
    teamTurnover: totalTurnover,
    memberTotal: members.length,
    activeCount: members.filter(m => m.status === 1).length,
    inviteCode: user.inviteCode || 'LP8899'
  });
});

router.get('/app/user/team/members', (req, res) => {
  const user = getAuthUser(req);
  const state = db.get();
  const members = state.team.members.filter(m =>
    String(m.inviterId) === String(user.id) || String(m.userId) === String(user.id)
  );
  return ok(res, {
    records: members,
    total: members.length
  });
});

router.get('/app/user/team/subMembers', (req, res) => {
  const user = getAuthUser(req);
  const state = db.get();
  const members = state.team.members.filter(m =>
    String(m.inviterId) === String(user.id) || String(m.userId) === String(user.id)
  );
  return ok(res, {
    records: members,
    total: members.length
  });
});

router.get('/app/user/team/invites', (req, res) => {
  const user = getAuthUser(req);
  const code = user.inviteCode || 'LP8899';
  const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  return ok(res, {
    inviteCode: code,
    inviteUrl: `${baseUrl}/#/register?inviteCode=${encodeURIComponent(code)}`
  });
});

router.post('/app/user/team/members/ratio', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { tier1, tier2, tier3 } = req.body || {};
  const state = db.get();
  const values = [tier1, tier2, tier3].filter(v => v != null).map(Number);
  if (values.some(v => !Number.isFinite(v) || v < 0 || v > 100)) {
    return fail(res, 'Commission ratios must be between 0 and 100', 400);
  }
  if (tier1 != null) state.team.ratios.tier1 = Number(tier1);
  if (tier2 != null) state.team.ratios.tier2 = Number(tier2);
  if (tier3 != null) state.team.ratios.tier3 = Number(tier3);
  db.save();
  return ok(res, state.team.ratios);
});

// -------------------------------------------------------------
// 5. APP, NOTICES, MISSIONS & REWARDS
// -------------------------------------------------------------
const carouselList = [
  { id: 1, imgUrl: '/static/banner/banner.jpg', link: '' },
  { id: 2, imgUrl: '/static/banner/ad1.png', link: '' },
  { id: 3, imgUrl: '/static/banner/ad2.png', link: '' }
];
router.get('/app/app/carousel/manager/carouselManager', (req, res) => ok(res, carouselList));
router.post('/app/app/carousel/manager/carouselManager', (req, res) => ok(res, carouselList));

router.get('/app/news/notice', (req, res) => {
  const state = db.get();
  return ok(res, state.notices);
});

router.get('/app/app/notice/reads/list', (req, res) => {
  const state = db.get();
  return ok(res, { records: state.notices, total: state.notices.length });
});

router.get('/app/app/notice/reads/unreadCount', (req, res) => {
  return ok(res, { count: 0 });
});

router.get('/app/app/popup/notice/currentList', (req, res) => {
  return ok(res, []);
});

router.get('/app/app/official/service/getOfficialServiceData', (req, res) => {
  return ok(res, [
    { id: 1, name: 'Telegram Support', description: '24/7 Official Support Agent', link: 'https://t.me/tradepay_support' },
    { id: 2, name: 'WhatsApp Channel', description: 'Latest payment tips and announcements', link: 'https://chat.whatsapp.com/example' }
  ]);
});

function isMissionCompletedForUser(mission, user, state) {
  if (!mission || !user) return false;
  const mId = Number(mission.id);

  if (mId === 1) {
    // Mission 1: Daily Sign-in -> completed for logged-in user
    return true;
  }
  if (mId === 2) {
    // Mission 2: Complete 1 Collection Order -> completed if user has completed at least 1 order
    const hasOrder = (Array.isArray(user.claimedOrders) && user.claimedOrders.length > 0) ||
      Object.values(state.claimedOrders || {}).some(
        o => String(o.userId) === String(user.id) && o.status === 'completed'
      );
    return Boolean(hasOrder);
  }
  if (mId === 3) {
    // Mission 3: Join Telegram -> completed if visited or user has flag
    return Boolean(
      (Array.isArray(user.visitedMissions) && user.visitedMissions.includes(mId)) ||
      user.telegramJoined ||
      user.socialVisited
    );
  }
  if (mId === 4) {
    // Mission 4: Pay using Official QR Code -> completed if user has at least 1 completed deposit
    const hasDeposit = (state.deposits || []).some(
      d => String(d.userId) === String(user.id) && d.status === 'completed'
    );
    return Boolean(hasDeposit);
  }
  return Boolean(mission.completed);
}

router.get('/app/mission/task', (req, res) => {
  const user = getAuthUser(req);
  const state = db.get();
  const claimed = new Set((user.claimedMissions || []).map(Number));
  const records = state.missions.map(m => ({
    ...m,
    completed: isMissionCompletedForUser(m, user, state),
    claimed: claimed.has(Number(m.id))
  }));
  return ok(res, records);
});

router.post('/app/mission/task/visit/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = getAuthUser(req);
  if (!Array.isArray(user.visitedMissions)) user.visitedMissions = [];
  if (!user.visitedMissions.includes(id)) {
    user.visitedMissions.push(id);
    db.save();
  }
  return ok(res, { visited: true, missionId: id });
});

router.post('/app/mission/task/receive/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = getAuthUser(req);
  const state = db.get();
  const mission = state.missions.find(t => t.id === id);
  if (!mission) return fail(res, 'Mission not found', 404);

  const completed = isMissionCompletedForUser(mission, user, state);
  if (!completed) return fail(res, 'Mission is not complete', 409);

  if (!Array.isArray(user.claimedMissions)) user.claimedMissions = [];
  if (user.claimedMissions.map(Number).includes(id)) {
    return fail(res, 'Mission reward already claimed', 409);
  }

  user.claimedMissions.push(id);
  user.points = (Number(user.points) || 0) + (Number(mission.reward) || 0);
  db.save();

  try {
    const supabaseService = require('../engine/supabaseService');
    supabaseService.syncUserData(user).catch(() => {});
  } catch (e) {}

  return ok(res, { success: true, points: user.points });
});

router.get('/app/newcomer-rewards/entry', (req, res) => {
  return ok(res, { enabled: true, amount: 88 });
});

router.get('/app/newcomer-rewards/detail', (req, res) => {
  const user = getAuthUser(req);
  return ok(res, {
    claimed: Boolean(user.newcomerRewardClaimed),
    amount: 88
  });
});

router.post('/app/newcomer-rewards/claim/:id', (req, res) => {
  const user = getAuthUser(req);
  if (user.newcomerRewardClaimed) {
    return fail(res, 'Newcomer reward already claimed', 409);
  }

  user.newcomerRewardClaimed = true;
  user.balance = money.add(user.balance, 88);
  user.totalBalance = user.balance;
  db.save();
  supabaseService.syncUserData(user, extractToken(req)).catch(() => {});

  return ok(res, { amount: 88, balance: user.balance });
});

router.post('/app/user/token/page', (req, res) => {
  return ok(res, {
    records: [
      { id: 1, type: 'Order Reward', amount: '+75.00', date: '2026-10-27 21:30' },
      { id: 2, type: 'Team Rebate', amount: '+42.50', date: '2026-10-27 18:15' },
      { id: 3, type: 'Daily Bonus', amount: '+20.00', date: '2026-10-27 09:00' }
    ],
    total: 3
  });
});

router.get('/app/itoken/appi/token/page', (req, res) => {
  return ok(res, {
    records: [
      { id: 1, desc: 'Night Bonus Reward', score: 25, time: '2026-10-27 23:10' },
      { id: 2, desc: 'Order Settlement', score: 50, time: '2026-10-27 20:00' }
    ],
    total: 2
  });
});

// Simulation trigger endpoint
router.post('/api/sim/spawn-order', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const order = orderEngine.spawnSampleOrder();
  return ok(res, order, 'Simulated order created');
});

module.exports = router;
