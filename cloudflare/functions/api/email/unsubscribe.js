// GET/POST /api/email/unsubscribe?t=<token>[&what=marketing]
// One click, no login. "what=marketing" keeps reminders but stops offers.
import { page, now } from './_email.js';
async function run(request, env) {
  const u = new URL(request.url); const t = u.searchParams.get('t') || ''; const what = u.searchParams.get('what');
  if (!/^[a-f0-9]{48}$/.test(t)) return page('Link not valid', 'This unsubscribe link is incomplete. Reply to any of our emails and we’ll remove you.', false);
  if (what === 'marketing') {
    await env.DB.prepare('UPDATE subscribers SET marketing = 0, marketing_withdrawn_at = ?2 WHERE token = ?1').bind(t, now()).run();
    return page('Offers stopped', 'You won’t get updates or offers anymore. Your show reminders keep coming.');
  }
  const s = await env.DB.prepare('SELECT id FROM subscribers WHERE token = ?1').bind(t).first();
  if (s) {
    await env.DB.prepare('UPDATE subscribers SET unsubscribed_at = ?2, marketing = 0, marketing_withdrawn_at = COALESCE(marketing_withdrawn_at, ?2) WHERE id = ?1').bind(s.id, now()).run();
    await env.DB.prepare('DELETE FROM email_reminders WHERE sub_id = ?1 AND sent_at IS NULL').bind(s.id).run();
  }
  return page('Unsubscribed', 'You won’t get any more emails from Web TV Hub. Changed your mind? Set a reminder again anytime.');
}
export const onRequestGet = ({ request, env }) => run(request, env);
export const onRequestPost = ({ request, env }) => run(request, env); // one-click unsubscribe (RFC 8058)
