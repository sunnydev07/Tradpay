const express = require('express');
const router = express.Router();
const db = require('../engine/db');
const orderEngine = require('../engine/orderEngine');
const supabaseService = require('../engine/supabaseService');
const qrService = require('../engine/qrService');

// Response helpers
function ok(res, data = {}, msg = 'success') {
  return res.json({
    code: 1000,
    data,
    msg
  });
}

function fail(res, msg = 'Request failed', code = 500, data = null) {
  return res.status(200).json({
    code,
    data,
    msg
  });
}

// Extract token from request
function extractToken(req) {
  const authHeader = req.headers.authorization || req.headers.token || req.query.token || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return authHeader.trim();
}

// Get authenticated user (Supabase or local fallback)
async function getAuthUser(req) {
  const token = extractToken(req);
  const state = db.get();

  if (token) {
    // 1. Check local db tokens
    if (state.tokens[token] && state.users[state.tokens[token]]) {
      return state.users[state.tokens[token]];
    }

    // 2. Check Supabase token
    const supUser = await supabaseService.verifyToken(token);
    if (supUser) {
      if (!state.users[supUser.id]) {
        state.users[supUser.id] = {
          id: supUser.id,
          userId: supUser.id,
          phone: supUser.phone || supUser.email || '+919876543210',
          nickname: supUser.nickname || 'Trader',
          avatar: '/static/user/profile.png',
          balance: supUser.balance != null ? Number(supUser.balance) : 0.00,
          totalBalance: supUser.totalBalance != null ? Number(supUser.totalBalance) : 0.00,
          rewardTotal: supUser.rewardTotal != null ? Number(supUser.rewardTotal) : 0.00,
          pending: 0.00,
          points: supUser.points != null ? Number(supUser.points) : 0,
          vipLevel: supUser.vipLevel || 1,
          inviteCode: supUser.inviteCode || 'LP8899',
          pin: supUser.pin || '123456',
          isPinSet: true,
          onSellStatus: 1,
          wallets: supUser.wallets || [],
          token
        };
      }
      return state.users[supUser.id];
    }
  }

  // Fallback demo user
  return state.users['10086'] || Object.values(state.users)[0];
}

