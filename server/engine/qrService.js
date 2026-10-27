const QRCode = require('qrcode');
const db = require('./db');

// In-memory cache for generated QR codes to optimize speed
const qrCache = new Map();

/**
 * Construct standard UPI payment URI complying with NPCI specification
 */
function buildUpiUri({ vpa, name = '', amount = null, note = null }) {
  if (!vpa) return '';
  const cleanVpa = String(vpa).trim();
  const cleanName = String(name || '').trim();
  // Preserve '@' unescaped for maximum compatibility across Indian UPI apps (PhonePe, GPay, Paytm)
  const encodedVpa = encodeURIComponent(cleanVpa).replace(/%40/g, '@');
  let uri = `upi://pay?pa=${encodedVpa}`;
  // Only include payee name (pn) when explicitly provided; keep official QR details minimal
  if (cleanName) {
    uri += `&pn=${encodeURIComponent(cleanName)}`;
  }
  if (amount != null && !isNaN(Number(amount)) && Number(amount) > 0) {
    uri += `&am=${Number(amount).toFixed(2)}&cu=INR`;
  }
  if (note) {
    uri += `&tn=${encodeURIComponent(String(note).trim())}`;
  }
  uri += '&mode=02&purpose=00';
  return uri;
}

/**
 * Generate Base64 PNG Data URL for given text/URI
 */
async function getQrDataUrl(text, options = {}) {
  if (!text) return '';
  const width = options.width || 256;
  const cacheKey = `png_${text}_${width}`;
  if (qrCache.has(cacheKey)) {
    return qrCache.get(cacheKey);
  }
  try {
    const dataUrl = await QRCode.toDataURL(text, {
      margin: options.margin != null ? options.margin : 1,
      width,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });
    if (qrCache.size > 500) {
      const first = qrCache.keys().next().value;
      qrCache.delete(first);
    }
    qrCache.set(cacheKey, dataUrl);
    return dataUrl;
  } catch (err) {
    console.error('[qrService] getQrDataUrl error:', err.message);
    return '';
  }
}

/**
 * Generate SVG string for given text/URI
 */
async function getQrSvg(text, options = {}) {
  if (!text) return '';
  const width = options.width || 256;
  const cacheKey = `svg_${text}_${width}`;
  if (qrCache.has(cacheKey)) {
    return qrCache.get(cacheKey);
  }
  try {
    const svg = await QRCode.toString(text, {
      type: 'svg',
      margin: options.margin != null ? options.margin : 1,
      width,
      errorCorrectionLevel: 'M'
    });
    if (qrCache.size > 500) {
      const first = qrCache.keys().next().value;
      qrCache.delete(first);
    }
    qrCache.set(cacheKey, svg);
    return svg;
  } catch (err) {
    console.error('[qrService] getQrSvg error:', err.message);
    return '';
  }
}

/**
 * Format an official QR record with optional custom amount and dynamic QR data
 */
async function formatOfficialQr(qr, amount = null, note = null) {
  if (!qr) return null;
  const numAmount = amount ? Number(amount) : null;
  const upiUri = buildUpiUri({
    vpa: qr.vpa,
    name: qr.name,
    amount: numAmount,
    note: note || (numAmount ? `TradePay Topup INR ${numAmount}` : 'TradePay Official Deposit')
  });
  const qrDataUrl = await getQrDataUrl(upiUri);
  return {
    ...qr,
    amount: numAmount,
    upiUri,
    qrDataUrl,
    qrImageUrl: `/api/qr/image?text=${encodeURIComponent(upiUri)}`,
    screenshotUrl: qr.qrImage || '/static/qr/scr1.jpeg'
  };
}

/**
 * Attach amount-specific QR and UPI URI to an order
 */
async function attachQrToOrder(order) {
  if (!order) return order;
  const state = db.get();
  const qrs = state.officialQRs || db.officialQRs || [];
  
  // Match payout wallet if official, or default to first verified platform account
  let assignedQr = null;
  if (order.payoutWalletId) {
    assignedQr = qrs.find(q => q.id === Number(order.payoutWalletId));
  }
  if (!assignedQr) {
    assignedQr = qrs[0] || {
      id: 1,
      name: 'AKSHAT JAIN',
      vpa: '6377276074-2@ybl',
      channel: 'PhonePe (Yes Bank)',
      qrImage: '/static/qr/scr1.jpeg'
    };
  }

  const amount = Number(order.amount);
  const note = order.orderNo || order.payOrderId || `Order ${order.id || ''}`;
  const upiUri = buildUpiUri({
    vpa: assignedQr.vpa,
    name: assignedQr.name || 'AKSHAT JAIN',
    amount,
    note
  });

  const qrDataUrl = await getQrDataUrl(upiUri);

  order.payeeName = assignedQr.name || 'AKSHAT JAIN';
  order.payeeVpa = assignedQr.vpa;
  order.payeeChannel = assignedQr.channel || 'PhonePe (Yes Bank)';
  order.upiUri = upiUri;
  order.qrDataUrl = qrDataUrl;
  order.qrImage = assignedQr.qrImage || '/static/qr/scr1.jpeg';
  order.qrImageUrl = `/api/qr/image?text=${encodeURIComponent(upiUri)}`;

  return order;
}

/**
 * Attach QR code to a wallet
 */
async function attachQrToWallet(wallet) {
  if (!wallet) return wallet;
  const vpa = wallet.account || wallet.vpa;
  // Only include holder name for user-bound wallets; official QRs stay anonymous
  const name = wallet.isOfficial ? '' : (wallet.name || '');
  const upiUri = buildUpiUri({ vpa, name });
  const qrDataUrl = await getQrDataUrl(upiUri);
  return {
    ...wallet,
    upiUri,
    qrDataUrl,
    qrImageUrl: `/api/qr/image?text=${encodeURIComponent(upiUri)}`
  };
}

/**
 * Generate QR code for crypto deposit address
 */
async function attachQrToUsdt(chain, address, amount = null) {
  const uri = address;
  const qrDataUrl = await getQrDataUrl(uri);
  return {
    chain,
    address,
    amount: amount ? Number(amount) : null,
    uri,
    qrDataUrl,
    qrImageUrl: `/api/qr/image?text=${encodeURIComponent(uri)}`
  };
}

module.exports = {
  buildUpiUri,
  getQrDataUrl,
  getQrSvg,
  formatOfficialQr,
  attachQrToOrder,
  attachQrToWallet,
  attachQrToUsdt
};
