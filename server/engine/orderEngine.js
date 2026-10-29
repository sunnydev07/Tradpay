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

function minutesInTimeZone(timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const hour = Number(parts.find(p => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find(p => p.type === 'minute')?.value || 0);
  return hour * 60 + minute;
}

// Check the configured night bonus window in the business timezone.
function isNightBonusNow(settings) {
  const state = db.get();
  const cfg = settings || state.settings.nightBonus;
  if (!cfg || cfg.enabled === false) return false;

  const [startHour, startMinute] = String(cfg.startTime || '22:00').split(':').map(Number);
  const [endHour, endMinute] = String(cfg.endTime || '06:00').split(':').map(Number);
  const start = (startHour * 60) + (startMinute || 0);
  const end = (endHour * 60) + (endMinute || 0);
  const now = minutesInTimeZone(process.env.BONUS_TIMEZONE || 'Asia/Kolkata');

  if (start === end) return true;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

// Generate unique order ID
function generateId(prefix = 'PO') {
  const now = new Date();
  const ymd = now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const rnd = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}${ymd}${rnd}`;
}

function findClaimedOrder(state, buyId) {
  if (!security.isValidBuyId(buyId)) return null;
  if (!Object.prototype.hasOwnProperty.call(state.claimedOrders, buyId)) return null;
  return state.claimedOrders[buyId];
}

function restoreHangSale(state, order) {
  const original = state.hangSales.find(o => o.payOrderId === order.payOrderId);
  if (original && original.status === 'processing') {
    original.status = 'pending';
  }
}

function expireIfNeeded(state, order) {
  if (!order || !['pending', 'confirming'].includes(order.status)) return false;
  if (!order.expireAt) return false;
  if (new Date(order.expireAt).getTime() > Date.now()) return false;

  order.status = 'expired';
  order.expiredAt = new Date().toISOString();
  restoreHangSale(state, order);
  db.save();
  return true;
}

// A claimable order always pays at least 20% of its amount as bonus reward.
function effectiveReward(order) {
  const amount = Number(order && order.amount) || 0;
  const reward = Number(order && order.reward) || 0;
  return Math.max(reward, money.minimumOrderReward(amount));
}

function effectiveRewardRate(order) {
  return Math.max(Number(order && order.rewardRate) || 0, money.MIN_ORDER_REWARD_PERCENT);
}

// Query hang sales orders with filters and sorting
function getHangSales(params = {}) {
  const state = db.get();
  let list = state.hangSales.filter(o => o.status === 'pending');

  const min = params.minAmount != null ? Number(params.minAmount) : null;
  const max = params.maxAmount != null ? Number(params.maxAmount) : null;

  if (min != null && Number.isFinite(min)) {
    list = list.filter(o => o.amount >= min);
  }
  if (max != null && Number.isFinite(max)) {
    list = list.filter(o => o.amount <= max);
  }

  if (Number(params.sort) === 1) {
    list.sort((a, b) => a.amount - b.amount);
  } else if (Number(params.sort) === 2) {
    list.sort((a, b) => b.amount - a.amount);
  } else {
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  return list.map(order => ({
    ...order,
    reward: effectiveReward(order),
    rewardRate: effectiveRewardRate(order)
  }));
}

// Claim an order (pages/payment/payment.vue -> createOrder)
async function claimOrder({ payOrderId, payoutWalletId, userId }) {
  if (!userId) throw new Error('Authentication required');
  if (typeof payOrderId !== 'string' || !payOrderId.trim()) {
    throw new Error('Invalid order reference');
  }

  const state = db.get();
  const order = state.hangSales.find(o => o.payOrderId === payOrderId && o.status === 'pending');
  if (!order) {
    throw new Error('Order is no longer available or already taken');
  }

  // A user may only claim against a wallet they own. Official/system wallets
  // are intentionally excluded from user order payouts.
  const wallet = state.wallets.find(w =>
    w.id === Number(payoutWalletId) && String(w.userId) === String(userId)
  );
  if (!wallet) {
    throw new Error('Selected payout wallet was not found');
  }
  if (wallet.status !== 1) {
    throw new Error('Selected wallet is not active (offSell)');
  }

  const minAmount = Number(wallet.minAmount);
  const maxAmount = Number(wallet.maxAmount);
  if (!Number.isFinite(minAmount) || !Number.isFinite(maxAmount) || minAmount > maxAmount) {
    throw new Error('Selected wallet has invalid payout limits');
  }
  if (order.amount < minAmount || order.amount > maxAmount) {
    throw new Error(`Order amount ₹${order.amount} is outside wallet limit [₹${minAmount} - ₹${maxAmount}]`);
  }

  const alreadyClaimed = Object.values(state.claimedOrders).some(o =>
    o.payOrderId === order.payOrderId &&
    ['pending', 'confirming', 'verifying', 'completed'].includes(o.status)
  );
  if (alreadyClaimed) {
    throw new Error('Order is no longer available or already taken');
  }

  const nightBonus = state.settings.nightBonus || {};
  const isNight = isNightBonusNow(nightBonus);
  const multiplier = Number(nightBonus.multiplier) || 1.25;
  const baseReward = effectiveReward(order);
  let bonusAmount = 0;
  if (isNight && nightBonus.enabled) {
    bonusAmount = money.multiply(baseReward, multiplier - 1);
  }

  const buyId = generateId('BUY');
  const claimedRecord = {
    id: buyId,
    buyId,
    payOrderId: order.payOrderId,
    orderNo: order.orderNo,
    amount: order.amount,
    currency: order.currency || 'INR',
    reward: baseReward,
    rewardRate: effectiveRewardRate(order),
    smallAmountBonus: isNight,
    smallAmountBonusAmount: bonusAmount,
    totalReward: money.add(baseReward, bonusAmount),
    status: 'pending',
    payoutWalletId: wallet.id,
    payoutWalletName: wallet.ctName,
    payoutAccount: wallet.account,
    userId,
    utr: null,
    expireSeconds: 900,
    expireAt: new Date(Date.now() + 900 * 1000).toISOString(),
    createdAt: new Date().toISOString()
  };

  // Reserve atomically before the first await. This closes the claim race:
  // two concurrent requests can no longer both observe the sale as pending.
  order.status = 'processing';
  state.claimedOrders[buyId] = claimedRecord;

  // Bound memory and db.json size by pruning stale completed/expired orders if count exceeds 2000
  const orderKeys = Object.keys(state.claimedOrders);
  if (orderKeys.length > 2000) {
    const list = orderKeys.map(k => state.claimedOrders[k]).filter(Boolean);
    list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    const toKeep = new Set();
    let kept = 0;
    for (const ord of list) {
      const isPending = ['pending', 'confirming', 'verifying'].includes(ord.status);
      if (isPending || kept < 1500) {
        toKeep.add(ord.buyId || ord.id);
        kept++;
      }
    }
    for (const k of orderKeys) {
      if (!toKeep.has(k)) {
        delete state.claimedOrders[k];
      }
    }
  }

  db.save();

  try {
    await qrService.attachQrToOrder(claimedRecord);
    if (!claimedRecord.payeeVpa) {
      throw new Error('Unable to generate a payment QR for the selected wallet');
    }
    db.save();
  } catch (err) {
    delete state.claimedOrders[buyId];
    order.status = 'pending';
    db.save();
    throw err;
  }

  // Broadcast a minimal notification to the owning user only.
  broadcast('ORDER_CLAIMED', {
    userId,
    buyId,
    amount: order.amount,
    walletName: wallet.ctName,
    msg: `Order for ₹${order.amount} claimed successfully!`
  });

  return claimedRecord;
}

// Get order details, scoped to the owner when userId is supplied.
function getOrderInfo(buyId, userId) {
  const state = db.get();
  const order = findClaimedOrder(state, buyId);
  if (!order) return null;
  if (userId && String(order.userId) !== String(userId)) return null;

  expireIfNeeded(state, order);

  const remainingMs = new Date(order.expireAt).getTime() - Date.now();
  order.expireSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  return order;
}

// Submit payment / UTR confirmation. Idempotent and owner-scoped.
function submitOrder({ buyId, utr = '', proofUrl = '', userId }) {
  if (!userId) throw new Error('Authentication required');

  const state = db.get();
  const order = findClaimedOrder(state, buyId);
  if (!order) throw new Error('Order not found');
  if (String(order.userId) !== String(userId)) throw new Error('Order not found');

  if (expireIfNeeded(state, order)) {
    throw new Error('Order has expired');
  }
  if (order.status !== 'pending' && order.status !== 'confirming') {
    throw new Error(`Order cannot be submitted from status "${order.status}"`);
  }

  const cleanUtr = String(utr || '').trim();
  if (!security.isValidUtr(cleanUtr)) {
    throw new Error('A valid 12-digit bank UTR is required');
  }

  const duplicateUtr = Object.values(state.claimedOrders).some(o =>
    o.buyId !== order.buyId && o.utr && String(o.utr) === cleanUtr
  );  if (duplicateUtr) {
    throw new Error('This UTR has already been used');
  }

  order.status = 'verifying';
  order.utr = cleanUtr;
  order.proofUrl = typeof proofUrl === 'string' ? proofUrl.slice(0, 500) : '';
  order.submittedAt = new Date().toISOString();

  db.save();

  broadcast('ORDER_VERIFYING', {
    userId: order.userId,
    buyId,
    orderNo: order.orderNo,
    amount: order.amount,
    totalReward: order.totalReward,
    utr: cleanUtr,
    status: 'verifying',
    msg: `Payment Ref No. ${cleanUtr} submitted. Verifying reference number...`
  });

  broadcast('ADMIN_ORDER_NEEDS_VERIFICATION', {
    buyId: order.buyId,
    orderNo: order.orderNo,
    amount: order.amount,
    totalReward: order.totalReward,
    utr: cleanUtr,
    userId: order.userId,
    payoutAccount: order.payoutAccount,
    payoutWalletName: order.payoutWalletName,
    submittedAt: order.submittedAt
  });

  return order;
}

// Admin verifies and confirms (or rejects) the submitted bank UTR
function verifyOrder({ buyId, adminId = 'admin', action = 'confirm', reason = '' }) {
  const state = db.get();
  const order = findClaimedOrder(state, buyId);
  if (!order) throw new Error('Order not found');

  if (order.status !== 'verifying') {
    throw new Error(`Order cannot be verified from status "${order.status}"`);
  }

  if (action === 'confirm') {
    order.status = 'completed';
    order.verifiedAt = new Date().toISOString();
    order.completedAt = order.verifiedAt;
    order.verifiedBy = String(adminId);

    const sale = state.hangSales.find(o => o.payOrderId === order.payOrderId);
    if (sale) sale.status = 'completed';

    const user = state.users[order.userId];
    if (user) {
      const reward = Number(order.totalReward) || 0;
      user.balance = money.add(user.balance, reward);
      user.totalBalance = user.balance;
      user.rewardTotal = money.add(user.rewardTotal, reward);
      if (!Array.isArray(user.claimedOrders)) user.claimedOrders = [];
      if (!user.claimedOrders.includes(buyId)) {
        user.claimedOrders.push(buyId);
      }
    }

    const wallet = state.wallets.find(w => w.id === order.payoutWalletId);
    if (wallet) {
      wallet.todayTurnover = money.add(wallet.todayTurnover, order.amount);
      wallet.todayCount = (Number(wallet.todayCount) || 0) + 1;
    }

    const tier1 = Number(state.team.ratios.tier1) || 0.6;
    state.team.commissionTotal = money.add(
      state.team.commissionTotal,
      money.percentage(order.amount, tier1)
    );
    state.team.teamTurnover = money.add(state.team.teamTurnover, order.amount);

    db.save();

    if (user) {
      try {
        const supabaseService = require('./supabaseService');
        supabaseService.syncUserData(user).catch(() => {});
      } catch (e) {}
    }

    broadcast('ORDER_COMPLETED', {
      userId: order.userId,
      buyId,
      amount: order.amount,
      reward: order.totalReward,
      utr: order.utr,
      msg: `Payment of ₹${order.amount} verified & confirmed! Earned ₹${order.totalReward} reward.`
    });

    broadcast('ORDER_VERIFIED', {
      userId: order.userId,
      buyId,
      amount: order.amount,
      reward: order.totalReward,
      utr: order.utr,
      status: 'completed',
      msg: `Ref No. ${order.utr} has been verified by admin. ₹${order.totalReward} credited to your balance!`
    });

    return order;
  } else if (action === 'reject') {
    order.status = 'rejected';
    order.rejectedAt = new Date().toISOString();
    order.rejectReason = String(reason || 'Bank reference number could not be verified').slice(0, 200);
    order.verifiedBy = String(adminId);

    restoreHangSale(state, order);
    db.save();

    broadcast('ORDER_REJECTED', {
      userId: order.userId,
      buyId,
      amount: order.amount,
      utr: order.utr,
      status: 'rejected',
      reason: order.rejectReason,
      msg: `Verification failed for Ref No. ${order.utr}: ${order.rejectReason}`
    });

    return order;
  } else {
    throw new Error(`Invalid verification action: ${action}`);
  }
}

// Get all orders awaiting admin verification
function getPendingVerifications() {
  const state = db.get();
  const list = Object.values(state.claimedOrders)
    .filter(o => o && o.status === 'verifying')
    .sort((a, b) => new Date(b.submittedAt || b.createdAt) - new Date(a.submittedAt || a.createdAt));

  return list.map(o => {
    const user = state.users[o.userId];
    return {
      ...o,
      userNickname: user ? user.nickname : 'Trader',
      userPhone: user ? user.phone : ''
    };
  });
}

// Query all claimed orders for admin audit console
function getAllOrdersForAdmin(filter = 'all') {
  const state = db.get();
  let list = Object.values(state.claimedOrders);
  if (filter && filter !== 'all') {
    list = list.filter(o => o && o.status === filter);
  }
  list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return list.map(o => {
    const user = state.users[o.userId];
    return {
      ...o,
      userNickname: user ? user.nickname : 'Trader',
      userPhone: user ? user.phone : ''
    };
  });
}

// Cancel an order. Completed or verifying orders can never be cancelled by the user.
function cancelOrder({ buyId, userId, reason = 'User requested' }) {
  if (!userId) throw new Error('Authentication required');

  const state = db.get();
  const order = findClaimedOrder(state, buyId);
  if (!order) throw new Error('Order not found');
  if (String(order.userId) !== String(userId)) throw new Error('Order not found');

  if (order.status === 'completed') throw new Error('Completed orders cannot be cancelled');
  if (order.status === 'verifying') throw new Error('Order is currently under admin verification and cannot be cancelled');
  if (order.status === 'cancelled') throw new Error('Order is already cancelled');
  if (order.status === 'expired') throw new Error('Order has expired');
  if (order.status !== 'pending' && order.status !== 'confirming') {
    throw new Error(`Order cannot be cancelled from status "${order.status}"`);
  }

  order.status = 'cancelled';
  order.cancelReason = String(reason || 'User requested').slice(0, 200);
  order.cancelledAt = new Date().toISOString();
  restoreHangSale(state, order);

  db.save();
  broadcast('ORDER_CANCELLED', {
    userId: order.userId,
    buyId,
    msg: 'Order cancelled'
  });
  return { success: true };
}

// Create automated realistic pending order (simulated order matching pipeline)
function spawnSampleOrder() {
  const state = db.get();
  const amounts = [500, 800, 1200, 2000, 2500, 3500, 5000, 7500, 10000, 15000];
  const amount = amounts[Math.floor(Math.random() * amounts.length)];
  const rate = money.MIN_ORDER_REWARD_PERCENT;
  const reward = money.percentage(amount, rate);
  const id = generateId('PO');

  const newOrder = {
    payOrderId: id,
    orderNo: id,
    amount,
    reward,
    rewardRate: rate,
    currency: 'INR',
    status: 'pending',
    allowedTypes: [2, 3, 4, 5],
    createdAt: new Date().toISOString()
  };

  // Preserve in-flight (processing) orders; only trim stale pending entries.
  state.hangSales = state.hangSales.filter(o => o.status === 'pending' || o.status === 'processing');
  const pending = state.hangSales
    .filter(o => o.status === 'pending')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (pending.length > 10) {
    const oldest = pending[0];
    state.hangSales = state.hangSales.filter(o => o !== oldest);
  }
  state.hangSales.push(newOrder);
  db.save();

  broadcast('NEW_ORDER_DISPATCHED', {
    order: newOrder,
    msg: `New incoming order of ₹${amount} available for matching!`
  });

  return newOrder;
}

// Start periodic order simulation every 25 seconds
let simInterval = null;
function startSimulation() {
  if (simInterval) clearInterval(simInterval);
  simInterval = setInterval(() => {
    try {
      if (process.env.ALLOW_SIMULATION === 'false') return;
      spawnSampleOrder();
    } catch (e) {
      console.error('[Sim] error:', e);
    }
  }, 25000);
}

module.exports = {
  getHangSales,
  claimOrder,
  getOrderInfo,
  submitOrder,
  verifyOrder,
  getPendingVerifications,
  getAllOrdersForAdmin,
  cancelOrder,
  spawnSampleOrder,
  startSimulation,
  setBroadcaster,
  isNightBonusNow
};
