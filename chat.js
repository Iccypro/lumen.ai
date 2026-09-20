// Vercel serverless function: keeps your API key on the server.
// Set ANTHROPIC_API_KEY in Vercel -> Settings -> Environment Variables.

const MODELS = {
  quick: process.env.MODEL_QUICK || 'claude-haiku-4-5-20251001',
  default: process.env.MODEL_DEFAULT || 'claude-sonnet-5',
  complex: process.env.MODEL_COMPLEX || 'claude-opus-5'
};

const SYSTEM =
  'You are the assistant inside a chat app called Lumen, built on Claude by Anthropic. ' +
  'Be helpful, honest and clear. If someone sincerely asks whether you are an AI or which model powers you, answer truthfully.';

// Simple per-IP limit (best effort: resets when the function restarts).
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = Number(process.env.RATE_LIMIT || 20);
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS) { hits.set(ip, recent); return true; }
  recent.push(now); hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return false;
}

const IMG_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'missing_api_key', detail: 'The ANTHROPIC_API_KEY variable is not set on this project.' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (limited(ip)) return res.status(429).json({ error: 'rate_limited' });

  const body = req.body || {};
  const msgs = body.messages;
  if (!Array.isArray(msgs) || !msgs.length || msgs.length > 60) return res.status(400).json({ error: 'bad_messages' });

  let total = 0;
  const messages = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || typeof m.content !== 'string' || !m.content) return res.status(400).json({ error: 'bad_messages' });
    if (m.role !== (i % 2 === 0 ? 'user' : 'assistant')) return res.status(400).json({ error: 'bad_order' });
    total += m.content.length;
    messages.push({ role: m.role, content: m.content });
  }
  if (messages[messages.length - 1].role !== 'user') return res.status(400).json({ error: 'bad_order' });
  if (total > 70000) return res.status(413).json({ error: 'too_large' });

  const images = Array.isArray(body.images) ? body.images.slice(0, 3) : [];
  if (images.length) {
    const blocks = [];
    for (const im of images) {
      if (!im || !IMG_TYPES.includes(im.media_type) || typeof im.data !== 'string') return res.status(400).json({ error: 'bad_image' });
      blocks.push({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } });
    }
    const last = messages[messages.length - 1];
    last.content = [...blocks, { type: 'text', text: last.content }];
  }

  const model = MODELS[body.tier] || MODELS.default;

  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 4096, stream: true, system: SYSTEM, messages })
    });
  } catch (e) {
    return res.status(502).json({ error: 'upstream_unreachable' });
  }
  if (!upstream.ok) {
    let msg = '';
    try { const j = JSON.parse(await upstream.text()); msg = (j.error && j.error.message) || ''; } catch (e) {}
    return res.status(upstream.status === 429 ? 429 : 502).json({ error: 'upstream_error', detail: ('Anthropic returned ' + upstream.status + (msg ? ': ' + msg : '')).slice(0, 220) });
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  const reader = upstream.body.getReader();
  req.on('close', () => { reader.cancel().catch(() => {}); });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch (e) { /* client left or stream ended */ }
  res.end();
};
