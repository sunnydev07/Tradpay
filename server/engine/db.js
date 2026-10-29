const fs = require('fs');
const path = require('path');
const security = require('./security');
const money = require('./money');

const DATA_DIR = path.join(__dirname, '../../data');
const DB_FILE = process.env.TRADEPAY_DB_FILE || path.join(DATA_DIR, 'db.json');
const DB_DIR = path.dirname(DB_FILE);

// Ensure the configured data directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// Default initial state with strictly ZERO balances. The demo account has no PIN
// and no token; it is only reachable through an authenticated Supabase session.
const defaultState = {
  users: {
    "10086": {
      id: "10086",
      userId: "10086",
      phone: "+919876543210",
      nickname: "Trader_Alex",
      avatar: "/static/user/profile.png",
      balance: 0.00,
      totalBalance: 0.00,
      rewardTotal: 0.00,
      pending: 0.00,
      points: 0,
      vipLevel: 1,
      inviteCode: "LP8899",
      pinHash: null,
      pinSalt: null,
      isPinSet: false,
      onSellStatus: 1,
      claimedMissions: [],
      newcomerRewardClaimed: false,
      createdAt: new Date().toISOString()
    }
  },
  revokedTokens: {},
  wallets: [
    {
      id: 1,
      userId: "system",
      ctType: 3,
      ctName: "Official QR 1",
      account: "9588856526@ybl",
      phone: "",
      name: "",
      qrImage: "/static/qr/scr2.jpeg",
      upiUri: "upi://pay?pa=9588856526@ybl&mc=0000&mode=02&purpose=00",
      isOfficial: true,
      status: 1,
      minAmount: 100,
      maxAmount: 100000,
      dailyLimit: 500000,
      todayTurnover: 0.00,
      todayCount: 0,
      successRate: 100.0,
      createdAt: new Date().toISOString()
    },
    {
      id: 2,
      userId: "system",
      ctType: 3,
      ctName: "Official QR 2",
      account: "9588856526@ybl",
      phone: "",
      name: "",
      qrImage: "/static/qr/scr2.jpeg",
      upiUri: "upi://pay?pa=9588856526@ybl&mc=0000&mode=02&purpose=00",
      isOfficial: true,
      status: 1,
      minAmount: 100,
      maxAmount: 100000,
      dailyLimit: 500000,
      todayTurnover: 0.00,
      todayCount: 0,
      successRate: 100.0,
      createdAt: new Date().toISOString()
    },
    {
      id: 101,
      userId: "10086",
      ctType: 3,
      ctName: "PhonePe",
      account: "alex.trade@ybl",
      phone: "9876543210",
      name: "Alex Trader",
      status: 1,
      minAmount: 500,
      maxAmount: 20000,
      dailyLimit: 100000,
      todayTurnover: 0.00,
      todayCount: 0,
      successRate: 100.0,
      createdAt: new Date().toISOString()
    }
  ],
  hangSales: [
    {
      payOrderId: "PO20261028001",
      orderNo: "PO20261028001",
      amount: 1500.00,
      reward: 300.00,
      rewardRate: 20,
      currency: "INR",
      status: "pending",
      allowedTypes: [2, 3, 4, 5],
      createdAt: new Date(Date.now() - 30000).toISOString()
    },
    {
      payOrderId: "PO20261028002",
      orderNo: "PO20261028002",
      amount: 3200.00,
      reward: 640.00,
      rewardRate: 20,
      currency: "INR",
      status: "pending",
      allowedTypes: [3, 5],
      createdAt: new Date(Date.now() - 45000).toISOString()
    },
    {
      payOrderId: "PO20261028003",
      orderNo: "PO20261028003",
      amount: 5000.00,
      reward: 1000.00,
      rewardRate: 20,
      currency: "INR",
      status: "pending",
      allowedTypes: [2, 3, 5],
      createdAt: new Date(Date.now() - 60000).toISOString()
    }
  ],
  claimedOrders: {},
  settings: {
    usdtRechargeRate: 91.50,
    usdtCashbackRate: 2.0,
    nightBonus: {
      enabled: true,
      inRangeNow: true,
      startTime: "22:00",
      endTime: "06:00",
      multiplier: 1.25
    },
    dispatchRanges: [
      { min: 500, max: 2000 },
      { min: 2000, max: 5000 },
      { min: 5000, max: 10000 },
      { min: 10000, max: 50000 }
    ]
  },
  team: {
    commissionTotal: 0.00,
    yCommission: 0.00,
    teamTurnover: 0.00,
    ratios: {
      tier1: 0.6,
      tier2: 0.3,
      tier3: 0.1
    },
    members: []
  },
  missions: [
    { id: 1, title: "Daily Sign-in", reward: 20, completed: true, claimed: false },
    { id: 2, title: "Complete 1 Collection Order", reward: 50, completed: false, claimed: false },
    { id: 3, title: "Join Official Telegram Channel", reward: 100, completed: false, claimed: false, link: "https://t.me/tradepay_official" },
    { id: 4, title: "Complete a Collection Order", reward: 100, completed: false, claimed: false }
  ],
  notices: [
    {
      id: 1,
      title: "Claim, Pay & Earn Rewards",
      content: "Users can claim a live collection order, pay the matching customer via UPI, and submit the 12-digit UTR to get rewarded instantly.",
      createdAt: "2026-10-28"
    },
    {
      id: 2,
      title: "Night Bonus Event Active (22:00 - 06:00)",
      content: "All matched orders receive an extra 25% reward bonus automatically during night hours.",
      createdAt: "2026-10-28"
    }
  ]
};

