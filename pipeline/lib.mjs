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
        languages: [],
        website: ch.website || null,
        logo: logo.get(ch.id)?.url || null,
        streams: [],
      };
      out.set(ch.id, entry);
    }
    for (const l of chLangs) if (!entry.languages.includes(l)) entry.languages.push(l);
    entry.streams.push({
      url: s.url,
      lang: chLangs[0] || undefined,
      quality: s.quality || null,
      source,
      geoBlocked: s.labels.includes('Geo-blocked'),
      not247: s.labels.includes('Not 24/7'),
    });
  }

  for (const e of out.values()) {
    e.streams.sort((a, b) =>
      (a.geoBlocked - b.geoBlocked) || ((a.lang === 'eng' ? 0 : 1) - (b.lang === 'eng' ? 0 : 1)) || (SOURCE_RANK[a.source] - SOURCE_RANK[b.source]) ||
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
    if (cat.id === 'news') { result.push(...list); continue; }
    list.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
    // cap per category *and* language so other languages don't crowd out English (the default)
    const used = {};
    for (const c of list) {
      const lang = primaryLang(c, config);
      const cap = lang === 'eng' || c.country === 'PH' ? config.maxPerCategory : (config.maxPerCategoryOtherLanguage || 15);
      used[lang] = (used[lang] || 0) + 1;
      if (used[lang] <= cap) result.push(c);
    }
  }
  return result;
}

export function primaryLang(c, config) {
  const l = c.languages || [];
  if (l.includes('eng')) return 'eng';
  return l.find((x) => config.languages.includes(x)) || l[0] || 'und';
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
    const cats = [...body.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/g)].map((x) => decode(x[1]).toLowerCase());
    const kind = cats.some((c) => c.includes('movie') || c.includes('film')) ? 'movie' : cats.some((c) => c.includes('series') || c.includes('episode')) ? 'series' : undefined;
    const year = parseInt(/<date>(\d{4})/.exec(body)?.[1] || '', 10) || undefined;
    const ep = /<episode-num system="onscreen">([^<]+)<\/episode-num>/.exec(body)?.[1];
    const genres = [...new Set(cats.map(genreLabel).filter(Boolean))].slice(0, 3);
    if (!title) continue;
    (out[ch] ||= []).push({ s: start, e: stop, t: title, st: sub || undefined, d: desc.slice(0, 280) || undefined, c: kind,
      y: kind === 'movie' ? year : undefined, ep: ep || undefined, g: genres.length ? genres : undefined });
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

export function parseXmltvChannels(xml) {
  const out = [];
  const re = /<channel\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/g;
  let m;
  while ((m = re.exec(xml))) {
    const name = decode(/<display-name[^>]*>([\s\S]*?)<\/display-name>/.exec(m[2])?.[1] || '');
    if (name) out.push({ id: m[1], name });
  }
  return out;
}

/** Channel names: "The Pet Collective HD" and "Pet Collective" compare equal. */
export function normName(s) {
  return fold(s).replace(/\b(the|tv|channel|hd|uhd|4k|network|en|english)\b/g, '').replace(/[^a-z0-9]/g, '');
}

/** Programme titles: drop year and season suffixes, fold accents and punctuation. */
export function normTitle(s) {
  return fold(cleanTitle(s)).replace(/[^a-z0-9]+/g, ' ').trim();
}

export function cleanTitle(t) {
  return String(t || '').replace(/\s*\((19|20)\d\d\)\s*$/, '').replace(/\s*[:\-–]\s*(season|series)\s*\d+.*$/i, '').trim();
}

function fold(s) {
  return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ');
}

const GENERIC = new Set(['series', 'movie', 'movies', 'film', 'episode', 'entertainment', 'tvshow', 'tv show', 'show', 'other', 'unknown', 'general']);
const GENRE_ALIASES = {
  'news & information': 'News', 'children': 'Kids', 'kids & family': 'Kids', 'animated': 'Animation', 'anime series': 'Anime',
  'anime action & adventure': 'Anime', 'science fiction': 'Sci-fi', 'sci-fi & fantasy': 'Sci-fi', 'late night comedies': 'Late-night comedy',
  'home & lifestyle': 'Lifestyle', 'food & cooking': 'Food', 'competition reality': 'Competition', 'human interest': 'Real stories',
  'screwball': 'Comedy', 'sitcom': 'Sitcom', 'sitcoms': 'Sitcom', 'true crime': 'True crime',
};
export function genreLabel(c) {
  const k = String(c || '').trim().toLowerCase();
  if (!k || GENERIC.has(k) || k.length > 28) return null;
  if (GENRE_ALIASES[k]) return GENRE_ALIASES[k];
  return k.replace(/\b\w/g, (x) => x.toUpperCase());
}

const CAT_TAG = {
  animation: 'Animation', kids: 'Kids', comedy: 'Comedy', movies: 'Movies', series: 'Series', classic: 'Classic TV',
  sports: 'Sports', news: 'News', entertainment: 'Entertainment', documentary: 'Documentary', family: 'Family',
  music: 'Music', lifestyle: 'Lifestyle', cooking: 'Food', travel: 'Travel', outdoor: 'Outdoors', science: 'Science',
  business: 'Business', culture: 'Culture', auto: 'Cars', weather: 'Weather', education: 'Learning',
};

/** Short, factual channel description + tags. Uses the platform's own blurb when we have one. */
export function describeChannel(c, programmes = [], meta = null) {
  const genreCount = new Map();
  const titleTime = new Map();
  for (const p of programmes) {
    const mins = (p.e - p.s) / 60000;
    for (const g of p.g || []) genreCount.set(g, (genreCount.get(g) || 0) + mins);
    titleTime.set(p.t, (titleTime.get(p.t) || 0) + mins);
  }
  const topGenres = [...genreCount.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]).slice(0, 3);
  const topTitles = [...titleTime.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]).slice(0, 3);

  const tags = [];
  for (const t of c.tags || []) if (CAT_TAG[t]) tags.push(CAT_TAG[t]);
  for (const g of topGenres) if (!tags.some((t) => t.toLowerCase() === g.toLowerCase())) tags.push(g);
  const s = c.streams?.[0] || {};
  if (s.source === 'fast') tags.push('Free with ads');
  if (s.not247) tags.push('Not 24/7');

  let desc = meta?.desc || '';
  if (!desc) {
    const kind = topGenres.length ? joinWords(topGenres.slice(0, 2).map((g) => g.toLowerCase())) : (CAT_TAG[(c.tags || [])[0]] || 'Live').toLowerCase();
    const where = c.country === 'PH' ? ' from the Philippines' : '';
    desc = cap(kind) + ' channel' + where + '.';
    if (topTitles.length > 1) desc += ' Shows like ' + joinWords(topTitles) + '.';
    else if (topTitles.length === 1 && topTitles[0].toLowerCase() !== c.name.toLowerCase()) desc += ' Mostly ' + topTitles[0] + '.';
  }
  return { desc, tags: [...new Set(tags)].slice(0, 5) };
}

function joinWords(a) { return a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
