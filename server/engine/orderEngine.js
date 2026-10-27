const db = require('./db');

let wsBroadcaster = null;

function setBroadcaster(fn) {
  wsBroadcaster = fn;
}

function broadcast(type, payload) {
  if (typeof wsBroadcaster === 'function') {
    wsBroadcaster({ type, payload, timestamp: Date.now() });
  }
}

// Check if currently within night bonus time window (default 22:00 - 06:00)
function isNightBonusNow() {
  const d = new Date();
  const hours = d.getHours();
  return hours >= 22 || hours < 6;
}

// Generate unique order ID
function generateId(prefix = 'PO') {
  const now = new Date();
  const ymd = now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const rnd = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}${ymd}${rnd}`;
}

// Query hang sales orders with filters and sorting
function getHangSales(params = {}) {
  const state = db.get();
  let list = state.hangSales.filter(o => o.status === 'pending');

  const min = params.minAmount != null ? Number(params.minAmount) : null;
  const max = params.maxAmount != null ? Number(params.maxAmount) : null;

  if (min != null) {
    list = list.filter(o => o.amount >= min);
  }
  if (max != null) {
    list = list.filter(o => o.amount <= max);
  }

  // Sorting: 1 = Asc, 2 = Desc
  if (Number(params.sort) === 1) {
    list.sort((a, b) => a.amount - b.amount);
  } else if (Number(params.sort) === 2) {
    list.sort((a, b) => b.amount - a.amount);
  } else {
    // default: most recent first
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  return list;
}

// Claim an order (pages/payment/payment.vue -> createOrder)
function claimOrder({ payOrderId, payoutWalletId, userId = '10086' }) {
  const state = db.get();
  const order = state.hangSales.find(o => o.payOrderId === payOrderId && o.status === 'pending');

  if (!order) {
    throw new Error('Order is no longer available or already taken');
  }

  const wallet = state.wallets.find(w => w.id === payoutWalletId);
  if (!wallet) {
    throw new Error('Selected payout wallet was not found');
  }

  if (wallet.status !== 1) {
    throw new Error('Selected wallet is not active (offSell)');
  }

  if (order.amount < wallet.minAmount || order.amount > wallet.maxAmount) {
    throw new Error(`Order amount ₹${order.amount} is outside wallet limit [₹${wallet.minAmount} - ₹${wallet.maxAmount}]`);
  }

  // Calculate reward
  const isNight = isNightBonusNow();
  let bonusAmount = 0;
  if (isNight && state.settings.nightBonus.enabled) {
    bonusAmount = Number((order.reward * 0.25).toFixed(2));
  }

  // Create claimed order record
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
    totalReward: Number((order.reward + bonusAmount).toFixed(2)),
    status: 'pending', // pending, confirming, completed, cancelled
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

  state.claimedOrders[buyId] = claimedRecord;
  order.status = 'processing';
  db.save();

  // Broadcast WebSocket notification to trigger client audio & alert
  broadcast('ORDER_CLAIMED', {
    buyId,
    amount: order.amount,
    walletName: wallet.ctName,
    msg: `Order for ₹${order.amount} claimed successfully!`
  });

  return claimedRecord;
}

// Get order details
function getOrderInfo(buyId) {
  const state = db.get();
  const order = state.claimedOrders[buyId];
  if (!order) {
    return null;
  }
  // Calculate remaining seconds
  const remainingMs = new Date(order.expireAt).getTime() - Date.now();
  order.expireSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  return order;
}

// Submit payment / UTR confirmation
function submitOrder({ buyId, utr = '', proofUrl = '' }) {
  const state = db.get();
  const order = state.claimedOrders[buyId];
  if (!order) {
    throw new Error('Order not found');
  }

  order.status = 'completed';
  order.utr = utr || `UTR${Date.now()}${Math.floor(100 + Math.random() * 900)}`;
  order.completedAt = new Date().toISOString();

  // Credit user balance & rewards
  const user = state.users[order.userId];
  if (user) {
    user.balance = Number((user.balance + order.totalReward).toFixed(2));
    user.totalBalance = user.balance;
    user.rewardTotal = Number((user.rewardTotal + order.totalReward).toFixed(2));
  }

  // Update wallet stats
  const wallet = state.wallets.find(w => w.id === order.payoutWalletId);
  if (wallet) {
    wallet.todayTurnover = Number((wallet.todayTurnover + order.amount).toFixed(2));
    wallet.todayCount += 1;
  }

  // Award team commission (0.6% L1 commission)
  state.team.commissionTotal = Number((state.team.commissionTotal + order.amount * 0.006).toFixed(2));
  state.team.teamTurnover = Number((state.team.teamTurnover + order.amount).toFixed(2));

  db.save();

  broadcast('ORDER_COMPLETED', {
    buyId,
    amount: order.amount,
    reward: order.totalReward,
    msg: `Payment of ₹${order.amount} completed! Earned ₹${order.totalReward} reward.`
  });

  return order;
}

// Cancel order
function cancelOrder({ buyId, reason = 'User requested' }) {
  const state = db.get();
  const order = state.claimedOrders[buyId];
  if (!order) {
    throw new Error('Order not found');
  }

  order.status = 'cancelled';
  order.cancelReason = reason;

  // Restore hangSales order
  const original = state.hangSales.find(o => o.payOrderId === order.payOrderId);
  if (original) {
    original.status = 'pending';
  }

  db.save();
  return { success: true };
}

// Create automated realistic pending order (simulated order matching pipeline)
function spawnSampleOrder() {
  const state = db.get();
  const amounts = [500, 800, 1200, 2000, 2500, 3500, 5000, 7500, 10000, 15000];
  const amount = amounts[Math.floor(Math.random() * amounts.length)];
  const rate = Number((1.2 + Math.random() * 0.5).toFixed(2));
  const reward = Number((amount * (rate / 100)).toFixed(2));
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

  // Keep list around 6-12 orders
  state.hangSales = state.hangSales.filter(o => o.status === 'pending');
  if (state.hangSales.length > 10) {
    state.hangSales.shift();
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
