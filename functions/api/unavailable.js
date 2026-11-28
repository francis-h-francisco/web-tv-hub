// GET /api/unavailable  ->  { cc, ids: [...] }
// Channels that at least 3 different viewers in the caller's country couldn't play in the last 2 days,
// and that failed far more often than they worked. The app hides them for everyone in that country.
import { cors, json, today } from './_shared.js';

export const onRequestOptions = ({ request }) => new Response(null, { headers: cors(request) });

export async function onRequestGet({ request, env }) {
  const cc = (request.cf && request.cf.country) || 'XX';
  const { results } = await env.DB.prepare(
    `SELECT ch, SUM(ok = 0) AS f, SUM(ok = 1) AS s FROM votes WHERE cc = ?1 AND day >= ?2 GROUP BY ch HAVING f >= 3 AND f > s * 2`
  ).bind(cc, today() - 1).all();
  return json({ cc, ids: results.map((r) => r.ch) }, request, { 'Cache-Control': 'public, max-age=600' });
}