// -------------------------------------------------------------
// DYNAMIC QR CODE RENDERING & STREAMING
// -------------------------------------------------------------
router.get('/api/qr/image', async (req, res) => {
  try {
    const text = req.query.text || req.query.data || req.query.uri;
    if (!text) {
      return res.status(400).send('Missing text or uri query parameter');
    }
    const width = Number(req.query.size) || 256;
    const svg = await qrService.getQrSvg(text, { width });
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
  const { amount, qrId, utr, remark } = req.body || {};
  const user = await getAuthUser(req);
  const token = extractToken(req);

  const numAmount = Number(amount);
  if (!numAmount || numAmount <= 0) {
    return fail(res, 'Please enter a valid deposit amount', 400);
  }

  if (!utr || String(utr).trim().length < 6) {
    return fail(res, 'Please enter valid 12-digit bank UTR reference', 400);
  }

  const state = db.get();
  const qrs = state.officialQRs || db.officialQRs;
  const qr = qrs.find(q => q.id === Number(qrId)) || qrs[0];

  const depositRecord = {
    id: 'DEP' + Date.now(),
    userId: user.id,
    amount: numAmount,
    qrId: qr.id,
    vpa: qr.vpa,
    utr: String(utr).trim(),
    status: 'completed',
    createdAt: new Date().toISOString()
  };

  // Credit user balance
  user.balance = Number((user.balance + numAmount).toFixed(2));
  user.totalBalance = user.balance;
  db.save();

  // Sync to Supabase
  await supabaseService.updateUserRecord(token, {
    balance: user.balance,
    totalBalance: user.balance
  });

  return ok(res, depositRecord, `Deposit of ₹${numAmount} credited successfully!`);
});

// -------------------------------------------------------------
// 1. AUTH & USER (SUPABASE INTEGRATED)
// -------------------------------------------------------------
router.post('/app/user/login/login', async (req, res) => {
  const { phone, identifier, email, password } = req.body || {};
  const idToUse = identifier || phone || email || '+919876543210';
  const state = db.get();

  try {
    let authRes;
    try {
      authRes = await supabaseService.signInUser({
        identifier: idToUse,
        password: password || 'Password123!'
      });
    } catch (loginErr) {
      // If user not found, auto-register for seamless onboarding
      if (loginErr.message.includes('Invalid login credentials') || loginErr.message.includes('not found')) {
        authRes = await supabaseService.signUpUser({
          identifier: idToUse,
          phone: idToUse,
          password: password || 'Password123!',
          nickname: 'Trader_' + Math.floor(1000 + Math.random() * 9000)
        });
      } else {
        throw loginErr;
      }
    }

    // Save session in local cache for speed
    const user = authRes.user;
    state.users[user.id] = {
      ...user,
      token: authRes.token
    };
    state.tokens[authRes.token] = user.id;

    // Attach user wallets to state if present
    if (user.wallets && user.wallets.length) {
      for (const w of user.wallets) {
        if (!state.wallets.some(existing => existing.id === w.id)) {
          state.wallets.push({ ...w, userId: user.id });
        }
      }
    }
    db.save();

    return ok(res, {
      token: authRes.token,
      userId: user.id,
      phone: user.phone,
      nickname: user.nickname,
      balance: user.balance,
      inviteCode: user.inviteCode
    });
  } catch (err) {
    return fail(res, err.message, 400);
  }
});

router.post('/app/user/rs/submit', async (req, res) => {
  const { phone, identifier, email, password, nickname } = req.body || {};
  const idToUse = identifier || phone || email || '+919876543210';
  const state = db.get();

  try {
    const authRes = await supabaseService.signUpUser({
      identifier: idToUse,
      phone: idToUse,
      password: password || 'Password123!',
      nickname: nickname || ('Trader_' + Math.floor(1000 + Math.random() * 9000))
    });

    const user = authRes.user;
    state.users[user.id] = {
      ...user,
      token: authRes.token
    };
    state.tokens[authRes.token] = user.id;
    if (user.wallets && user.wallets.length) {
      for (const w of user.wallets) {
        if (!state.wallets.some(existing => existing.id === w.id)) {
          state.wallets.push({ ...w, userId: user.id });
        }
      }
    }
    db.save();

    return ok(res, {
      token: authRes.token,
      userId: user.id,
      phone: user.phone,
      nickname: user.nickname,
      balance: user.balance,
      inviteCode: user.inviteCode
    });
  } catch (err) {
    return fail(res, err.message, 400);
  }
});

router.post('/app/user/login/start', (req, res) => {
  return ok(res, { sessionId: 'SES_' + Date.now(), needOtp: false });
});

router.post('/app/user/login/confirm', (req, res) => {
  return ok(res, { token: 'token_10086', userId: '10086' });
});

router.post('/app/user/login/sendOtp', (req, res) => {
  return ok(res, { success: true, msg: 'OTP sent (Use 123456)' });
});

router.get('/app/user/rs/invite/prefill', (req, res) => {
  return ok(res, { inviteCode: 'LP8899' });
});

router.get('/app/user/info', async (req, res) => {
  const user = await getAuthUser(req);
  return ok(res, user);
});

router.get('/app/user/info/person', async (req, res) => {
  const user = await getAuthUser(req);
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

router.post('/app/user/info/verifyPin', async (req, res) => {
  const { pin } = req.body || {};
  const user = await getAuthUser(req);
  if (pin === user.pin || pin === '123456') {
    return ok(res, { verified: true });
  }
  return fail(res, 'Incorrect Security PIN', 400);
});

router.post('/app/user/info/updatePin', async (req, res) => {
  const { newPin } = req.body || {};
  const user = await getAuthUser(req);
  const token = extractToken(req);
  user.pin = newPin || '123456';
  user.isPinSet = true;
  db.save();

  // Sync with Supabase
  await supabaseService.updateUserRecord(token, { pin: user.pin });
  return ok(res, { success: true });
});

router.post('/app/user/info/updatePassword', (req, res) => {
  return ok(res, { success: true });
});

router.post('/app/user/info/onSell/:id', async (req, res) => {
  const user = await getAuthUser(req);
  user.onSellStatus = 1;
  db.save();
  return ok(res, { status: 1 });
});

router.post('/app/user/info/offSell/:id', async (req, res) => {
  const user = await getAuthUser(req);
  user.onSellStatus = 0;
  db.save();
  return ok(res, { status: 0 });
});

router.get('/app/user/info/getInviterUrl', async (req, res) => {
  const user = await getAuthUser(req);
  const url = `${req.protocol}://${req.get('host')}/#/register?inviteCode=${user.inviteCode || 'LP8899'}`;
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

router.get('/app/payment/order/summary', async (req, res) => {
  const user = await getAuthUser(req);
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
  const user = await getAuthUser(req);
  try {
    const claimed = await orderEngine.claimOrder({
      payOrderId,
      payoutWalletId: Number(payoutWalletId),
      userId: user.id
    });
    return ok(res, claimed);
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

router.get('/app/payment/order/orderInfo', async (req, res) => {
  const { buyId } = req.query || {};
  const order = orderEngine.getOrderInfo(buyId);
  if (!order) {
    return fail(res, 'Order not found', 404);
  }
  await qrService.attachQrToOrder(order);
  return ok(res, order);
});

router.post('/app/payment/order/submit', async (req, res) => {
  const { buyId, utr, proofUrl } = req.body || {};
  const token = extractToken(req);
  try {
    const updated = orderEngine.submitOrder({ buyId, utr, proofUrl });
    const user = await getAuthUser(req);

    // Sync updated user balance & rewardTotal to Supabase
    await supabaseService.updateUserRecord(token, {
      balance: user.balance,
      totalBalance: user.balance,
      rewardTotal: user.rewardTotal
    });

    return ok(res, updated);
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

router.post('/app/payment/order/cancel', (req, res) => {
  const { buyId, reason } = req.body || {};
  try {
    const result = orderEngine.cancelOrder({ buyId, reason });
    return ok(res, result);
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

router.get('/app/payment/order/history', async (req, res) => {
  const user = await getAuthUser(req);
  const state = db.get();
  const orders = Object.values(state.claimedOrders).filter(o => o.userId === user.id);
  await Promise.all(orders.map(o => qrService.attachQrToOrder(o)));
  return ok(res, {
    records: orders,
    total: orders.length
  });
});

router.post('/app/payment/order/changeWallet', async (req, res) => {
  const { buyId, newPayoutWalletId } = req.body || {};
  const state = db.get();
  const order = state.claimedOrders[buyId];
  if (!order) return fail(res, 'Order not found', 404);
  const wallet = state.wallets.find(w => w.id === Number(newPayoutWalletId));
  if (!wallet) return fail(res, 'Wallet not found', 404);
  order.payoutWalletId = wallet.id;
  order.payoutWalletName = wallet.ctName;
  order.payoutAccount = wallet.account;
  await qrService.attachQrToOrder(order);
  db.save();
  return ok(res, order);
});

router.post('/app/payment/order/createUsdt', async (req, res) => {
  const { amount, chainType = 'TRC20' } = req.body || {};
  const state = db.get();
  const usdtId = 'USDT' + Date.now();
  const rate = state.settings?.usdtRechargeRate || 91.50;
  const inrAmount = Number((Number(amount || 0) * rate).toFixed(2));
  const addresses = {
    TRC20: 'TLxK9y5Bsq27Pz5vF7nK9yTRC20EXAMPLE',
    BSC: '0x71C95911e74B39d48b1968848777BSCEXAMPLE',
    Polygon: '0x99A8c829e74B39d48b1968848POLYGONEXAMPLE'
  };
  const address = addresses[chainType] || addresses.TRC20;
  const qrData = await qrService.attachQrToUsdt(chainType, address, amount);
  const order = {
    id: usdtId,
    usdtAmount: Number(amount || 0),
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
  return ok(res, { success: true });
});

// -------------------------------------------------------------
// 3. WALLETS & KYC (PER-USER SUPABASE MANAGEMENT)
// -------------------------------------------------------------
router.post('/app/ct/app/collection/getWalletList', async (req, res) => {
  const user = await getAuthUser(req);
  const state = db.get();
  let userWallets = state.wallets.filter(w => w.userId === user.id);
  if (!userWallets.length && user.id === '10086') {
    userWallets = state.wallets;
  }
  const enhanced = await Promise.all(userWallets.map(w => qrService.attachQrToWallet(w)));
  return ok(res, enhanced);
});

router.post('/app/ct/app/collection/getPayoutWalletList', async (req, res) => {
  const user = await getAuthUser(req);
  const state = db.get();
  let userWallets = state.wallets.filter(w => w.userId === user.id && w.status === 1);
  if (!userWallets.length && user.id === '10086') {
    userWallets = state.wallets.filter(w => w.status === 1);
  }
  const enhanced = await Promise.all(userWallets.map(w => qrService.attachQrToWallet(w)));
  return ok(res, enhanced);
});

router.post('/app/ct/app/collection/memberPayoutWallets', async (req, res) => {
  const user = await getAuthUser(req);
  const state = db.get();
  const userWallets = state.wallets.filter(w => w.userId === user.id);
  const enhanced = await Promise.all(userWallets.map(w => qrService.attachQrToWallet(w)));
  return ok(res, enhanced);
});

router.post('/app/ct/app/collection/submit', async (req, res) => {
  const { ctType, account, name, phone, minAmount = 500, maxAmount = 25000, dailyLimit = 100000 } = req.body || {};
  const user = await getAuthUser(req);
  const token = extractToken(req);
  const state = db.get();

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

  const newId = (state.wallets.length ? Math.max(...state.wallets.map(w => w.id)) : 100) + 1;
  const newWallet = {
    id: newId,
    userId: user.id,
    ctType: Number(ctType) || 3,
    ctName: ctNames[ctType] || 'UPI',
    account: account || 'user@upi',
    phone: phone || user.phone || '9876543210',
    name: name || user.nickname || 'Account Holder',
    status: 1,
    minAmount: Number(minAmount),
    maxAmount: Number(maxAmount),
    dailyLimit: Number(dailyLimit),
    todayTurnover: 0,
    todayCount: 0,
    successRate: 100.0,
    createdAt: new Date().toISOString()
  };

  await qrService.attachQrToWallet(newWallet);
  state.wallets.push(newWallet);
  db.save();

  // Persist updated user wallets to Supabase
  const userWallets = state.wallets.filter(w => w.userId === user.id);
  await supabaseService.updateUserRecord(token, { wallets: userWallets });

  return ok(res, newWallet);
});

router.post('/app/ct/app/collection/v2/submit', (req, res) => {
  return router.handle({ ...req, url: '/app/ct/app/collection/submit' }, res);
});

router.post('/app/ct/app/collection/changeStatus/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  const user = await getAuthUser(req);
  const token = extractToken(req);
  const state = db.get();

  const wallet = state.wallets.find(w => w.id === id);
  if (!wallet) return fail(res, 'Wallet not found', 404);
  wallet.status = status != null ? Number(status) : (wallet.status === 1 ? 0 : 1);
  db.save();

  const userWallets = state.wallets.filter(w => w.userId === user.id);
  await supabaseService.updateUserRecord(token, { wallets: userWallets });

  return ok(res, wallet);
});

router.post('/app/ct/app/collection/onSell/:id', async (req, res) => {
  const id = Number(req.params.id);
  const user = await getAuthUser(req);
  const token = extractToken(req);
  const state = db.get();
  const wallet = state.wallets.find(w => w.id === id);
  if (wallet) {
    wallet.status = 1;
    db.save();
    const userWallets = state.wallets.filter(w => w.userId === user.id);
    await supabaseService.updateUserRecord(token, { wallets: userWallets });
  }
  return ok(res, { success: true });
});

router.post('/app/ct/app/collection/offSell/:id', async (req, res) => {
  const id = Number(req.params.id);
  const user = await getAuthUser(req);
  const token = extractToken(req);
  const state = db.get();
  const wallet = state.wallets.find(w => w.id === id);
  if (wallet) {
    wallet.status = 0;
    db.save();
    const userWallets = state.wallets.filter(w => w.userId === user.id);
    await supabaseService.updateUserRecord(token, { wallets: userWallets });
  }
  return ok(res, { success: true });
});

router.post('/app/ct/app/collection/updateLimitedRange', async (req, res) => {
  const { id, minAmount, maxAmount } = req.body || {};
  const user = await getAuthUser(req);
  const token = extractToken(req);
  const state = db.get();
  const wallet = state.wallets.find(w => w.id === Number(id));
  if (!wallet) return fail(res, 'Wallet not found', 404);
  if (minAmount != null) wallet.minAmount = Number(minAmount);
  if (maxAmount != null) wallet.maxAmount = Number(maxAmount);
  db.save();

  const userWallets = state.wallets.filter(w => w.userId === user.id);
  await supabaseService.updateUserRecord(token, { wallets: userWallets });

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
router.get('/app/user/team/details', async (req, res) => {
  const user = await getAuthUser(req);
  const state = db.get();
  return ok(res, {
    commissionTotal: state.team.commissionTotal,
    yCommission: state.team.yCommission,
    teamTurnover: state.team.teamTurnover,
    memberTotal: state.team.members.length,
    activeCount: state.team.members.length,
    inviteCode: user.inviteCode || 'LP8899'
  });
});

router.get('/app/user/team/members', (req, res) => {
  const state = db.get();
  return ok(res, {
    records: state.team.members,
    total: state.team.members.length
  });
});

router.get('/app/user/team/subMembers', (req, res) => {
  const state = db.get();
  return ok(res, {
    records: state.team.members,
    total: state.team.members.length
  });
});

router.get('/app/user/team/invites', async (req, res) => {
  const user = await getAuthUser(req);
  const code = user.inviteCode || 'LP8899';
  return ok(res, {
    inviteCode: code,
    inviteUrl: `${req.protocol}://${req.get('host')}/#/register?inviteCode=${code}`
  });
});

router.post('/app/user/team/members/ratio', (req, res) => {
  const { tier1, tier2, tier3 } = req.body || {};
  const state = db.get();
  if (tier1 != null) state.team.ratios.tier1 = Number(tier1);
  if (tier2 != null) state.team.ratios.tier2 = Number(tier2);
  if (tier3 != null) state.team.ratios.tier3 = Number(tier3);
  db.save();
  return ok(res, state.team.ratios);
});

// -------------------------------------------------------------
// 5. APP, NOTICES, MISSIONS & REWARDS
// -------------------------------------------------------------
router.post('/app/app/carousel/manager/carouselManager', (req, res) => {
  return ok(res, [
    { id: 1, imgUrl: '/static/banner/banner.jpg', link: '' },
    { id: 2, imgUrl: '/static/banner/ad1.png', link: '' },
    { id: 3, imgUrl: '/static/banner/ad2.png', link: '' }
  ]);
});

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

router.get('/app/mission/task', (req, res) => {
  const state = db.get();
  return ok(res, state.missions);
});

router.post('/app/mission/task/receive/:id', async (req, res) => {
  const id = Number(req.params.id);
  const user = await getAuthUser(req);
  const token = extractToken(req);
  const state = db.get();
  const m = state.missions.find(t => t.id === id);
  if (m) {
    m.claimed = true;
    user.points = (user.points || 0) + m.reward;
    db.save();
    await supabaseService.updateUserRecord(token, { points: user.points });
  }
  return ok(res, { success: true });
});

router.get('/app/newcomer-rewards/entry', (req, res) => {
  return ok(res, { enabled: true, amount: 88 });
});

router.get('/app/newcomer-rewards/detail', (req, res) => {
  return ok(res, { claimed: false, amount: 88 });
});

router.post('/app/newcomer-rewards/claim/:id', async (req, res) => {
  const user = await getAuthUser(req);
  const token = extractToken(req);
  user.balance += 88;
  user.totalBalance += 88;
  db.save();
  await supabaseService.updateUserRecord(token, { balance: user.balance });
  return ok(res, { amount: 88 });
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
  const order = orderEngine.spawnSampleOrder();
  return ok(res, order, 'Simulated order created');
});

module.exports = router;
