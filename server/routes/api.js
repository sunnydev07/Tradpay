const express = require('express');
const router = express.Router();
const db = require('../engine/db');
const orderEngine = require('../engine/orderEngine');

// Response helper
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

// -------------------------------------------------------------
// 1. AUTH & USER
// -------------------------------------------------------------
router.post('/app/user/login/login', (req, res) => {
  const { phone, password, verifyCode } = req.body || {};
  const state = db.get();
  // Find or create user
  let user = Object.values(state.users).find(u => u.phone === phone);
  if (!user) {
    const newId = String(Math.floor(10000 + Math.random() * 90000));
    user = {
      id: newId,
      userId: newId,
      phone: phone || '+919876543210',
      nickname: 'User_' + newId,
      avatar: '/static/user/profile.png',
      balance: 10000.00,
      totalBalance: 10000.00,
      rewardTotal: 0,
      pending: 0,
      points: 500,
      vipLevel: 1,
      inviteCode: 'LP' + newId.slice(-4),
      pin: '123456',
      isPinSet: true,
      onSellStatus: 1,
      createdAt: new Date().toISOString()
    };
    state.users[newId] = user;
  }
  const token = 'token_' + user.id;
  state.tokens[token] = user.id;
  db.save();

  return ok(res, {
    token,
    userId: user.id,
    phone: user.phone,
    nickname: user.nickname
  });
});

router.post('/app/user/login/start', (req, res) => {
  return ok(res, { sessionId: 'SES_' + Date.now(), needOtp: false });
});

router.post('/app/user/login/confirm', (req, res) => {
  return ok(res, { token: 'token_10086', userId: '10086' });
});

router.post('/app/user/login/sendOtp', (req, res) => {
  return ok(res, { success: true, msg: 'OTP sent successfully (Use 123456)' });
});

router.post('/app/user/rs/submit', (req, res) => {
  const { phone } = req.body || {};
  const state = db.get();
  const newId = String(Math.floor(10000 + Math.random() * 90000));
  const user = {
    id: newId,
    userId: newId,
    phone: phone || '+919876543210',
    nickname: 'Trader_' + newId,
    avatar: '/static/user/profile.png',
    balance: 5000.00,
    totalBalance: 5000.00,
    rewardTotal: 0,
    pending: 0,
    points: 200,
    vipLevel: 1,
    inviteCode: 'LP' + newId.slice(-4),
    pin: '123456',
    isPinSet: true,
    onSellStatus: 1,
    createdAt: new Date().toISOString()
  };
  state.users[newId] = user;
  const token = 'token_' + newId;
  state.tokens[token] = newId;
  db.save();

  return ok(res, { token, userId: newId });
});

router.get('/app/user/rs/invite/prefill', (req, res) => {
  return ok(res, { inviteCode: 'LP8899' });
});

router.get('/app/user/info', (req, res) => {
  const state = db.get();
  const user = state.users['10086'] || Object.values(state.users)[0];
  return ok(res, user);
});

router.get('/app/user/info/person', (req, res) => {
  const state = db.get();
  const user = state.users['10086'] || Object.values(state.users)[0];
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
  const state = db.get();
  const user = state.users['10086'] || Object.values(state.users)[0];
  if (pin === user.pin || pin === '123456') {
    return ok(res, { verified: true });
  }
  return fail(res, 'Incorrect Security PIN', 400);
});

router.post('/app/user/info/updatePin', (req, res) => {
  const { oldPin, newPin } = req.body || {};
  const state = db.get();
  const user = state.users['10086'] || Object.values(state.users)[0];
  user.pin = newPin || '123456';
  user.isPinSet = true;
  db.save();
  return ok(res, { success: true });
});

router.post('/app/user/info/updatePassword', (req, res) => {
  return ok(res, { success: true });
});

router.post('/app/user/info/onSell/:id', (req, res) => {
  const state = db.get();
  const user = state.users['10086'] || Object.values(state.users)[0];
  user.onSellStatus = 1;
  db.save();
  return ok(res, { status: 1 });
});

