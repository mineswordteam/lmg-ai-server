const OK_PATH = /^\/v1beta\/models\/(gemma|gemini)-[\w.-]+:(generateContent|streamGenerateContent)$/;
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
  const q = new URLSearchParams(req.query); q.delete('path'); q.delete('ping');
  try {
    const r = await fetch('https://generativelanguage.googleapis.com' + path + (q.toString() ? '?' + q : ''), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(req.body),
    });
    res.status(r.status).setHeader('content-type', r.headers.get('content-type') || 'application/json');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(502).send('server error: could not reach Google: ' + e.message); }
};
