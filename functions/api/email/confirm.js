// GET /api/email/confirm?t=<token>  (link in the confirmation email)
import { page, now } from './_email.js';
export async function onRequestGet({ request, env }) {
  const t = new URL(request.url).searchParams.get('t') || '';
  if (!/^[a-f0-9]{48}$/.test(t)) return page('Link not valid', 'This confirmation link is incomplete. Try setting the reminder again.', false);
  const r = await env.DB.prepare('UPDATE subscribers SET confirmed_at = COALESCE(confirmed_at, ?2), unsubscribed_at = NULL WHERE token = ?1').bind(t, now()).run();
  if (!r.meta.changes) return page('Link not valid', 'We couldn’t find this sign-up. Try setting the reminder again.', false);
  // this browser can now add more reminders without retyping the address
  return page('You’re all set', 'Your email is confirmed. We’ll email you about an hour before the shows you set reminders for.', true, t);
}
