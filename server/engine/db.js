const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Official QR codes provided by user
const officialQRs = [
  {
    id: 1,
    name: "AKSHAT JAIN",
    vpa: "6377276074-2@ybl",
    channel: "PhonePe (Yes Bank)",
    qrImage: "/static/qr/scr1.jpeg",
    upiUri: "upi://pay?pa=6377276074-2@ybl&pn=AKSHAT%20JAIN&mc=0000&mode=02&purpose=00",
    minAmount: 100,
    maxAmount: 100000,
    status: 1
  },
  {
    id: 2,
    name: "Vinod Kumar Yogi",
    vpa: "9588856526@ybl",
    channel: "PhonePe (Yes Bank)",
    qrImage: "/static/qr/scr2.jpeg",
    upiUri: "upi://pay?pa=9588856526@ybl&pn=Vinod%20Kumar%20Yogi&mc=0000&mode=02&purpose=00",
    minAmount: 100,
    maxAmount: 100000,
    status: 1
  }
];

// Default initial state with strictly ZERO balances
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
      pin: "123456",
      isPinSet: true,
      onSellStatus: 1,
      createdAt: new Date().toISOString()
    }
  },
  tokens: {
    "token_10086": "10086"
  },
  officialQRs,
  wallets: [
    {
      id: 1,
      userId: "system",
      ctType: 3,
      ctName: "Official QR 1",
      account: "6377276074-2@ybl",
      phone: "",
      name: "",
      qrImage: "/static/qr/scr1.jpeg",
      upiUri: "upi://pay?pa=6377276074-2@ybl&mc=0000&mode=02&purpose=00",
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
      reward: 18.00,
      rewardRate: 1.2,
      currency: "INR",
      status: "pending",
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
    { id: 4, title: "Pay using Official QR Code", reward: 100, completed: false, claimed: false }
  ],
  notices: [
    {
      id: 1,
      title: "Official UPI QR Payments Online",
      content: "Users can now scan and pay permanently using the official platform UPI QR codes for instant automated balance top-up.",
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

// Always start with zero balance clean state
let state = JSON.parse(JSON.stringify(defaultState));

// Write clean zero-balance state to disk
try {
  fs.writeFileSync(DB_FILE, JSON.stringify(defaultState, null, 2), 'utf-8');
} catch (err) {
  console.error('[DB] Write error:', err.message);
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
  officialQRs,
  save,
  reset: () => {
    state = JSON.parse(JSON.stringify(defaultState));
    save();
  }
};
