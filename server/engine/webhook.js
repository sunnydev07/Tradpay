const crypto = require('crypto');

function normalizeSignature(signature) {
  const value = String(signature || '').trim();
  if (value.startsWith('sha256=')) return value.slice(7);
  return value;
}

// Verifies `sha256=<hex>` HMAC signatures over the exact request body.
function verifySignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;

  const provided = normalizeSignature(signature);
  if (!/^[a-f0-9]{64}$/i.test(provided)) return false;

  const expected = crypto
    .createHmac('sha256', String(secret))
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { verifySignature };
