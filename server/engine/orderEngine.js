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

  return list;
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
    ['pending', 'confirming', 'completed'].includes(o.status)
  );
  if (alreadyClaimed) {
    throw new Error('Order is no longer available or already taken');
  }

  const nightBonus = state.settings.nightBonus || {};
  const isNight = isNightBonusNow(nightBonus);
  const multiplier = Number(nightBonus.multiplier) || 1.25;
  let bonusAmount = 0;
  if (isNight && nightBonus.enabled) {
    bonusAmount = money.multiply(order.reward, multiplier - 1);
  }

  const buyId = generateId('BUY');
  const claimedRecord = {
    id: buyId,
    buyId,
    payOrderId: order.payOrderId,
    orderNo: order.orderNo,
    amount: order.amount,
    currency: order.currency || 'INR',
    reward: order.reward,
    smallAmountBonus: isNight,
    smallAmountBonusAmount: bonusAmount,
    totalReward: money.add(order.reward, bonusAmount),
    status: 'pending',
    payoutWalletId: wallet.id,
    payoutWalletName: wallet.ctName,
    payoutAccount: wallet.account,
    userId,
    buyerUpi: 'buyer.' + Math.floor(100000 + Math.random() * 900000) + '@okhdfcbank',
    buyerPhone: '+919' + Math.floor(100000000 + Math.random() * 900000000),
    utr: null,
    expireSeconds: 900,
    expireAt: new Date(Date.now() + 900 * 1000).toISOString(),
    createdAt: new Date().toISOString()
  };

  // Reserve atomically before the first await. This closes the claim race:
  // two concurrent requests can no longer both observe the sale as pending.
  order.status = 'processing';
  state.claimedOrders[buyId] = claimedRecord;
  db.save();

  try {
    await qrService.attachQrToOrder(claimedRecord);
    if (claimedRecord.payeeVpa !== wallet.account) {
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
  ) || (state.deposits || []).some(d => String(d.utr) === cleanUtr);
  if (duplicateUtr) {
    throw new Error('This UTR has already been used');
  }

  order.status = 'completed';
  order.utr = cleanUtr;
  order.proofUrl = typeof proofUrl === 'string' ? proofUrl.slice(0, 500) : '';
  order.completedAt = new Date().toISOString();

  const sale = state.hangSales.find(o => o.payOrderId === order.payOrderId);
  if (sale) sale.status = 'completed';

  const user = state.users[order.userId];
  if (user) {
    const reward = Number(order.totalReward) || 0;
    user.balance = money.add(user.balance, reward);
    user.totalBalance = user.balance;
    user.rewardTotal = money.add(user.rewardTotal, reward);
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
    msg: `Payment of ₹${order.amount} completed! Earned ₹${order.totalReward} reward.`
  });

  return order;
}

// Cancel an order. Completed orders can never be cancelled or restored.
function cancelOrder({ buyId, userId, reason = 'User requested' }) {
  if (!userId) throw new Error('Authentication required');

  const state = db.get();
  const order = findClaimedOrder(state, buyId);
  if (!order) throw new Error('Order not found');
  if (String(order.userId) !== String(userId)) throw new Error('Order not found');

  if (order.status === 'completed') throw new Error('Completed orders cannot be cancelled');
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
  const rate = Number((1.2 + Math.random() * 0.5).toFixed(2));
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
  cancelOrder,
  spawnSampleOrder,
  startSimulation,
  setBroadcaster,
  isNightBonusNow
};
