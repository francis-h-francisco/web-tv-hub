// GET /api/email/due   Authorization: Bearer <EMAIL_SECRET>
// Called every ~10 minutes by the Google Apps Script sender. Returns the emails to send now and marks them
// as sent (each email is handed out once). Reminders go out about an hour before the show.
import { json, authorized, now, confirmEmail, reminderEmail } from './_email.js';
const LEAD = 60 * 60e3, WINDOW = 12 * 60e3;
export async function onRequestGet({ request, env }) {
  if (!authorized(request, env)) return json({ error: 'unauthorized' }, request);
  const u = new URL(request.url); const origin = u.origin;
  // the sender says how many emails it may still send today (Gmail's daily quota); never hand out more
  let budget = Math.max(0, Math.min(200, parseInt(u.searchParams.get('max') || '50', 10) || 0));
  const out = [];
  // 1. confirmation emails for new sign-ups (once; resent if they sign up again)
  const pend = await env.DB.prepare('SELECT * FROM subscribers WHERE confirmed_at IS NULL AND confirm_sent_at IS NULL AND unsubscribed_at IS NULL AND created_at > ?1 LIMIT ?2').bind(now() - 7 * 86400e3, budget).all();
  for (const s of pend.results) {
    const m = confirmEmail(origin, s);
    out.push({ to: s.email, ...m, unsubscribe: `${origin}/api/email/unsubscribe?t=${s.token}` }); budget--;
    await env.DB.prepare('UPDATE subscribers SET confirm_sent_at = ?2 WHERE id = ?1').bind(s.id, now()).run();
  }
  // 2. reminders starting within the next hour (+ a margin for the polling interval), confirmed addresses only
  const due = await env.DB.prepare(
    `SELECT r.*, s.email, s.token, s.tz, s.marketing, s.marketing_withdrawn_at FROM email_reminders r JOIN subscribers s ON s.id = r.sub_id
     WHERE r.sent_at IS NULL AND r.start <= ?1 AND r.start > ?2 AND s.confirmed_at IS NOT NULL AND s.unsubscribed_at IS NULL LIMIT ?3`
  ).bind(now() + LEAD + WINDOW, now() - 5 * 60e3, Math.max(0, budget)).all();
  for (const r of due.results) {
    const m = reminderEmail(origin, r, r);
    out.push({ to: r.email, ...m, unsubscribe: `${origin}/api/email/unsubscribe?t=${r.token}` });
    await env.DB.prepare('UPDATE email_reminders SET sent_at = ?2 WHERE id = ?1').bind(r.id, now()).run();
  }
  // housekeeping: forget reminders a week after the show
  await env.DB.prepare('DELETE FROM email_reminders WHERE start < ?1').bind(now() - 7 * 86400e3).run();
  return json({ messages: out }, request);
}
