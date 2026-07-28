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
/* PayFast's backend uses PHP urlencode(). encodeURIComponent leaves
   ! ' ( ) * ~ untouched; PHP escapes them. Spaces become '+' in both. */
function pfEncode(v) {
  return encodeURIComponent(String(v))
    .replace(/%20/g, '+')
    .replace(/[!'()*~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function sign(fields, passphrase) {
  const qs = Object.entries(fields)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${pfEncode(v)}`)
    .join('&');
  const full = passphrase ? `${qs}&passphrase=${pfEncode(passphrase.trim())}` : qs;
  return crypto.createHash('md5').update(full).digest('hex');
}

exports.handler = async event => {
  /* ------------------------------------------------------------------
     TEMPORARY DIAGNOSTIC — visit /.netlify/functions/dd-checkout?debug=1
     Shows which env vars are actually reaching the function and the exact
     string being signed. Delete this block once checkout works.
     ------------------------------------------------------------------ */
  if (event.httpMethod === 'GET' && (event.queryStringParameters || {}).debug === '1') {
    const pass = process.env.PAYFAST_PASSPHRASE;
    const sample = {
      merchant_id:  process.env.PAYFAST_MERCHANT_ID,
      merchant_key: process.env.PAYFAST_MERCHANT_KEY,
      return_url:   'https://example.com/?paid=1',
      cancel_url:   'https://example.com/?cancelled=1',
      notify_url:   'https://example.com/.netlify/functions/dd-itn',
      name_first:   'Julian',
      email_address:'julian@discovr.tv',
      m_payment_id: 'dd-test-1',
      amount:       '59.00',
      item_name:    'Destroying Desmond - own'
    };
    for (const k of Object.keys(sample)) {
      if (!sample[k]) delete sample[k];
    }
    const qs = Object.entries(sample)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v).trim()).replace(/%20/g, '+')}`)
      .join('&');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        env: {
          PAYFAST_MERCHANT_ID:  process.env.PAYFAST_MERCHANT_ID  || 'MISSING',
          PAYFAST_MERCHANT_KEY: process.env.PAYFAST_MERCHANT_KEY || 'MISSING',
          whitespace_check: (() => {
            const bad = ['PAYFAST_MERCHANT_ID','PAYFAST_MERCHANT_KEY','PAYFAST_PASSPHRASE']
              .filter(k => process.env[k] && process.env[k] !== process.env[k].trim());
            return bad.length ? 'STRAY WHITESPACE ON: ' + bad.join(', ') : 'all clean';
          })(),
          PAYFAST_SANDBOX:      process.env.PAYFAST_SANDBOX      || 'MISSING',
          PAYFAST_PASSPHRASE_set: pass === undefined ? 'NOT SET (good, if PayFast has none)'
                                 : `SET, length ${pass.length}`,
          FIREBASE_API_KEY_set:  process.env.FIREBASE_API_KEY  ? 'set' : 'MISSING',
          FIREBASE_DB_SECRET_set: process.env.FIREBASE_DB_SECRET ? 'set' : 'MISSING'
        },
        posting_to: PF_HOST,
        string_being_signed: qs + (pass ? '&passphrase=<your passphrase>' : ''),
        signature: sign(sample, pass)
      }, null, 2)
    };
  }

  /* ------------------------------------------------------------------
     TEMPORARY BISECT PAGE — /.netlify/functions/dd-checkout?test=1
     Each form adds one more group of fields. Click them in order; the
     first one that fails identifies the offending field. Delete when done.
     ------------------------------------------------------------------ */
  if (event.httpMethod === 'GET' && (event.queryStringParameters || {}).test === '1') {
    const M = process.env.PAYFAST_MERCHANT_ID;
    const K = process.env.PAYFAST_MERCHANT_KEY;
    const P = process.env.PAYFAST_PASSPHRASE;
    const site = 'https://destroying-desmond.netlify.app';

    const steps = [
      ['1. Bare minimum', {
        merchant_id: M, merchant_key: K, amount: '59.00', item_name: 'Test'
      }],
      ['2. + URLs', {
        merchant_id: M, merchant_key: K,
        return_url: site + '/', cancel_url: site + '/',
        notify_url: site + '/.netlify/functions/dd-itn',
        amount: '59.00', item_name: 'Test'
      }],
      ['3. + URLs with query strings', {
        merchant_id: M, merchant_key: K,
        return_url: site + '/?paid=1', cancel_url: site + '/?cancelled=1',
        notify_url: site + '/.netlify/functions/dd-itn',
        amount: '59.00', item_name: 'Test'
      }],
      ['4. + buyer name and email', {
        merchant_id: M, merchant_key: K,
        return_url: site + '/?paid=1', cancel_url: site + '/?cancelled=1',
        notify_url: site + '/.netlify/functions/dd-itn',
        name_first: 'Julian', name_last: 'von Plato',
        email_address: 'julian@discovr.tv',
        amount: '59.00', item_name: 'Test'
      }],
      ['5. + payment id and real item name', {
        merchant_id: M, merchant_key: K,
        return_url: site + '/?paid=1', cancel_url: site + '/?cancelled=1',
        notify_url: site + '/.netlify/functions/dd-itn',
        name_first: 'Julian', name_last: 'von Plato',
        email_address: 'julian@discovr.tv',
        m_payment_id: 'dd-test-' + Date.now().toString(36),
        amount: '59.00', item_name: 'Destroying Desmond - own'
      }],
      ['6. + custom fields (the full payload)', {
        merchant_id: M, merchant_key: K,
        return_url: site + '/?paid=1', cancel_url: site + '/?cancelled=1',
        notify_url: site + '/.netlify/functions/dd-itn',
        name_first: 'Julian', name_last: 'von Plato',
        email_address: 'julian@discovr.tv',
        m_payment_id: 'dd-test-' + Date.now().toString(36),
        amount: '59.00', item_name: 'Destroying Desmond - own',
        custom_str1: 'LGANwGT28XPHyESixxX7yZiV1UQ2',
        custom_str2: 'own', custom_str3: 'pearl-thusi',
        custom_str4: 'destroying-desmond'
      }]
    ];

    const html = steps.map(([label, f]) => {
      for (const k of Object.keys(f)) f[k] = String(f[k]).trim();
      const sig = sign(f, P);
      const inputs = Object.entries(f)
        .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, '&quot;')}">`)
        .join('') + `<input type="hidden" name="signature" value="${sig}">`;
      return `<form method="POST" action="${PF_HOST}" target="_blank">
        ${inputs}<button>${label}</button></form>`;
    }).join('');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
        <style>body{font:16px system-ui;max-width:640px;margin:40px auto;padding:0 20px}
        button{display:block;width:100%;padding:15px;margin:10px 0;font:inherit;cursor:pointer;
        border:1px solid #ccc;border-radius:6px;background:#fff;text-align:left}
        button:hover{border-color:#333}</style>
        <h2>PayFast bisect</h2>
        <p>Click each in order. Each opens a new tab. Tell me the number of the
        <b>first one that shows the signature error</b>.</p>
        ${html}`
    };
  }

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

    // Normalise BEFORE signing so the bytes we sign are exactly the bytes we post.
    // A stray space on an env var (very easy to paste in) otherwise means we sign
    // the trimmed value and submit the untrimmed one -> guaranteed mismatch.
    for (const k of Object.keys(fields)) {
      if (fields[k] === '' || fields[k] === null || fields[k] === undefined) { delete fields[k]; continue; }
      fields[k] = String(fields[k]).trim();
      if (fields[k] === '') delete fields[k];
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
