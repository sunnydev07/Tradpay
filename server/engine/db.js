const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Default initial state
const defaultState = {
  users: {
    "10086": {
      id: "10086",
      userId: "10086",
      phone: "+919876543210",
      nickname: "Trader_Alex",
      avatar: "/static/user/profile.png",
      balance: 15420.50,
      totalBalance: 15420.50,
      rewardTotal: 3480.00,
      pending: 0,
      points: 1250,
      vipLevel: 2,
      inviteCode: "LP8899",
      pin: "123456",
      isPinSet: true,
      onSellStatus: 1,
      createdAt: new Date().toISOString()
    }
  },
  tokens: {
    "token_10086": "10086"
  },
  wallets: [
    {
      id: 101,
      userId: "10086",
      ctType: 3, // PhonePe
      ctName: "PhonePe",
      account: "alex.trade@ybl",
      phone: "9876543210",
      name: "Alex Trader",
      status: 1, // 1: active (onSell), 0: offSell
      minAmount: 500,
      maxAmount: 20000,
      dailyLimit: 100000,
      todayTurnover: 12500,
      todayCount: 8,
      successRate: 99.4,
      createdAt: new Date().toISOString()
    },
    {
      id: 102,
      userId: "10086",
      ctType: 5, // Paytm
      ctName: "Paytm",
      account: "9876543210@paytm",
      phone: "9876543210",
      name: "Alex Trader",
      status: 1,
      minAmount: 500,
      maxAmount: 30000,
      dailyLimit: 150000,
      todayTurnover: 28400,
      todayCount: 14,
      successRate: 98.9,
      createdAt: new Date().toISOString()
    },
    {
      id: 103,
      userId: "10086",
      ctType: 2, // Freecharge
      ctName: "Freecharge",
      account: "alex9876@freecharge",
      phone: "9876543210",
      name: "Alex Trader",
      status: 1,
      minAmount: 500,
      maxAmount: 15000,
      dailyLimit: 50000,
      todayTurnover: 5000,
      todayCount: 3,
      successRate: 100.0,
      createdAt: new Date().toISOString()
    },
    {
      id: 104,
      userId: "10086",
      ctType: 4, // Mobikwik
      ctName: "Mobikwik",
      account: "alex.mobi@ikwik",
      phone: "9876543210",
      name: "Alex Trader",
      status: 0,
      minAmount: 500,
      maxAmount: 10000,
      dailyLimit: 30000,
      todayTurnover: 0,
      todayCount: 0,
      successRate: 97.5,
      createdAt: new Date().toISOString()
    }
  ],
  hangSales: [
    {
      payOrderId: "PO20261028001",
      orderNo: "PO20261028001",
      amount: 1500.00,
      reward: 18.00,
      rewardRate: 1.2,
      currency: "INR",
      status: "pending", // pending, processing, completed, cancelled
      allowedTypes: [2, 3, 4, 5],
      createdAt: new Date(Date.now() - 30000).toISOString()
    },
    {
      payOrderId: "PO20261028002",
      orderNo: "PO20261028002",
      amount: 3200.00,
      reward: 41.60,
      rewardRate: 1.3,
      currency: "INR",
      status: "pending",
      allowedTypes: [3, 5],
      createdAt: new Date(Date.now() - 45000).toISOString()
    },
    {
      payOrderId: "PO20261028003",
      orderNo: "PO20261028003",
      amount: 5000.00,
      reward: 75.00,
      rewardRate: 1.5,
      currency: "INR",
      status: "pending",
      allowedTypes: [2, 3, 5],
      createdAt: new Date(Date.now() - 60000).toISOString()
    },
    {
      payOrderId: "PO20261028004",
      orderNo: "PO20261028004",
      amount: 8500.00,
      reward: 127.50,
      rewardRate: 1.5,
      currency: "INR",
      status: "pending",
      allowedTypes: [3, 5],
      createdAt: new Date(Date.now() - 90000).toISOString()
    },
    {
      payOrderId: "PO20261028005",
      orderNo: "PO20261028005",
      amount: 12000.00,
      reward: 192.00,
      rewardRate: 1.6,
      currency: "INR",
      status: "pending",
      allowedTypes: [5],
      createdAt: new Date(Date.now() - 120000).toISOString()
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
    commissionTotal: 4850.50,
    yCommission: 420.00,
    teamTurnover: 358900.00,
    ratios: {
      tier1: 0.6,
      tier2: 0.3,
      tier3: 0.1
    },
    members: [
      { id: 201, phone: "+919811122334", level: 1, turnover: 120000, commission: 720, joinDate: "2026-10-20" },
      { id: 202, phone: "+919822233445", level: 1, turnover: 85000, commission: 510, joinDate: "2026-10-21" },
      { id: 203, phone: "+919833344556", level: 2, turnover: 64000, commission: 192, joinDate: "2026-10-23" },
      { id: 204, phone: "+919844455667", level: 3, turnover: 45000, commission: 45, joinDate: "2026-10-25" }
    ]
  },
  missions: [
    { id: 1, title: "Daily Sign-in", reward: 20, completed: true, claimed: false },
    { id: 2, title: "Complete 3 Collection Orders", reward: 50, completed: true, claimed: true },
    { id: 3, title: "Join Official Telegram Channel", reward: 100, completed: false, claimed: false, link: "https://t.me/tradepay_official" },
    { id: 4, title: "Invite 1 Active Team Member", reward: 200, completed: true, claimed: false }
  ],
  notices: [
    {
      id: 1,
      title: "Welcome to TradePay High-Speed Liquidity Engine",
      content: "Ensure your UPI accounts are in onSell status during peak hours for maximum bonus rewards.",
      createdAt: "2026-10-27"
    },
    {
      id: 2,
      title: "Night Bonus Event Active (22:00 - 06:00)",
      content: "All matched orders receive an extra 25% reward bonus automatically during night hours.",
      createdAt: "2026-10-27"
    }
  ]
};

// In-memory store
let state = { ...defaultState };

// Load from disk if exists
try {
  if (fs.existsSync(DB_FILE)) {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    state = Object.assign({}, defaultState, parsed);
  } else {
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultState, null, 2), 'utf-8');
  }
} catch (err) {
  console.error('[DB] Failed to read db.json, using defaults:', err.message);
}

// Debounced persistent write
let saveTimeout = null;
function save() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2), 'utf-8');
    } catch (err) {
      console.error('[DB] Save error:', err.message);
    }
  }, 100);
}

module.exports = {
  get: () => state,
  save,
  reset: () => {
    state = JSON.parse(JSON.stringify(defaultState));
    save();
  }
};
