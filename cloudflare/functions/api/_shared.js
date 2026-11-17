// Shared helpers for the tiny Web TV Hub API (Cloudflare Pages Functions + D1).
const ORIGINS = ['https://francis-h-francisco.github.io', 'https://webtv.pages.dev'];

export function cors(request) {
  const o = request.headers.get('Origin') || '';
  const ok = ORIGINS.includes(o) || /^https:\/\/[a-z0-9-]+\.webtv\.pages\.dev$/.test(o) || /^https?:\/\/localhost(:\d+)?$/.test(o);
  return {
    'Access-Control-Allow-Origin': ok ? o : ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
export const json = (data, request, extra = {}) =>
  new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', ...cors(request), ...extra } });
export const today = () => Math.floor(Date.now() / 86400000);

// Anonymous, per-day reporter id: a hash of IP + day + a fixed salt. Never stored raw; changes daily.
export async function reporter(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const data = new TextEncoder().encode('webtv:' + today() + ':' + ip);
  const h = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(h)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}
