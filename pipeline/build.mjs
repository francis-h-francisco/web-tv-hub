#!/usr/bin/env node
// 6-hourly refresh: iptv-org -> curate -> health-check (playlist + variant + segment) -> guides -> cast -> site/data
// Usage: node pipeline/build.mjs [--out site/data] [--limit N] [--skip-health] [--skip-epg] [--skip-people]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { curate, applyCaps, describeChannel, primaryLang } from './lib.mjs';
import { makeChecker } from './health.mjs';
import { buildEpg } from './epg.mjs';
import { buildPeople } from './people.mjs';

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

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

log('fetching iptv-org api');
const [channels, streams, feeds, blocklist, logos] = await Promise.all(
  ['channels', 'streams', 'feeds', 'blocklist', 'logos'].map(getJson));
let { candidates, stats } = curate({ channels, streams, feeds, blocklist, logos }, config);
log(`candidates: ${candidates.length} channels`, JSON.stringify(stats.excluded));
if (LIMIT) candidates = candidates.slice(0, LIMIT);

const health = { checked: 0, ok: 0, fail: {} };
if (!flag('--skip-health')) {
  const check = makeChecker({ siteOrigin: config.siteOrigin, timeoutMs: config.health.timeoutMs });
  await pool(candidates, config.health.concurrency, async (c) => {
    const kept = [];
    for (const s of c.streams.slice(0, config.health.maxStreamsTriedPerChannel)) {
      health.checked++;
      let r = await check(s.url);
      // one retry for transient errors so a single hiccup doesn't drop a channel for 6 hours
      if (!r.ok && (r.why === 'timeout' || r.why === 'network' || r.why.endsWith('_503'))) r = await check(s.url);
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

let epg = {}, via = {}, meta = {};
if (!flag('--skip-epg')) ({ epg, via, meta } = await buildEpg(final, config.epg, log));
log(`epg: ${Object.keys(epg).length}/${final.length} channels with a guide`);

let people = {};
if (!flag('--skip-epg') && !flag('--skip-people') && config.people?.enabled) {
  people = await buildPeople(epg, { cachePath: new URL('../.cache/people.json', import.meta.url).pathname, ...config.people }, log);
}

const generated = new Date().toISOString();
const categories = config.categoryMap.map(({ id, name }) => ({ id, name }));
const outChannels = final.map((c) => {
  const { desc, tags } = describeChannel(c, epg[c.id], meta[c.id]);
  const { tags: _src, ...rest } = c;
  const lang = primaryLang(c, config);
  return { ...rest, lang, desc, labels: tags, hasEpg: !!epg[c.id], guide: via[c.id] || null };
});
await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/channels.json`, JSON.stringify({ generated, categories, channels: outChannels }));
// guide split by language so a viewer only downloads the languages they watch
await mkdir(`${OUT}/epg`, { recursive: true });
const epgByLang = {};
for (const c of outChannels) if (epg[c.id]) (epgByLang[c.lang] ||= {})[c.id] = epg[c.id];
for (const [lang, part] of Object.entries(epgByLang)) await writeFile(`${OUT}/epg/${lang}.json`, JSON.stringify({ generated, epg: part }));
await writeFile(`${OUT}/people.json`, JSON.stringify({ generated, cast: people }));
await writeFile(`${OUT}/where-to-watch.json`, JSON.stringify(config.whereToWatch));
const byCat = Object.fromEntries(categories.map((c) => [c.name, outChannels.filter((x) => x.category === c.id).length]));
const guides = {};
for (const v of Object.values(via)) guides[v] = (guides[v] || 0) + 1;
await writeFile(`${OUT}/report.json`, JSON.stringify({ generated, excluded: stats.excluded, health, byCategory: byCat, epgChannels: Object.keys(epg).length, guides, castTitles: Object.keys(people).length }, null, 2));
log('done', JSON.stringify(byCat));
