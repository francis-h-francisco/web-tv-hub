// POST /api/email/subscribe  { email, marketing: bool, tz, reminder?: { ch, chName, title, start, url } }
import { cors, json, EMAIL_RE, rid, now, rateLimited, CONSENT_VERSION, REMINDER_TEXT, MARKETING_TEXT } from './_email.js';
import { reporter } from '../_shared.js';
import { addReminder } from './reminder.js';

export const onRequestOptions = ({ request }) => new Response(null, { headers: cors(request) });

export async function onRequestPost({ request, env }) {
  let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, request); }
  const email = String(b.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json({ error: 'Please check the email address.' }, request);
  if (await rateLimited(env, request, 'sub', 8)) return json({ error: 'Too many tries today. Please try again tomorrow.' }, request);
  const marketing = b.marketing === true; // only an explicit, unticked-by-default choice counts
  const tz = String(b.tz || '').slice(0, 60);
  const cc = (request.cf && request.cf.country) || null;
  const consentText = REMINDER_TEXT + (marketing ? ' ' + MARKETING_TEXT : '');
  const ipHash = await reporter(request);
  let sub = await env.DB.prepare('SELECT * FROM subscribers WHERE email = ?1').bind(email).first();
  if (!sub) {
    sub = { id: rid(8), email, token: rid(24), tz, cc, marketing: marketing ? 1 : 0 };
    await env.DB.prepare('INSERT INTO subscribers (id, email, token, tz, cc, marketing, consent_text, consent_version, consent_at, consent_ip, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)')
      .bind(sub.id, email, sub.token, tz, cc, sub.marketing, consentText, CONSENT_VERSION, now(), ipHash, now()).run();
  } else if (b.token && b.token === sub.token) {
    // same browser that signed up (holds the private token): update preferences directly
    const mk = marketing ? 1 : sub.marketing && !sub.marketing_withdrawn_at ? 1 : 0;
    await env.DB.prepare('UPDATE subscribers SET tz = ?2, unsubscribed_at = NULL, marketing = ?3, marketing_withdrawn_at = CASE WHEN ?3 = 1 THEN NULL ELSE marketing_withdrawn_at END, consent_text = ?4, consent_version = ?5, consent_at = ?6, consent_ip = ?7 WHERE id = ?1')
      .bind(sub.id, tz, mk, consentText, CONSENT_VERSION, now(), ipHash).run();
  } else {
    // An existing address entered from another browser: nothing changes until the owner confirms by email
    // (so nobody can opt someone else in to offers), and the private token is not handed out here.
    await env.DB.prepare('UPDATE subscribers SET tz = ?2, unsubscribed_at = NULL, marketing = ?3, marketing_withdrawn_at = CASE WHEN ?3 = 1 THEN NULL ELSE marketing_withdrawn_at END, consent_text = ?4, consent_version = ?5, consent_at = ?6, consent_ip = ?7, confirmed_at = NULL, confirm_sent_at = NULL WHERE id = ?1')
      .bind(sub.id, tz, marketing ? 1 : 0, consentText, CONSENT_VERSION, now(), ipHash).run();
    if (b.reminder) await addReminder(env, sub.id, b.reminder);
    return json({ ok: true, token: null, confirmed: false, checkEmail: true }, request);
  }
  if (b.reminder) await addReminder(env, sub.id, b.reminder);
  // The token lets this browser add more reminders without retyping the email. It is never shown to others.
  return json({ ok: true, token: sub.token, confirmed: !!sub.confirmed_at }, request);
}
