// Cast lookup from Wikidata (free, CC0) for movies and shows on the schedule.
// Used for "favorite stars" in the profile. Results are cached between runs.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normTitle, cleanTitle } from './lib.mjs';

const ENDPOINT = 'https://query.wikidata.org/sparql';
const UA = 'WebTVHub/1.0 (https://github.com/francis-h-francisco/web-tv-hub)';
const FILM_TYPES = ['Q11424', 'Q506240', 'Q24862', 'Q202866', 'Q229390'];
const SERIES_TYPES = ['Q5398426', 'Q581714', 'Q1259759', 'Q117467246', 'Q63952888', 'Q15416', 'Q526877'];
const TYPES = [...FILM_TYPES, ...SERIES_TYPES];
const CACHE_DAYS = 30;

export async function buildPeople(epg, { cachePath, maxTitles = 2500, batch = 60, castPerTitle = 8 }, log) {
  // unique titles on the schedule, with a year when the listing has one
  const titles = new Map();
  for (const list of Object.values(epg)) {
    for (const p of list) {
      const k = normTitle(p.t);
      if (!k || k.length < 2) continue;
      const cur = titles.get(k) || { label: cleanTitle(p.t), years: new Set(), movie: false, series: false };
      if (p.y) cur.years.add(p.y);
      if (p.c === 'movie') cur.movie = true;
      if (p.c === 'series') cur.series = true;
      titles.set(k, cur);
    }
  }

  let cache = {};
  try { cache = JSON.parse(await readFile(cachePath, 'utf8')); } catch { /* first run */ }
  const fresh = (e) => e && Date.now() - e.at < CACHE_DAYS * 86400e3;
  const todo = [...titles.entries()].filter(([k]) => !fresh(cache[k])).slice(0, maxTitles);
  log(`people: ${titles.size} titles on schedule, ${todo.length} to look up`);

  for (let i = 0; i < todo.length; i += batch) {
    const chunk = todo.slice(i, i + batch);
    try {
      let rows;
      try { rows = await query(chunk.map(([, v]) => v.label)); }
      catch (e) {
        // big batches can hit the 60 s public-endpoint limit: retry in halves
        const half = Math.ceil(chunk.length / 2);
        await sleep(3000);
        rows = [...await query(chunk.slice(0, half).map(([, v]) => v.label)), ...await query(chunk.slice(half).map(([, v]) => v.label))];
      }
      const byLabel = new Map();
      for (const r of rows) {
        const k = normTitle(r.label);
        const list = byLabel.get(k) || [];
        list.push(r);
        byLabel.set(k, list);
      }
      for (const [k, v] of chunk) {
        const found = byLabel.get(k) || [];
        // Disambiguate same-named works: match the listing's kind (movie/series) and year,
        // then prefer the best-known work (most Wikipedia language editions).
        const works = new Map();
        for (const r of found) {
          const w = works.get(r.item) || { year: r.year, film: false, series: false, links: r.links, cast: new Map() };
          if (FILM_TYPES.includes(r.type)) w.film = true;
          if (SERIES_TYPES.includes(r.type)) w.series = true;
          if (r.cast) w.cast.set(r.cast, Math.max(w.cast.get(r.cast) || 0, r.castLinks));
          works.set(r.item, w);
        }
        let best = null;
        for (const w of works.values()) {
          if (v.movie && !v.series && !w.film) continue;
          if (v.series && !v.movie && !w.series) continue;
          if (!v.movie && !v.series && !w.series && !w.film) continue;
          if (v.movie && v.years.size && !(w.year && [...v.years].some((y) => Math.abs(w.year - y) <= 1))) continue;
          const score = w.links + (w.series && !v.movie ? 5 : 0);
          if (!best || score > best.score) best = { ...w, score };
        }
        const cast = best ? [...best.cast.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]) : [];
        cache[k] = { at: Date.now(), cast: cast.slice(0, castPerTitle) };
      }
    } catch (e) {
      log(`people: batch ${i / batch} failed: ${e.message}`);
      await sleep(5000);
    }
    await sleep(1200); // be polite to the public endpoint
  }

  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(cache));

  const out = {};
  let withCast = 0;
  for (const k of titles.keys()) {
    const c = cache[k];
    if (c && c.cast.length) { out[k] = c.cast; withCast++; }
  }
  log(`people: cast found for ${withCast} titles`);
  return out;
}

async function query(labels) {
  const values = labels.map((l) => JSON.stringify(l) + '@en').join(' ');
  const sparql = `SELECT ?item ?label ?type ?links ?year ?castLabel ?castLinks WHERE {
  VALUES ?label { ${values} }
  ?item rdfs:label ?label .
  VALUES ?type { ${TYPES.map((t) => 'wd:' + t).join(' ')} }
  ?item wdt:P31 ?type ; wikibase:sitelinks ?links .
  OPTIONAL { ?item wdt:P577 ?date . BIND(YEAR(?date) AS ?year) }
  OPTIONAL { ?item wdt:P161 ?cast . ?cast rdfs:label ?castLabel ; wikibase:sitelinks ?castLinks . FILTER(LANG(?castLabel) = "en") }
}`;
  const r = await fetch(ENDPOINT + '?query=' + encodeURIComponent(sparql), {
    headers: { Accept: 'application/sparql-results+json', 'User-Agent': UA },
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  return j.results.bindings.map((b) => ({
    item: b.item.value,
    label: b.label.value,
    type: b.type.value.split('/').pop(),
    links: b.links ? parseInt(b.links.value, 10) : 0,
    year: b.year ? parseInt(b.year.value, 10) : null,
    cast: b.castLabel ? b.castLabel.value : null,
    castLinks: b.castLinks ? parseInt(b.castLinks.value, 10) : 0,
  }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
