// LMG AI server (Vercel).
// Environment variables: GEMINI_API_KEY, RELAY_TOKENS (comma-separated).
// Daily limits (stored in Upstash Redis): UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL + KV_REST_API_TOKEN).
// Optional: DAILY_MESSAGES (default 80 per device), DAILY_CALLS (default 400), DAILY_IP_MESSAGES (default 600 per network).
const OK_PATH = /^\/v1beta\/models\/(gemma|gemini)-[\w.-]+:(generateContent|streamGenerateContent)$/;
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const mem = new Map();   // fallback when Redis is not configured (per server instance, best effort only)

async function bump(keys) {   // add 1 to every counter (they expire after 2 days) and return the new values
  if (REDIS_URL && REDIS_TOKEN) {
    const cmds = []; keys.forEach(k => cmds.push(['INCR', k], ['EXPIRE', k, 172800]));
    const r = await fetch(REDIS_URL + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + REDIS_TOKEN }, body: JSON.stringify(cmds) });
    if (!r.ok) throw new Error('counter store error ' + r.status);
    const out = await r.json(); return keys.map((_, i) => Number(out[i * 2].result));
  }
  return keys.map(k => { const n = (mem.get(k) || 0) + 1; mem.set(k, n); if (mem.size > 20000) mem.clear(); return n; });
}
function capped(b) {   // never let a client ask for huge outputs
  b = b || {}; const g = b.generationConfig || {};
  return { ...b, generationConfig: { ...g, maxOutputTokens: Math.min(g.maxOutputTokens || 4096, 4096) } };
}

module.exports = async (req, res) => {
  if (req.query.ping) return res.status(200).send('lmg-ai server is running');
  const tokens = (process.env.RELAY_TOKENS || process.env.RELAY_TOKEN || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!tokens.length) return res.status(403).send('forbidden: RELAY_TOKENS is not set on the server');
  const got = String(req.headers['x-relay-token'] || '').trim();
  if (!got) return res.status(403).send('forbidden: the request had no x-relay-token header');
  if (!tokens.includes(got)) return res.status(403).send(`forbidden: wrong token (received ${got.length} characters, server expects ${tokens.map(t => t.length).join(' or ')})`);
  const path = '/v1beta/' + [].concat(req.query.path || []).join('/').replace(/^\/+/, '');
  if (req.method !== 'POST' || !OK_PATH.test(path)) return res.status(404).send('not found: ' + path);
  const key = process.env.GEMINI_API_KEY || req.headers['x-goog-api-key'] || '';
  if (!key) return res.status(500).send('server error: GEMINI_API_KEY is not set');
  const dev = String(req.headers['x-device-id'] || '').slice(0, 64);
  if (!/^[A-Za-z0-9-]{16,64}$/.test(dev)) return res.status(400).send('missing or invalid x-device-id');

  // daily limits: a "message" is the first request of a user message (x-lmg-new: 1); follow-up calls only count towards the call cap
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const day = new Date().toISOString().slice(0, 10), isNew = req.headers['x-lmg-new'] === '1';
  const MAXM = Number(process.env.DAILY_MESSAGES) || 80, MAXC = Number(process.env.DAILY_CALLS) || 400, MAXIP = Number(process.env.DAILY_IP_MESSAGES) || 600;
  let counts;
  try { counts = await bump([`c:${dev}:${day}`, ...(isNew ? [`m:${dev}:${day}`, `i:${ip}:${day}`] : [])]); }
  catch (e) { return res.status(503).send('server error: usage counter unavailable'); }
  const [calls, msgs = 0, ipMsgs = 0] = counts;
  if (calls > MAXC) return res.status(429).send(`daily limit: too many requests today (${MAXC}). Try again tomorrow.`);
  if (isNew && msgs > MAXM) return res.status(429).send(`daily limit: ${MAXM} messages per day reached. Try again tomorrow.`);
  if (isNew && ipMsgs > MAXIP) return res.status(429).send('daily limit: this network reached its daily limit. Try again tomorrow.');

  const q = new URLSearchParams(req.query); q.delete('path'); q.delete('ping');
  try {
    const r = await fetch('https://generativelanguage.googleapis.com' + path + (q.toString() ? '?' + q : ''), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(capped(req.body)),
    });
    if (isNew) res.setHeader('x-lmg-remaining', String(Math.max(0, MAXM - msgs)));
    res.status(r.status).setHeader('content-type', r.headers.get('content-type') || 'application/json');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(502).send('server error: could not reach Google: ' + e.message); }
};
