// Counts clicks on "Where to watch" links: per day, service and country only. No personal data.
import { json, cors, today } from './_shared.js';

export const onRequestOptions = ({ request }) => new Response(null, { headers: cors(request) });

export async function onRequestPost({ request, env }) {
  let body = {};
  try { body = await request.json(); } catch { /* sendBeacon may send text */ }
  const svc = String(body.s || '').toLowerCase();
  if (!/^[a-z0-9-]{1,40}$/.test(svc)) return json({ ok: false }, request);
  const country = (request.cf && request.cf.country) || '??';
  await env.DB.prepare('INSERT INTO clicks (day, svc, country, n) VALUES (?, ?, ?, 1) ON CONFLICT(day, svc, country) DO UPDATE SET n = n + 1')
    .bind(today(), svc, country).run();
  return json({ ok: true }, request);
}

// Totals for the last 30 days: /api/out (public; just counts)
export async function onRequestGet({ request, env }) {
  const { results } = await env.DB.prepare('SELECT svc, country, SUM(n) AS clicks FROM clicks WHERE day >= ? GROUP BY svc, country ORDER BY clicks DESC LIMIT 200').bind(today() - 30).all();
  return json({ days: 30, clicks: results }, request, { 'Cache-Control': 'max-age=300' });
}
