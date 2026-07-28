/**
 * dd-checkout — builds a signed PayFast payload for Destroying Desmond.
 * Node built-ins only. No npm.
 *
 * POST { token, filmId, tier, ref, giftTo, giftMsg, returnUrl }
 * ->   { action, fields }
 */
const crypto = require('crypto');
const https  = require('https');

const DB      = (process.env.FIREBASE_DB_URL || 'https://flieks-app-default-rtdb.firebaseio.com').replace(/\/$/, '');
const SECRET  = process.env.FIREBASE_DB_SECRET;
const API_KEY = process.env.FIREBASE_API_KEY;
const SANDBOX = String(process.env.PAYFAST_SANDBOX) === 'true';

const PF_HOST = SANDBOX ? 'https://sandbox.payfast.co.za/eng/process'
                        : 'https://www.payfast.co.za/eng/process';

/* ---------- tiny https helpers ---------- */
function req(url, opts = {}, body = null) {
  return new Promise((res, rej) => {
    const r = https.request(url, opts, x => {
      let d = ''; x.on('data', c => d += c);
      x.on('end', () => res({ status: x.statusCode, body: d }));
    });
    r.on('error', rej);
    if (body) r.write(body);
    r.end();
  });
}
const dbGet = async path => {
  const r = await req(`${DB}/${path}.json?auth=${SECRET}`);
  return JSON.parse(r.body || 'null');
};
const dbPut = async (path, data) => {
  const b = JSON.stringify(data);
  return req(`${DB}/${path}.json?auth=${SECRET}`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } }, b);
};

/* ---------- verify a Firebase ID token ---------- */
async function verify(token) {
  const b = JSON.stringify({ idToken: token });
  const r = await req(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } }, b);
  const d = JSON.parse(r.body || '{}');
  if (!d.users || !d.users[0]) throw new Error('bad token');
  return d.users[0]; // localId, email, displayName
}

/* ---------- PayFast signature ---------- */
function sign(fields, passphrase) {
  const qs = Object.entries(fields)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v).trim()).replace(/%20/g, '+')}`)
    .join('&');
  const full = passphrase
    ? `${qs}&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, '+')}`
    : qs;
  return crypto.createHash('md5').update(full).digest('hex');
}

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
  try {
    const { token, filmId, tier, ref, giftTo, giftMsg, returnUrl } = JSON.parse(event.body || '{}');
    if (!token || !filmId || !['stream', 'own', 'gift'].includes(tier))
      return { statusCode: 400, body: 'bad request' };

    const user = await verify(token);
    const cfg  = await dbGet('dd_config') || {};

    const amount = {
      stream: cfg.priceStream ?? 35,
      own:    cfg.priceOwn    ?? 89,
      gift:   cfg.priceGift   ?? cfg.priceOwn ?? 89
    }[tier];

    const mPaymentId = `dd-${tier}-${user.localId.slice(0, 6)}-${Date.now().toString(36)}`;
    const base = (returnUrl || 'https://destroyingdesmond.com/').split('?')[0];

    // park the intent so the ITN knows what was bought, even if PayFast trims fields
    await dbPut(`dd_orders/${mPaymentId}`, {
      uid: user.localId, email: user.email || '', filmId, tier,
      ref: ref || null, giftTo: giftTo || null, giftMsg: giftMsg || null,
      amount, status: 'pending', createdAt: Date.now()
    });

    const fields = {
      merchant_id:  process.env.PAYFAST_MERCHANT_ID,
      merchant_key: process.env.PAYFAST_MERCHANT_KEY,
      return_url:   `${base}?paid=1`,
      cancel_url:   `${base}?cancelled=1`,
      notify_url:   `${new URL(base).origin}/.netlify/functions/dd-itn`,
      name_first:   (user.displayName || 'Viewer').replace(/[^\x20-\x7E]/g, '').slice(0, 40).trim() || 'Viewer',
      email_address: user.email || '',
      m_payment_id: mPaymentId,
      amount:       Number(amount).toFixed(2),
      item_name:    `Destroying Desmond - ${tier}`,   // plain ASCII: non-ASCII risks an encoding mismatch
      custom_str1:  user.localId,
      custom_str2:  tier,
      custom_str3:  ref || '',
      custom_str4:  filmId
    };

    // PayFast signs exactly what it receives, so drop empty fields from the payload
    // BEFORE signing. Submitting a field we didn't sign is a guaranteed mismatch.
    for (const k of Object.keys(fields)) {
      if (fields[k] === '' || fields[k] === null || fields[k] === undefined) delete fields[k];
    }

    fields.signature = sign(fields, process.env.PAYFAST_PASSPHRASE);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: PF_HOST, fields })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ message: e.message }) };
  }
};
