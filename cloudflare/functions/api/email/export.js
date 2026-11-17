// GET /api/email/export   Authorization: Bearer <EMAIL_SECRET>
// CSV of people who confirmed their email AND explicitly opted in to marketing, with the consent record.
import { authorized, json } from './_email.js';
export async function onRequestGet({ request, env }) {
  if (!authorized(request, env)) return json({ error: 'unauthorized' }, request);
  const { results } = await env.DB.prepare(
    `SELECT email, cc, consent_version, consent_at, consent_text, confirmed_at FROM subscribers
     WHERE marketing = 1 AND marketing_withdrawn_at IS NULL AND unsubscribed_at IS NULL AND confirmed_at IS NOT NULL ORDER BY consent_at`
  ).all();
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const iso = (ms) => (ms ? new Date(ms).toISOString() : '');
  const rows = [['email', 'country', 'consent_version', 'consent_at', 'confirmed_at', 'consent_text'].join(',')]
    .concat(results.map((r) => [r.email, r.cc, r.consent_version, iso(r.consent_at), iso(r.confirmed_at), r.consent_text].map(q).join(',')));
  return new Response(rows.join('\n') + '\n', { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="marketing-optins.csv"', 'Cache-Control': 'no-store' } });
}
