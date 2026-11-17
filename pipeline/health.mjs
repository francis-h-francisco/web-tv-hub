// Stream health check: a channel is only listed if it really delivers video.
// Checks master playlist -> first variant playlist -> first media segment.
// Also records whether the browser web player (hls.js) can read every step (CORS).

const UA = 'Mozilla/5.0 (WebTVHub health check)';
const firstUri = (txt) => txt.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));

export function makeChecker({ siteOrigin, timeoutMs }) {
  const corsOk = (r) => {
    const a = r.headers.get('access-control-allow-origin');
    return a === '*' || a === siteOrigin;
  };
  const headers = { Origin: siteOrigin, 'User-Agent': UA };

  return async function checkStream(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // 1. master
      const r = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
      if (!r.ok) return { ok: false, why: 'http_' + r.status };
      let txt = (await r.text()).slice(0, 262144);
      if (!txt.includes('#EXTM3U')) return { ok: false, why: 'not_m3u8' };
      let cors = !r.redirected && corsOk(r);
      let base = r.url;
      // 2. variant
      if (txt.includes('#EXT-X-STREAM-INF')) {
        const v = firstUri(txt);
        if (!v) return { ok: false, why: 'no_variant' };
        base = new URL(v, base).href;
        const rv = await fetch(base, { headers, signal: ctrl.signal });
        if (!rv.ok) return { ok: false, why: 'variant_' + rv.status };
        cors = cors && !rv.redirected && corsOk(rv);
        txt = (await rv.text()).slice(0, 262144);
        if (!txt.includes('#EXTINF')) return { ok: false, why: 'variant_empty' };
        base = rv.url;
      }
      // 3. first media segment (a real byte of video)
      const seg = firstUri(txt);
      if (!seg) return { ok: false, why: 'no_segment' };
      const rs = await fetch(new URL(seg, base).href, { headers: { ...headers, Range: 'bytes=0-2047' }, signal: ctrl.signal });
      const bytes = await rs.arrayBuffer().catch(() => new ArrayBuffer(0));
      if (!(rs.ok || rs.status === 206) || bytes.byteLength === 0) return { ok: false, why: 'segment_' + rs.status };
      cors = cors && corsOk(rs);
      return { ok: true, cors };
    } catch (e) {
      return { ok: false, why: e.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      clearTimeout(t);
    }
  };
}
