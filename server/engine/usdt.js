// USDT deposit gateways are disabled unless an operator supplies a real
// receiving address through the environment. Placeholder or malformed values
// are treated as "not configured" so a build can never show a fake address.
const CHAINS = Object.freeze(['TRC20', 'BSC', 'Polygon']);

const ENV_KEYS = Object.freeze({
  TRC20: 'USDT_TRC20_ADDRESS',
  BSC: 'USDT_BSC_ADDRESS',
  Polygon: 'USDT_POLYGON_ADDRESS'
});

// TRON base58 addresses start with T and are 34 characters; EVM addresses are
// 0x followed by 40 hex characters.
const ADDRESS_PATTERNS = Object.freeze({
  TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  BSC: /^0x[a-fA-F0-9]{40}$/,
  Polygon: /^0x[a-fA-F0-9]{40}$/
});

function normalizeChain(chain) {
  const value = String(chain || '').trim().toLowerCase();
  return CHAINS.find(candidate => candidate.toLowerCase() === value) || null;
}

function configuredAddress(chain) {
  const key = ENV_KEYS[chain];
  const value = String(process.env[key] || '').trim();
  if (!value) return null;
  return ADDRESS_PATTERNS[chain].test(value) ? value : null;
}

function getConfig() {
  const addresses = {};
  for (const chain of CHAINS) {
    const address = configuredAddress(chain);
    if (address) addresses[chain] = address;
  }
  const chains = Object.keys(addresses);
  return {
    enabled: chains.length > 0,
    chains,
    addresses,
    envKeys: ENV_KEYS
  };
}

function isEnabled() {
  return getConfig().enabled;
}

module.exports = {
  CHAINS,
  ENV_KEYS,
  normalizeChain,
  getConfig,
  isEnabled
};
