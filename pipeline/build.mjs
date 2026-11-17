#!/usr/bin/env node
// 6-hourly refresh: fetch iptv-org data -> curate -> health-check -> EPG -> site/data/*.json
// Usage: node pipeline/build.mjs [--out site/data] [--limit N] [--skip-health] [--skip-epg]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { curate, applyCaps, parseXmltv } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(k);
const OUT = opt('--out', 'site/data');
const LIMIT = parseInt(opt('--limit', '0'), 10);
const API = 'https://iptv-org.github.io/api/';

const config = JSON.parse(await readFile(new URL('../config/curation.json', import.meta.url), 'utf8'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function getJson(name) {
  const r = await fetch(API + name + '.json');
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return r.json();
}

async function checkStream(url) {
  const { timeoutMs } = config.health;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { Origin: config.siteOrigin, 'User-Agent': 'Mozilla/5.0 (WebTVHub health check)' }, redirect: 'follow', signal: ctrl.signal });
    if (!r.ok) return { ok: false, why: 'http_' + r.status };
    const body = (await r.text()).slice(0, 65536);
    if (!body.includes('#EXTM3U')) return { ok: false, why: 'not_m3u8' };
    // CORS on the final response; redirects (r.redirected) must also allow us, which we can't see here,
    // so a redirected stream is treated as native-HLS-only.
    let cors = !r.redirected && corsOk(r);
    if (cors) cors = await segmentCors(r.url, body, ctrl.signal);
    return { ok: true, cors };
  } catch (e) {
    return { ok: false, why: e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally { clearTimeout(t); }
}

function corsOk(r) {
  const acao = r.headers.get('access-control-allow-origin');
  return acao === '*' || acao === config.siteOrigin;
}

// The web player (hls.js) also needs CORS on the variant playlist and the video segments.
// Follow master -> first variant -> first segment and check each one.
async function segmentCors(baseUrl, body, signal) {
  const headers = { Origin: config.siteOrigin, 'User-Agent': 'Mozilla/5.0 (WebTVHub health check)' };
  const firstUri = (txt) => txt.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  try {
    let url = baseUrl, txt = body;
    if (txt.includes('#EXT-X-STREAM-INF')) {
      const v = firstUri(txt); if (!v) return true;
      url = new URL(v, url).href;
      const r = await fetch(url, { headers, signal });
      if (!r.ok || !corsOk(r)) return false;
      txt = await r.text();
    }
    const seg = firstUri(txt); if (!seg) return true;
    const r = await fetch(new URL(seg, url).href, { headers: { ...headers, Range: 'bytes=0-1023' }, signal });
    await r.arrayBuffer().catch(() => {});
    return (r.ok || r.status === 206) && corsOk(r);
  } catch {
    return false;
  }
}

async function pool(items, n, fn) {
  let i = 0; const res = new Array(items.length);
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); } }));
  return res;
}

log('fetching iptv-org api');
const [channels, streams, feeds, blocklist, logos] = await Promise.all(
  ['channels', 'streams', 'feeds', 'blocklist', 'logos'].map(getJson));
let { candidates, stats } = curate({ channels, streams, feeds, blocklist, logos }, config);
log(`candidates: ${candidates.length} channels`, JSON.stringify(stats.excluded));
if (LIMIT) candidates = candidates.slice(0, LIMIT);

const health = { checked: 0, ok: 0, fail: {} };
if (!flag('--skip-health')) {
  await pool(candidates, config.health.concurrency, async (c) => {
    const kept = [];
    for (const s of c.streams.slice(0, config.health.maxStreamsTriedPerChannel)) {
      health.checked++;
      const r = await checkStream(s.url);
      if (r.ok) { s.cors = r.cors; kept.push(s); health.ok++; if (r.cors) break; }
      else health.fail[r.why] = (health.fail[r.why] || 0) + 1;
    }
    c.streams = kept;
  });
  candidates = candidates.filter((c) => c.streams.length);
  log(`healthy: ${candidates.length} channels`, JSON.stringify(health));
} else {
  candidates.forEach((c) => { c.streams = c.streams.slice(0, 2); c.streams.forEach((s) => (s.cors = null)); });
}

const final = applyCaps(candidates, config);
log(`after caps: ${final.length} channels`);

// EPG
const epg = {};
let epgChannels = 0;
if (!flag('--skip-epg')) {
  const now = Date.now();
  const from = now - config.epg.pastHours * 3600e3, to = now + config.epg.futureHours * 3600e3;
  for (const src of config.epg.sources) {
    const re = new RegExp(src.streamPattern);
    const idToChannel = new Map();
    for (const c of final) for (const s of c.streams) { const m = re.exec(s.url); if (m) idToChannel.set(m[1], c.id); }
    if (!idToChannel.size) continue;
    try {
      log(`epg: ${src.name} (${idToChannel.size} channels)`);
      const r = await fetch(src.url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      let buf = Buffer.from(await r.arrayBuffer());
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
      const parsed = parseXmltv(buf.toString('utf8'), new Set(idToChannel.keys()), from, to);
      for (const [xid, list] of Object.entries(parsed)) {
        const cid = idToChannel.get(xid);
        if (!epg[cid]) { epg[cid] = list; epgChannels++; }
      }
    } catch (e) { log(`epg ${src.name} failed: ${e.message}`); }
  }
  log(`epg: ${epgChannels} channels with guide data`);
}

const generated = new Date().toISOString();
const categories = config.categoryMap.map(({ id, name }) => ({ id, name }));
const outChannels = final.map((c) => ({ ...c, hasEpg: !!epg[c.id] }));
await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/channels.json`, JSON.stringify({ generated, categories, channels: outChannels }));
await writeFile(`${OUT}/epg.json`, JSON.stringify({ generated, epg }));
await writeFile(`${OUT}/where-to-watch.json`, JSON.stringify(config.whereToWatch));
const byCat = Object.fromEntries(categories.map((c) => [c.name, outChannels.filter((x) => x.category === c.id).length]));
await writeFile(`${OUT}/report.json`, JSON.stringify({ generated, excluded: stats.excluded, health, byCategory: byCat, epgChannels }, null, 2));
log('done', JSON.stringify(byCat));
