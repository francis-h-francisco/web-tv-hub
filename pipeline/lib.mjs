// Pure curation logic (no network). Tested by pipeline/test.mjs.

export function regDomain(host) {
  if (!host) return '';
  const p = host.toLowerCase().split('.');
  // keep 3 labels for common 2-level public suffixes (co.uk, com.ph, ...)
  const two = p.slice(-2).join('.');
  if (/^(co|com|net|org|gov|ac|edu)\.[a-z]{2}$/.test(two) && p.length >= 3) return p.slice(-3).join('.');
  return two;
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function hostMatches(host, list) {
  return list.some((h) => host === h || host.endsWith('.' + h));
}

/** Returns 'website' | 'trusted' | 'fast' | 'denied' | 'unknown' */
export function classifySource(streamUrl, channelWebsite, policy) {
  const host = hostOf(streamUrl);
  if (!host) return 'denied';
  if (hostMatches(host, policy.deniedHosts)) return 'denied';
  const site = hostOf(channelWebsite || '');
  if (policy.allowWebsiteDomainMatch && site && regDomain(site) === regDomain(host)) return 'website';
  if (hostMatches(host, policy.fastRedirectors)) return 'fast';
  if (hostMatches(host, policy.trustedHosts)) return 'trusted';
  return 'unknown';
}

const SOURCE_RANK = { website: 0, trusted: 1, fast: 2 };
const QUALITY = (q) => parseInt(q || '0', 10) || 0;

export function pickCategory(channel, config) {
  const forced = config.extraChannels?.[channel.id];
  if (forced) return forced;
  for (const c of config.categoryMap) {
    if (channel.categories.some((k) => c.from.includes(k))) return c.id;
  }
  return null;
}

/**
 * Build the candidate list: one entry per channel with its ordered streams.
 * data = { channels, streams, feeds, blocklist, logos }
 */
export function curate(data, config) {
  const blocked = new Set(data.blocklist.map((b) => b.channel));
  const denied = new Set(config.denyChannels || []);
  const excl = new Set(config.excludeCategories);
  const langs = new Set(config.languages);
  const countries = new Set(config.alwaysIncludeCountries);
  const today = new Date().toISOString().slice(0, 10);

  const mainFeed = new Map();
  const feedById = new Map();
  for (const f of data.feeds) {
    feedById.set(f.channel + '@' + f.id, f);
    if (f.is_main) mainFeed.set(f.channel, f);
  }
  const logo = new Map();
  for (const l of data.logos) {
    if (!l.in_use || l.feed) continue;
    const cur = logo.get(l.channel);
    // prefer wide-ish PNG/SVG logos
    if (!cur || (l.format !== 'GIF' && l.width > cur.width)) logo.set(l.channel, l);
  }

  const chById = new Map(data.channels.map((c) => [c.id, c]));
  const out = new Map();
  const stats = { streams: data.streams.length, excluded: {} };
  const bump = (k) => (stats.excluded[k] = (stats.excluded[k] || 0) + 1);

  for (const s of data.streams) {
    const ch = chById.get(s.channel);
    if (!ch) { bump('noChannel'); continue; }
    if (blocked.has(ch.id) || denied.has(ch.id) || ch.is_nsfw) { bump('blocklist'); continue; }
    if (ch.closed && ch.closed <= today) { bump('closed'); continue; }
    if (ch.categories.some((k) => excl.has(k))) { bump('excludedCategory'); continue; }
    if (!s.url.startsWith('https://')) { bump('notHttps'); continue; }
    if (s.user_agent || s.referrer) { bump('needsHeaders'); continue; }
    const category = pickCategory(ch, config);
    if (!category) { bump('noCategory'); continue; }
    const feed = (s.feed && feedById.get(ch.id + '@' + s.feed)) || mainFeed.get(ch.id);
    const chLangs = feed?.languages || [];
    if (!countries.has(ch.country) && !chLangs.some((l) => langs.has(l))) { bump('language'); continue; }
    const source = classifySource(s.url, ch.website, config.sourcePolicy);
    if (source === 'denied' || source === 'unknown') { bump('source_' + source); continue; }

    let entry = out.get(ch.id);
    if (!entry) {
      entry = {
        id: ch.id,
        name: ch.name,
        country: ch.country,
        category,
        tags: ch.categories,
        languages: chLangs,
        website: ch.website || null,
        logo: logo.get(ch.id)?.url || null,
        streams: [],
      };
      out.set(ch.id, entry);
    }
    entry.streams.push({
      url: s.url,
      quality: s.quality || null,
      source,
      geoBlocked: s.labels.includes('Geo-blocked'),
      not247: s.labels.includes('Not 24/7'),
    });
  }

  for (const e of out.values()) {
    e.streams.sort((a, b) =>
      (a.geoBlocked - b.geoBlocked) || (SOURCE_RANK[a.source] - SOURCE_RANK[b.source]) ||
      (a.not247 - b.not247) || (QUALITY(b.quality) - QUALITY(a.quality)));
  }
  return { candidates: [...out.values()], stats };
}

/** Apply news caps and per-category caps to channels that passed health checks. */
export function applyCaps(channels, config) {
  const n = config.news;
  const byCat = new Map();
  for (const c of channels) {
    if (!byCat.has(c.category)) byCat.set(c.category, []);
    byCat.get(c.category).push(c);
  }
  const news = byCat.get('news') || [];
  const intl = n.international.map((id) => news.find((c) => c.id === id)).filter(Boolean).slice(0, n.internationalMax);
  const localPool = news.filter((c) => c.country === n.localCountry);
  localPool.sort((a, b) => rankIn(n.localPreferred, a.id) - rankIn(n.localPreferred, b.id));
  byCat.set('news', [...intl, ...localPool.slice(0, n.localMax)]);

  const result = [];
  for (const cat of config.categoryMap) {
    const list = [...(byCat.get(cat.id) || [])];
    // PH first, then English 24/7 official sources
    if (cat.id !== 'news') list.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
    result.push(...list.slice(0, cat.id === 'news' ? list.length : config.maxPerCategory));
  }
  return result;
}

function rankIn(arr, id) { const i = arr.indexOf(id); return i < 0 ? 999 : i; }
function score(c) {
  const s = c.streams[0] || {};
  return (c.country === 'PH' ? 4 : 0) + (s.source === 'website' ? 2 : s.source === 'trusted' ? 1 : 0) +
    (s.not247 ? -2 : 0) + (c.logo ? 1 : 0) + (s.cors ? 1 : 0);
}

/** Minimal streaming-friendly XMLTV parser for the subset we need. */
export function parseXmltv(xml, wanted, fromMs, toMs) {
  const out = {};
  const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const ch = /channel="([^"]+)"/.exec(attrs)?.[1];
    if (!ch || !wanted.has(ch)) continue;
    const start = xmltvTime(/start="([^"]+)"/.exec(attrs)?.[1]);
    const stop = xmltvTime(/stop="([^"]+)"/.exec(attrs)?.[1]);
    if (!start || !stop || stop < fromMs || start > toMs) continue;
    const body = m[2];
    const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/.exec(body)?.[1] || '');
    const sub = decode(/<sub-title[^>]*>([\s\S]*?)<\/sub-title>/.exec(body)?.[1] || '');
    const desc = decode(/<desc[^>]*>([\s\S]*?)<\/desc>/.exec(body)?.[1] || '');
    (out[ch] ||= []).push({ s: start, e: stop, t: title, st: sub || undefined, d: desc.slice(0, 280) || undefined });
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.s - b.s);
  return out;
}

export function xmltvTime(v) {
  if (!v) return 0;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(v);
  if (!m) return 0;
  const [, Y, Mo, D, h, mi, s = '00', tz = '+0000'] = m;
  const sign = tz[0] === '-' ? -1 : 1;
  const off = sign * (parseInt(tz.slice(1, 3), 10) * 60 + parseInt(tz.slice(3), 10));
  return Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +s) - off * 60000;
}

function decode(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&').trim();
}