function mergeSettings(saved) {
  const settings = {
    ...defaultState.settings,
    ...(saved && typeof saved === 'object' ? saved : {})
  };
  settings.nightBonus = {
    ...defaultState.settings.nightBonus,
    ...(saved && saved.nightBonus ? saved.nightBonus : {})
  };
  if (!Array.isArray(settings.dispatchRanges) || !settings.dispatchRanges.length) {
    settings.dispatchRanges = defaultState.settings.dispatchRanges;
  }
  return settings;
}

function migrateUser(user) {
  if (!user || typeof user !== 'object') return user;

  // Never keep raw bearer tokens or plaintext PINs in the local store.
  delete user.token;
  delete user._lastToken;
  if (user.pin && !user.pinHash) {
    const hashed = security.hashPin(user.pin);
    user.pinHash = hashed.hash;
    user.pinSalt = hashed.salt;
    user.isPinSet = true;
  }
  delete user.pin;

  if (!Array.isArray(user.claimedMissions)) user.claimedMissions = [];
  if (typeof user.newcomerRewardClaimed !== 'boolean') user.newcomerRewardClaimed = false;
  if (!Array.isArray(user.wallets)) user.wallets = [];
  if (!Array.isArray(user.claimedOrders)) user.claimedOrders = [];
  if (!user.inviteCode) user.inviteCode = 'LP' + Math.floor(1000 + Math.random() * 9000);
  if (!user.avatar) user.avatar = '/static/user/profile.png';
  return user;
}

function buildState(saved) {
  const safeSaved = saved && typeof saved === 'object' ? saved : {};
  const state = JSON.parse(JSON.stringify(defaultState));

  if (safeSaved.users && typeof safeSaved.users === 'object') {
    state.users = safeSaved.users;
  }
  if (Array.isArray(safeSaved.wallets)) state.wallets = safeSaved.wallets;
  if (Array.isArray(safeSaved.hangSales)) state.hangSales = safeSaved.hangSales;

  // Keep every claimable order at or above the 20% minimum reward. This also
  // upgrades older persisted orders that were created with the previous rate.
  for (const sale of state.hangSales) {
    if (!sale || typeof sale !== 'object') continue;
    if (!['pending', 'processing'].includes(sale.status)) continue;
    const minReward = money.minimumOrderReward(sale.amount);
    if (!(Number(sale.reward) >= minReward)) sale.reward = minReward;
    if (!(Number(sale.rewardRate) >= money.MIN_ORDER_REWARD_PERCENT)) {
      sale.rewardRate = money.MIN_ORDER_REWARD_PERCENT;
    }
  }
  if (safeSaved.claimedOrders && typeof safeSaved.claimedOrders === 'object') {
    state.claimedOrders = safeSaved.claimedOrders;
  }

  // Buyer UPI / phone are never shown or used; strip any legacy persisted values.
  for (const order of Object.values(state.claimedOrders)) {
    if (order && typeof order === 'object') {
      delete order.buyerUpi;
      delete order.buyerPhone;
    }
  }
  if (safeSaved.revokedTokens && typeof safeSaved.revokedTokens === 'object') {
    state.revokedTokens = safeSaved.revokedTokens;
  }
  if (Array.isArray(safeSaved.missions)) state.missions = safeSaved.missions;
  if (Array.isArray(safeSaved.notices)) state.notices = safeSaved.notices;
  state.settings = mergeSettings(safeSaved.settings);

  // Bring in-flight claims up to the current 20% minimum so the claim modal and
  // the eventual payout match the new policy, not the rate they were created at.
  const bonusMultiplier = Number(state.settings.nightBonus.multiplier) || 1.25;
  for (const order of Object.values(state.claimedOrders)) {
    if (!order || typeof order !== 'object') continue;
    if (!['pending', 'confirming'].includes(order.status)) continue;
    const baseReward = Math.max(
      Number(order.reward) || 0,
      money.minimumOrderReward(order.amount)
    );
    order.reward = baseReward;
    order.rewardRate = Math.max(
      Number(order.rewardRate) || 0,
      money.MIN_ORDER_REWARD_PERCENT
    );
    order.smallAmountBonusAmount = order.smallAmountBonus
      ? money.multiply(baseReward, bonusMultiplier - 1)
      : 0;
    order.totalReward = money.add(baseReward, order.smallAmountBonusAmount);
  }
  state.team = {
    ...defaultState.team,
    ...(safeSaved.team && typeof safeSaved.team === 'object' ? safeSaved.team : {}),
    ratios: {
      ...defaultState.team.ratios,
      ...(safeSaved.team && safeSaved.team.ratios ? safeSaved.team.ratios : {})
    },
    members: safeSaved.team && Array.isArray(safeSaved.team.members)
      ? safeSaved.team.members
      : defaultState.team.members
  };

  for (const user of Object.values(state.users)) migrateUser(user);
  delete state.tokens;
  return state;
}

function loadState() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf-8');
      if (raw.trim()) {
        return buildState(JSON.parse(raw));
      }
    }
  } catch (err) {
    console.error('[DB] Load error, starting from defaults:', err.message);
  }
  return buildState(null);
}

let state = loadState();

function writeState() {
  try {
    const tmpFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmpFile, DB_FILE);
  } catch (err) {
    console.error('[DB] Save error:', err.message);
  }
}

// Seed the file only when it does not exist. Never overwrite live state on import.
if (!fs.existsSync(DB_FILE)) {
  writeState();
}

// Debounced persistent write
let saveTimeout = null;
function save() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    writeState();
  }, 100);
}

function flush() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  writeState();
}

process.on('exit', () => {
  if (saveTimeout) {
    try { writeState(); } catch (e) { /* no-op during shutdown */ }
  }
});

module.exports = {
  get: () => state,
  save,
  flush,
  reset: () => {
    state = buildState(null);
    flush();
  }
};
