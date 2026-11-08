import { createRestDb, handleGrokRequest, MAX_BODY } from './bridge.mjs';

function secretKey() {
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.default === 'string' && parsed.default) return parsed.default;
    } catch { /* fall through to the legacy variable */ }
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
}

const CORS = {
  'Access-Control-Allow-Headers': 'apikey,content-type,x-grok-access',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Origin': '*',
  Vary: 'Origin',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
  const url = Deno.env.get('SUPABASE_URL') || '';
  const key = secretKey();
  if (!url || !key) return json({ error: 'Backend configuration missing' }, 503);
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY) return json({ error: 'Request too large' }, 413);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: 'Request too large' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: 'Invalid request' }, 400); }
  const ip = (request.headers.get('x-forwarded-for') || request.headers.get('cf-connecting-ip') || 'unknown').split(',')[0].trim();
  try {
    const result = await handleGrokRequest({
      body,
      accessToken: request.headers.get('x-grok-access') || '',
      ip,
      db: createRestDb({ url, key }),
    });
    return json(result.body, result.status);
  } catch {
    return json({ error: 'Service temporarily unavailable' }, 503);
  }
});
