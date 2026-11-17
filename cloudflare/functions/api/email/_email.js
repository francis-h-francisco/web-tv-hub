// Email reminders for Web TV Hub. Consent rules (Philippine Data Privacy Act, GDPR, CAN-SPAM):
// reminders never require marketing consent; marketing is a separate, optional, unticked choice that names
// who will email; double opt-in; one-click unsubscribe in every email. The exact consent wording is stored.
import { cors, json, today, reporter } from '../_shared.js';
export { cors, json };

export const CONSENT_VERSION = '2026-11-17';
export const REMINDER_TEXT = 'Email me reminders for the shows I choose. My email is used only for these reminders. I can unsubscribe anytime.';
export const MARKETING_TEXT = 'Also send me occasional updates and offers from Web TV Hub and its sister brands: Norvicka Studio (practical systems and automations for small businesses) and Pivory Systems (ready-made, automated business systems). I can unsubscribe anytime.';

export const EMAIL_RE = /^[^\s@<>()"',;:]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const now = () => Date.now();
export function rid(bytes = 16) { return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join(''); }
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** at most `max` calls per anonymous visitor per day for `kind` */
export async function rateLimited(env, request, kind, max) {
  const k = kind + ':' + (await reporter(request));
  const d = today();
  const row = await env.DB.prepare('SELECT n, day FROM rate WHERE k = ?1').bind(k).first();
  if (row && row.day === d && row.n >= max) return true;
  await env.DB.prepare('INSERT INTO rate (k, n, day) VALUES (?1, 1, ?2) ON CONFLICT(k) DO UPDATE SET n = CASE WHEN day = ?2 THEN n + 1 ELSE 1 END, day = ?2').bind(k, d).run();
  return false;
}

export function authorized(request, env) {
  const h = request.headers.get('Authorization') || '';
  return !!env.EMAIL_SECRET && env.EMAIL_SECRET.length >= 24 && h === 'Bearer ' + env.EMAIL_SECRET;
}

export function when(ms, tz) {
  try { return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz || 'UTC', timeZoneName: 'short' }).format(new Date(ms)); }
  catch { return new Date(ms).toUTCString(); }
}

// ---------- simple, readable emails (HTML + plain text) ----------
function wrap(origin, inner, unsubAll, unsubMk) {
  return `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#14171f">
<div style="max-width:520px;margin:0 auto;padding:24px 16px">
<div style="font-weight:800;font-size:18px;margin-bottom:12px"><span style="color:#ff5a5f">●</span> Web TV Hub</div>
<div style="background:#fff;border-radius:12px;padding:20px 20px 16px;line-height:1.5">${inner}</div>
<p style="font-size:12px;color:#6b7280;line-height:1.5;margin-top:14px">You're getting this because you asked Web TV Hub for email reminders.
${unsubMk ? `<a href="${unsubMk}" style="color:#6b7280">Stop offers only</a> · ` : ''}<a href="${unsubAll}" style="color:#6b7280">Unsubscribe from all emails</a> · <a href="${origin}/privacy.html" style="color:#6b7280">Privacy</a></p>
</div></body></html>`;
}
const btn = (href, label) => `<a href="${href}" style="display:inline-block;background:#ffb347;color:#1a1206;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:10px">${label}</a>`;

export function confirmEmail(origin, sub) {
  const link = `${origin}/api/email/confirm?t=${sub.token}`;
  const unsub = `${origin}/api/email/unsubscribe?t=${sub.token}`;
  const mk = sub.marketing
    ? `<p style="margin:12px 0 0;font-size:14px;color:#374151">You also chose to get occasional updates and offers from Web TV Hub, Norvicka Studio and Pivory Systems. You can stop those anytime without losing your reminders.</p>`
    : '';
  return {
    subject: 'Confirm your Web TV Hub reminders',
    html: wrap(origin, `<h2 style="margin:0 0 8px;font-size:20px">One tap to confirm</h2><p style="margin:0 0 16px">Confirm this email address and we'll send your show reminders here.</p>${btn(link, 'Confirm my email')}${mk}<p style="font-size:13px;color:#6b7280;margin:16px 0 0">Didn't ask for this? Ignore this email and nothing will be sent.</p>`, unsub, null),
    text: `Confirm your Web TV Hub reminders: ${link}\n\nDidn't ask for this? Ignore this email and nothing will be sent.\nUnsubscribe: ${unsub}`,
  };
}

export function reminderEmail(origin, sub, r) {
  const unsub = `${origin}/api/email/unsubscribe?t=${sub.token}`;
  const unsubMk = sub.marketing && !sub.marketing_withdrawn_at ? `${origin}/api/email/unsubscribe?t=${sub.token}&what=marketing` : null;
  const watch = r.url || `${origin}/?ch=${encodeURIComponent(r.ch)}`;
  const t = when(r.start, sub.tz);
  return {
    subject: `${r.title} starts soon on ${r.ch_name || 'Web TV Hub'}`,
    html: wrap(origin, `<div style="font-size:12px;font-weight:800;letter-spacing:.06em;color:#2563eb;text-transform:uppercase">Starting soon · ${esc(t)}</div><h2 style="margin:6px 0 4px;font-size:21px">${esc(r.title)}</h2><p style="margin:0 0 16px;color:#374151">On ${esc(r.ch_name || '')}, free on Web TV Hub.</p>${btn(watch, '▶ Watch now')}`, unsub, unsubMk),
    text: `${r.title} starts ${t} on ${r.ch_name || 'Web TV Hub'}.\nWatch: ${watch}\n\nUnsubscribe: ${unsub}`,
  };
}

export function page(title, body, ok = true, token = null) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} — Web TV Hub</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#eef1f6;font-family:system-ui,sans-serif;text-align:center}.c{max-width:28rem;margin:1.5rem}p{color:#98a2b3;line-height:1.5}a.b{display:inline-block;margin-top:.8rem;padding:.9rem 1.4rem;border-radius:.7rem;background:#ffb347;color:#1a1206;font-weight:700;text-decoration:none}</style></head>
<body><div class="c"><h1>${esc(title)}</h1><p>${body}</p><a class="b" href="/">Back to Web TV Hub</a></div>${token ? `<script>try{localStorage.setItem('wth.emailToken',JSON.stringify('${token}'))}catch(e){}</script>` : ''}</body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
