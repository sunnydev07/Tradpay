// Test fixture: boot the real db module, optionally mutate a balance, and print
// the resulting storage metadata as JSON. Each invocation is a fresh process so
// module-level environment and state cannot leak between restart simulations.
const db = require('../../server/engine/db');

async function main() {
  const info = await db.init();
  const state = db.get();

  const balance = Number(process.env.TEST_BALANCE || '0');
  if (Number.isFinite(balance) && balance > 0) {
    state.users['10086'].balance = balance;
    state.users['10086'].totalBalance = balance;
    db.save();
  }

  if (process.env.TEST_FLUSH_REMOTE === '1') {
    await db.flushRemote();
  }

  console.log('CHILD_RESULT ' + JSON.stringify({
    info,
    balance: state.users['10086'].balance,
    totalBalance: state.users['10086'].totalBalance
  }));
}

main().catch((err) => {
  console.error('CHILD_ERROR ' + err.message);
  process.exit(2);
});
