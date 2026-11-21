// POST   /api/email/reminder  { token, reminder: { ch, chName, title, start, url } }
// DELETE /api/email/reminder  { token, ch, start }
import { cors, json, rid, now } from './_email.js';

export const onRequestOptions = ({ request }) => new Response(null, { headers: cors(request) });

export async function addReminder(env, subId, r) {
  const ch = String(r.ch || ''); const start = Number(r.start);
  if (!/^[A-Za-z0-9._-]{2,80}$/.test(ch) || !Number.isFinite(start) || start < now() - 3600e3 || start > now() + 8 * 86400e3) return false;
  const url = /^https:\/\/[a-z0-9.-]+\//i.test(r.url || '') ? String(r.url).slice(0, 300) : null;
  await env.DB.prepare('INSERT OR IGNORE INTO email_reminders (id, sub_id, ch, ch_name, title, start, url, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)')
    .bind(rid(8), subId, ch, String(r.chName || '').slice(0, 120), String(r.title || 'Your show').slice(0, 200), start, url, now()).run();
  return true;
}
async function subByToken(env, token) {
  if (!/^[a-f0-9]{48}$/.test(String(token || ''))) return null;
  return env.DB.prepare('SELECT * FROM subscribers WHERE token = ?1 AND unsubscribed_at IS NULL').bind(token).first();
}
export async function onRequestPost({ request, env }) {
  let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, request); }
  const sub = await subByToken(env, b.token);
  if (!sub) return json({ error: 'unknown', resubscribe: true }, request);
  const ok = await addReminder(env, sub.id, b.reminder || {});
  return json({ ok, confirmed: !!sub.confirmed_at }, request);
}
export async function onRequestDelete({ request, env }) {
  let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, request); }
  const sub = await subByToken(env, b.token);
  if (!sub) return json({ ok: true }, request);
  await env.DB.prepare('DELETE FROM email_reminders WHERE sub_id = ?1 AND ch = ?2 AND start = ?3 AND sent_at IS NULL').bind(sub.id, String(b.ch || ''), Number(b.start)).run();
  return json({ ok: true }, request);
}
