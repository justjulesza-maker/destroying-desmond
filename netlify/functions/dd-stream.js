/**
 * dd-stream — releases the film URL only to someone who has paid.
 * The video URL lives in dd_private, which no client can read.
 *
 * POST { token, filmId, start? } -> { url }
 *   start:true  starts the rental clock on first play
 */
const https = require('https');

const DB      = (process.env.FIREBASE_DB_URL || 'https://flieks-app-default-rtdb.firebaseio.com').replace(/\/$/, '');
const SECRET  = process.env.FIREBASE_DB_SECRET;
const API_KEY = process.env.FIREBASE_API_KEY;

function req(url, opts = {}, body = null) {
  return new Promise((res, rej) => {
    const r = https.request(url, opts, x => {
      let d = ''; x.on('data', c => d += c);
      x.on('end', () => res({ status: x.statusCode, body: d }));
    });
    r.on('error', rej); if (body) r.write(body); r.end();
  });
}
const dbGet = async p => JSON.parse((await req(`${DB}/${p}.json?auth=${SECRET}`)).body || 'null');
const dbPatch = (p, data) => {
  const b = JSON.stringify(data);
  return req(`${DB}/${p}.json?auth=${SECRET}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } }, b);
};

async function verify(token) {
  const b = JSON.stringify({ idToken: token });
  const r = await req(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } }, b);
  const d = JSON.parse(r.body || '{}');
  if (!d.users || !d.users[0]) throw new Error('bad token');
  return d.users[0];
}

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
  try {
    const { token, filmId = 'destroying-desmond', start } = JSON.parse(event.body || '{}');
    const user = await verify(token);

    const p = await dbGet(`flieks_purchases/${user.localId}/${filmId}`);
    if (!p || p.status !== 'paid') return { statusCode: 403, body: 'No access' };

    const now = Date.now();

    if (p.type === 'stream') {
      if (!p.expiresAt) {
        if (start) {
          const hours = p.streamHours || 48;
          await dbPatch(`flieks_purchases/${user.localId}/${filmId}`,
            { expiresAt: now + hours * 3600e3, firstPlayAt: now });
        }
      } else if (now > p.expiresAt) {
        return { statusCode: 403, body: 'Rental expired' };
      }
    }

    if (start) return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };

    const priv = await dbGet(`dd_private/${filmId}`);
    if (!priv || !priv.videoUrl) return { statusCode: 404, body: 'No file' };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ url: priv.videoUrl })
    };
  } catch (e) {
    return { statusCode: 500, body: 'Error' };
  }
};