router.post('/app/user/info/offSell/:id', (req, res) => {
  const state = db.get();
  const user = state.users['10086'] || Object.values(state.users)[0];
  user.onSellStatus = 0;
  db.save();
  return ok(res, { status: 0 });
});

router.get('/app/user/info/getInviterUrl', (req, res) => {
  const state = db.get();
  const user = state.users['10086'] || Object.values(state.users)[0];
  const url = `${req.protocol}://${req.get('host')}/#/register?inviteCode=${user.inviteCode}`;
  return ok(res, {
    url,
    inviteCode: user.inviteCode,
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
// 2. ORDERS (COVER ORDER & HANG SALES)
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
  const state = db.get();
  const user = state.users['10086'] || Object.values(state.users)[0];
  return ok(res, {
    balance: user.balance,
    totalBalance: user.totalBalance,
    rewardTotal: user.rewardTotal,
    pending: user.pending,
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

router.post('/app/payment/order/create', (req, res) => {
  const { payOrderId, payoutWalletId } = req.body || {};
  try {
    const claimed = orderEngine.claimOrder({
      payOrderId,
      payoutWalletId: Number(payoutWalletId),
      userId: '10086'
    });
    return ok(res, claimed);
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

router.get('/app/payment/order/orderInfo', (req, res) => {
  const { buyId } = req.query || {};
  const order = orderEngine.getOrderInfo(buyId);
  if (!order) {
    return fail(res, 'Order not found', 404);
  }
  return ok(res, order);
});

router.post('/app/payment/order/submit', (req, res) => {
  const { buyId, utr, proofUrl } = req.body || {};
  try {
    const updated = orderEngine.submitOrder({ buyId, utr, proofUrl });
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

router.get('/app/payment/order/history', (req, res) => {
  const state = db.get();
  const orders = Object.values(state.claimedOrders);
  return ok(res, {
    records: orders,
    total: orders.length
  });
});

router.post('/app/payment/order/changeWallet', (req, res) => {
  const { buyId, newPayoutWalletId } = req.body || {};
  const state = db.get();
  const order = state.claimedOrders[buyId];
  if (!order) return fail(res, 'Order not found', 404);
  const wallet = state.wallets.find(w => w.id === Number(newPayoutWalletId));
  if (!wallet) return fail(res, 'Wallet not found', 404);
  order.payoutWalletId = wallet.id;
  order.payoutWalletName = wallet.ctName;
  order.payoutAccount = wallet.account;
  db.save();
  return ok(res, order);
});

router.post('/app/payment/order/createUsdt', (req, res) => {
  const { amount, chainType = 'TRC20' } = req.body || {};
  const state = db.get();
  const usdtId = 'USDT' + Date.now();
  const rate = state.settings.usdtRechargeRate;
  const inrAmount = Number((Number(amount) * rate).toFixed(2));
  const addresses = {
    TRC20: 'TLxK9y5Bsq27Pz5vF7nK9yTRC20EXAMPLE',
    BSC: '0x71C95911e74B39d48b1968848777BSCEXAMPLE',
    Polygon: '0x99A8c829e74B39d48b1968848POLYGONEXAMPLE'
  };
  const order = {
    id: usdtId,
    usdtAmount: Number(amount),
    inrAmount,
    rate,
    chainType,
    address: addresses[chainType] || addresses.TRC20,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  return ok(res, order);
});

router.get('/app/payment/order/usdtInfo', (req, res) => {
  return ok(res, {
    rate: 91.50,
    chains: ['TRC20', 'BSC', 'Polygon']
  });
});

router.post('/app/payment/app/buy/order/usdt', (req, res) => {
  return ok(res, { success: true });
});

// -------------------------------------------------------------
// 3. WALLETS & KYC
// -------------------------------------------------------------
router.post('/app/ct/app/collection/getWalletList', (req, res) => {
  const state = db.get();
  return ok(res, state.wallets);
});

router.post('/app/ct/app/collection/getPayoutWalletList', (req, res) => {
  const state = db.get();
  // Filter active wallets
  const active = state.wallets.filter(w => w.status === 1);
  return ok(res, active);
});

router.post('/app/ct/app/collection/memberPayoutWallets', (req, res) => {
  const state = db.get();
  return ok(res, state.wallets);
});

router.post('/app/ct/app/collection/submit', (req, res) => {
  const { ctType, account, name, phone, minAmount = 500, maxAmount = 20000, dailyLimit = 100000 } = req.body || {};
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
    userId: '10086',
    ctType: Number(ctType) || 3,
    ctName: ctNames[ctType] || 'UPI',
    account: account || 'user@upi',
    phone: phone || '9876543210',
    name: name || 'Account Holder',
    status: 1,
    minAmount: Number(minAmount),
    maxAmount: Number(maxAmount),
    dailyLimit: Number(dailyLimit),
    todayTurnover: 0,
    todayCount: 0,
    successRate: 100.0,
    createdAt: new Date().toISOString()
  };
  state.wallets.push(newWallet);
  db.save();

  return ok(res, newWallet);
});

router.post('/app/ct/app/collection/v2/submit', (req, res) => {
  return router.handle({ ...req, url: '/app/ct/app/collection/submit' }, res);
});

router.post('/app/ct/app/collection/changeStatus/:id', (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  const state = db.get();
  const wallet = state.wallets.find(w => w.id === id);
  if (!wallet) return fail(res, 'Wallet not found', 404);
  wallet.status = status != null ? Number(status) : (wallet.status === 1 ? 0 : 1);
  db.save();
  return ok(res, wallet);
});

router.post('/app/ct/app/collection/onSell/:id', (req, res) => {
  const id = Number(req.params.id);
  const state = db.get();
  const wallet = state.wallets.find(w => w.id === id);
  if (wallet) {
    wallet.status = 1;
    db.save();
  }
  return ok(res, { success: true });
});

router.post('/app/ct/app/collection/offSell/:id', (req, res) => {
  const id = Number(req.params.id);
  const state = db.get();
  const wallet = state.wallets.find(w => w.id === id);
  if (wallet) {
    wallet.status = 0;
    db.save();
  }
  return ok(res, { success: true });
});

router.post('/app/ct/app/collection/updateLimitedRange', (req, res) => {
  const { id, minAmount, maxAmount } = req.body || {};
  const state = db.get();
  const wallet = state.wallets.find(w => w.id === Number(id));
  if (!wallet) return fail(res, 'Wallet not found', 404);
  if (minAmount != null) wallet.minAmount = Number(minAmount);
  if (maxAmount != null) wallet.maxAmount = Number(maxAmount);
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
  const state = db.get();
  return ok(res, {
    commissionTotal: state.team.commissionTotal,
    yCommission: state.team.yCommission,
    teamTurnover: state.team.teamTurnover,
    memberTotal: state.team.members.length,
    activeCount: state.team.members.length
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

router.get('/app/user/team/invites', (req, res) => {
  const state = db.get();
  return ok(res, {
    inviteCode: 'LP8899',
    inviteUrl: `${req.protocol}://${req.get('host')}/#/register?inviteCode=LP8899`
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

router.post('/app/mission/task/receive/:id', (req, res) => {
  const id = Number(req.params.id);
  const state = db.get();
  const m = state.missions.find(t => t.id === id);
  if (m) {
    m.claimed = true;
    const user = state.users['10086'] || Object.values(state.users)[0];
    user.points += m.reward;
    db.save();
  }
  return ok(res, { success: true });
});

router.get('/app/newcomer-rewards/entry', (req, res) => {
  return ok(res, { enabled: true, amount: 88 });
});

router.get('/app/newcomer-rewards/detail', (req, res) => {
  return ok(res, { claimed: false, amount: 88 });
});

router.post('/app/newcomer-rewards/claim/:id', (req, res) => {
  const state = db.get();
  const user = state.users['10086'] || Object.values(state.users)[0];
  user.balance += 88;
  user.totalBalance += 88;
  db.save();
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
