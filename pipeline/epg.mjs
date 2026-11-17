// Guide data: XMLTV from public FAST listings.
// Match 1: stream URL pattern -> listing id (exact, e.g. Pluto channel id).
// Match 2: normalized channel name -> listing display-name (only for channels still without a guide).
import { gunzipSync } from 'node:zlib';
import { parseXmltv, parseXmltvChannels, normName } from './lib.mjs';

export async function buildEpg(channels, epgConfig, log) {
  const now = Date.now();
  const from = now - epgConfig.pastHours * 3600e3;
  const to = now + epgConfig.futureHours * 3600e3;
  const epg = {};
  const via = {};
  const meta = {}; // our channel id -> { desc, group } from the platform's own channel list
  const how = {};  // our channel id -> 'id' (exact stream match) | 'name'

  for (const src of epgConfig.sources) {
    let xml;
    try {
      const r = await fetch(src.url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      let buf = Buffer.from(await r.arrayBuffer());
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
      xml = buf.toString('utf8');
    } catch (e) {
      log(`epg ${src.name} failed: ${e.message}`);
      continue;
    }
    const want = new Map(); // listing id -> our channel id
    const byNameIds = new Set();
    if (src.streamPattern) {
      const re = new RegExp(src.streamPattern);
      for (const c of channels) {
        if (epg[c.id]) continue;
        for (const s of c.streams) { const m = re.exec(s.url); if (m) { want.set(m[1], c.id); break; } }
      }
    }
    if (src.matchByName) {
      const byName = new Map();
      for (const ch of parseXmltvChannels(xml)) {
        const k = normName(ch.name);
        if (k && !byName.has(k)) byName.set(k, ch.id);
      }
      for (const c of channels) {
        if (epg[c.id] || [...want.values()].includes(c.id)) continue;
        const id = byName.get(normName(c.name));
        if (id && !want.has(id)) { want.set(id, c.id); byNameIds.add(id); }
      }
    }
    if (!want.size) continue;
    const parsed = parseXmltv(xml, new Set(want.keys()), from, to);
    const info = src.channelsUrl ? await loadChannelInfo(src.channelsUrl, log) : new Map();
    let added = 0;
    for (const [xid, list] of Object.entries(parsed)) {
      const cid = want.get(xid);
      if (epg[cid] || !hasNowish(list, now)) continue;
      epg[cid] = list; via[cid] = src.name; how[cid] = byNameIds.has(xid) ? 'name' : 'id'; added++;
      const m = info.get(xid);
      if (m && m.desc && !meta[cid]) meta[cid] = m;
    }
    log(`epg ${src.name}: ${added} channels`);
  }
  // Final pass: iptv-org's guides.json maps channels to exact listing ids on i.mjh.nz (per-country Plex,
  // Roku, Pluto, Samsung, Foxtel, Australian regional files...). Exact ids, so no name guessing.
  if (epgConfig.iptvGuides !== false) {
    try {
      const r = await fetch('https://iptv-org.github.io/api/guides.json');
      const guides = r.ok ? await r.json() : [];
      const byFile = new Map(); // listing file -> Map(listing id -> our channel id)
      const ids = new Set(channels.filter((c) => !epg[c.id]).map((c) => c.id));
      for (const g of guides) {
        if (g.site !== 'i.mjh.nz' || !ids.has(g.channel) || !g.site_id.includes('#')) continue;
        const [file, xid] = g.site_id.split('#');
        if (!byFile.has(file)) byFile.set(file, new Map());
        if (![...byFile.values()].some((m) => [...m.values()].includes(g.channel))) byFile.get(file).set(xid, g.channel);
      }
      let added = 0;
      for (const [file, want] of byFile) {
        if (!want.size) continue;
        try {
          const rr = await fetch('https://i.mjh.nz/' + file + '.xml.gz');
          if (!rr.ok) continue;
          let buf = Buffer.from(await rr.arrayBuffer());
          if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
          const parsed = parseXmltv(buf.toString('utf8'), new Set(want.keys()), from, to);
          for (const [xid, list] of Object.entries(parsed)) {
            const cid = want.get(xid);
            if (epg[cid] || !hasNowish(list, now)) continue;
            epg[cid] = list; via[cid] = 'i.mjh.nz ' + file; how[cid] = 'id'; added++;
          }
        } catch (e) { /* one file failing shouldn't stop the rest */ }
      }
      log(`epg iptv-org guide map: ${added} channels from ${byFile.size} listing files`);
    } catch (e) { log(`epg iptv-org guide map failed: ${e.message}`); }
  }
  return { epg, via, meta, how };
}

// A guide is only useful if it covers the present; otherwise it's stale or for another feed.
function hasNowish(list, now) {
  return list.some((p) => p.s <= now + 30 * 60e3 && p.e >= now);
}

// Official channel descriptions published by the platform (English regions preferred).
const infoCache = new Map();
async function loadChannelInfo(url, log) {
  if (infoCache.has(url)) return infoCache.get(url);
  const out = new Map();
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const add = (id, c) => {
      if (!c || out.has(id)) return;
      const desc = (c.description || c.summary || '').replace(/\s+/g, ' ').trim();
      if (desc) out.set(id, { desc: desc.slice(0, 320), group: c.group || null });
    };
    if (d.channels && !d.regions) for (const [id, c] of Object.entries(d.channels)) add(id, c);
    if (d.regions) {
      const order = ['us', 'gb', 'ca', 'au', 'nz', 'in', ...Object.keys(d.regions)];
      for (const rk of order) {
        const reg = d.regions[rk];
        if (reg && reg.channels) for (const [id, c] of Object.entries(reg.channels)) add(id, c);
      }
      if (d.channels) for (const [id, c] of Object.entries(d.channels)) add(id, c);
    }
  } catch (e) {
    log(`channel info ${url} failed: ${e.message}`);
  }
  infoCache.set(url, out);
  return out;
}
