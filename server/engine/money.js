// Money arithmetic in integer paise. Floating-point addition and percentage
// calculations drift after repeated credits; every mutation is rounded to
// paise before it is written back to state. API values remain rupee numbers
// for backwards compatibility with the existing client.
const MAX_SAFE_PAISE = Math.floor(Number.MAX_SAFE_INTEGER / 100);

function toPaise(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const paise = Math.round((num + Number.EPSILON) * 100);
  return Math.max(-MAX_SAFE_PAISE, Math.min(MAX_SAFE_PAISE, paise));
}

function fromPaise(paise) {
  const num = Number(paise);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num) / 100;
}

function add(a, b) {
  return fromPaise(toPaise(a) + toPaise(b));
}

function subtract(a, b) {
  return fromPaise(toPaise(a) - toPaise(b));
}

// `percentage` is expressed as a percentage: 1.2 means 1.2%.
function percentage(amount, percentageValue) {
  const pct = Number(percentageValue);
  if (!Number.isFinite(pct)) return 0;
  return fromPaise(Math.round(toPaise(amount) * pct / 100));
}

function multiply(amount, factor) {
  const num = Number(factor);
  if (!Number.isFinite(num)) return 0;
  return fromPaise(Math.round(toPaise(amount) * num));
}

function equals(a, b) {
  return toPaise(a) === toPaise(b);
}

// Platform policy: every claimed order pays a bonus reward worth at least
// 20% of the order amount (e.g. a ₹500 claim earns ₹100 before night bonus).
const MIN_ORDER_REWARD_PERCENT = 20;

function minimumOrderReward(amount) {
  return percentage(amount, MIN_ORDER_REWARD_PERCENT);
}

module.exports = {
  toPaise,
  fromPaise,
  add,
  subtract,
  percentage,
  multiply,
  equals,
  MIN_ORDER_REWARD_PERCENT,
  minimumOrderReward
};
