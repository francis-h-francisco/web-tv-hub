// GET /api/email/status?t=<token>  ->  { email: "k***@gmail.com", confirmed, marketing }
import { json, cors } from './_email.js';
export const onRequestOptions = ({ request }) => new Response(null, { headers: cors(request) });
export async function onRequestGet({ request, env }) {
  const t = new URL(request.url).searchParams.get('t') || '';
  if (!/^[a-f0-9]{48}$/.test(t)) return json({ ok: false }, request);
  const s = await env.DB.prepare('SELECT email, confirmed_at, marketing, marketing_withdrawn_at, unsubscribed_at FROM subscribers WHERE token = ?1').bind(t).first();
  if (!s || s.unsubscribed_at) return json({ ok: false }, request);
  const [u, d] = s.email.split('@');
  return json({ ok: true, email: u.slice(0, 1) + '***@' + d, confirmed: !!s.confirmed_at, marketing: !!s.marketing && !s.marketing_withdrawn_at }, request);
}
