// POST /api/report  { ch: "<channel id>", ok: true|false }
// The viewer's country comes from Cloudflare (request.cf.country), not from the client.
import { cors, json, today, reporter } from './_shared.js';

export const onRequestOptions = ({ request }) => new Response(null, { headers: cors(request) });

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, request); }
  const ch = String(body.ch || '');
  if (!/^[A-Za-z0-9._-]{2,80}$/.test(ch) || typeof body.ok !== 'boolean') return json({ error: 'bad input' }, request);
  const cc = (request.cf && request.cf.country) || 'XX';
  if (!/^[A-Z]{2}$/.test(cc) || cc === 'XX' || cc === 'T1') return json({ ok: true, skipped: true }, request);
  const who = await reporter(request);
  // one vote per person per channel per day (latest wins)
  await env.DB.prepare('INSERT INTO votes (cc, ch, day, who, ok) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(cc, ch, day, who) DO UPDATE SET ok = excluded.ok')
    .bind(cc, ch, today(), who, body.ok ? 1 : 0).run();
  return json({ ok: true }, request);
}
