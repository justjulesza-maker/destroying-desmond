/**
 * dd-itn — PayFast Instant Transaction Notification for Destroying Desmond.
 * Separate from the main 4flieks payfast-itn so the live flow stays untouched.
 *
 * Grants access, mints gift codes, and records which actor's link drove the sale.
 */
const crypto = require('crypto');
const https  = require('https');
const { URLSearchParams } = require('url');

const DB      = (process.env.FIREBASE_DB_URL || 'https://flieks-app-default-rtdb.firebaseio.com').replace(/\/$/, '');
const SECRET  = process.env.FIREBASE_DB_SECRET;
const SANDBOX = String(process.env.PAYFAST_SANDBOX) === 'true';
const PF_VALIDATE_HOST = SANDBOX ? 'sandbox.payfast.co.za' : 'www.payfast.co.za';
const PF_IP_HOSTS = ['www.payfast.co.za', 'sandbox.payfast.co.za', 'w1w.payfast.co.za', 'w2w.payfast.co.za'];

function req(url, opts = {}, body = null) {
  return new Promise((res, rej) => {
    const r = https.request(url, opts, x => {
      let d = ''; x.on('data', c => d += c);
      x.on('end', () => res({ status: x.statusCode, body: d }));
    });
    r.on('error', rej); if (body) r.write(body); r.end();
  });
}
const dbGet   = async p => JSON.parse((await req(`${DB}/${p}.json?auth=${SECRET}`)).body || 'null');
const dbWrite = (p, data, method) => {
  const b = JSON.stringify(data);
  return req(`${DB}/${p}.json?auth=${SECRET}`,
    { method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } }, b);
};
const dbPut   = (p, d) => dbWrite(p, d, 'PUT');
const dbPatch = (p, d) => dbWrite(p, d, 'PATCH');

/* verify the signature PayFast sent us */
function valid(raw, passphrase) {
  const pairs = raw.split('&').filter(p => !p.startsWith('signature='));
  const qs = passphrase
    ? `${pairs.join('&')}&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, '+')}`
    : pairs.join('&');
  const mine = crypto.createHash('md5').update(qs).digest('hex');
  const theirs = (raw.match(/signature=([a-f0-9]{32})/) || [])[1];
  return mine === theirs;
}

/* ask PayFast to confirm the transaction really came from them */
async function confirm(raw) {
  const r = await req(`https://${PF_VALIDATE_HOST}/eng/query/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(raw) }
  }, raw);
  return /VALID/i.test(r.body);
}

/* 6 characters, no 0/O/1/I/L to survive being read aloud or retyped */
const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function giftCode(seed) {
  const h = crypto.createHash('sha256').update(seed + SECRET).digest();
  let out = '';
  for (let i = 0; i < 6; i++) out += ALPHA[h[i] % ALPHA.length];
  return 'DD-' + out;
}

exports.handler = async event => {
  const raw = event.body || '';
  try {
    if (!valid(raw, process.env.PAYFAST_PASSPHRASE)) return { statusCode: 400, body: 'Invalid signature' };

    const d = Object.fromEntries(new URLSearchParams(raw));
    if (d.payment_status !== 'COMPLETE') return { statusCode: 200, body: 'Ignored' };
    if (!SANDBOX && !(await confirm(raw)))  return { statusCode: 400, body: 'Not validated' };

    const mId   = d.m_payment_id;
    const order = (await dbGet(`dd_orders/${mId}`)) || {};
    const uid    = order.uid    || d.custom_str1;
    const tier   = order.tier   || d.custom_str2 || 'stream';
    const filmId = order.filmId || d.custom_str4 || 'destroying-desmond';
    const ref    = order.ref    || d.custom_str3 || null;
    if (!uid) return { statusCode: 400, body: 'No user' };

    if (order.status === 'paid') return { statusCode: 200, body: 'Already processed' };

    const now = Date.now();
    const cfg = (await dbGet('dd_config')) || {};

    if (tier === 'gift') {
      const code = giftCode(mId);
      await dbPut(`dd_gifts/${code}`, {
        filmId, buyerUid: uid, buyerEmail: d.email_address || order.email || '',
        toName: order.giftTo || '', message: order.giftMsg || '',
        amount: Number(d.amount_gross), ref, claimedBy: null, claimedAt: null, createdAt: now
      });
      // private pointer so the buyer can see their own code without reading dd_gifts
      await dbPatch(`dd_my_gifts/${uid}`, { [code]: now });
    } else {
      await dbPut(`flieks_purchases/${uid}/${filmId}`, {
        filmId, uid, type: tier, status: 'paid',
        amount: Number(d.amount_gross),
        pfPaymentId: d.pf_payment_id || '', mPaymentId: mId,
        ref,
        expiresAt: null,                       // stream clock starts on first play
        streamHours: cfg.streamHours ?? 48,
        purchasedAt: now
      });
    }

    await dbPatch(`dd_orders/${mId}`, { status: 'paid', paidAt: now, pfPaymentId: d.pf_payment_id || '' });

    /* ---- attribution: which actor's link earned this ---- */
    const gross = Number(d.amount_gross) || 0;
    if (ref) {
      const s = (await dbGet(`dd_stats/refs/${ref}`)) || {};
      await dbPatch(`dd_stats/refs/${ref}`, {
        sales:   (s.sales   || 0) + 1,
        revenue: +(((s.revenue || 0) + gross).toFixed(2)),
        [`by_${tier}`]: (s[`by_${tier}`] || 0) + 1
      });
    }
    const t = (await dbGet('dd_stats/totals')) || {};
    await dbPatch('dd_stats/totals', {
      sales:   (t.sales   || 0) + 1,
      revenue: +(((t.revenue || 0) + gross).toFixed(2)),
      [`by_${tier}`]: (t[`by_${tier}`] || 0) + 1
    });

    return { statusCode: 200, body: 'OK' };
  } catch (e) {
    return { statusCode: 500, body: 'Error: ' + e.message };
  }
};
