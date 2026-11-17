import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifySource, curate, applyCaps, parseXmltv, xmltvTime, regDomain } from './lib.mjs';

const config = JSON.parse(await readFile(new URL('../config/curation.json', import.meta.url), 'utf8'));
const P = config.sourcePolicy;

test('regDomain handles 2-level suffixes', () => {
  assert.equal(regDomain('live.abs-cbn.com.ph'), 'abs-cbn.com.ph');
  assert.equal(regDomain('a.b.example.com'), 'example.com');
});

test('source policy', () => {
  assert.equal(classifySource('https://x.amagi.tv/p.m3u8', null, P), 'trusted');
  assert.equal(classifySource('https://jmp2.uk/plu-abc.m3u8', null, P), 'fast');
  assert.equal(classifySource('https://cdn.tangotv.in/a.m3u8', null, P), 'denied');
  assert.equal(classifySource('https://live.example.org/a.m3u8', 'https://www.example.org/', P), 'website');
  assert.equal(classifySource('https://random-host.xyz/a.m3u8', null, P), 'unknown');
});

const ch = (id, cats, extra = {}) => ({ id, name: id, country: 'US', categories: cats, is_nsfw: false, closed: null, website: null, ...extra });
const st = (channel, url, extra = {}) => ({ channel, feed: null, url, quality: '720p', labels: [], user_agent: null, referrer: null, ...extra });
const feed = (channel, langs, id = 'SD', is_main = true) => ({ channel, id, is_main, languages: langs });

test('curate filters and categorizes', () => {
  const data = {
    channels: [ch('A.us', ['movies']), ch('B.us', ['religious', 'movies']), ch('C.us', ['comedy']), ch('D.us', ['news']), ch('E.us', ['xxx'], { is_nsfw: true }), ch('F.de', ['news'])],
    streams: [
      st('A.us', 'https://x.amagi.tv/a.m3u8'),
      st('B.us', 'https://x.amagi.tv/b.m3u8'),
      st('C.us', 'http://x.amagi.tv/c.m3u8'),
      st('D.us', 'https://cdn.tangotv.in/d.m3u8'),
      st('E.us', 'https://x.amagi.tv/e.m3u8'),
      st('F.de', 'https://x.akamaized.net/de.m3u8', { feed: 'Deutsch' }),
      st('F.de', 'https://x.akamaized.net/en.m3u8', { feed: 'English' }),
    ],
    feeds: [feed('A.us', ['eng']), feed('B.us', ['eng']), feed('C.us', ['eng']), feed('D.us', ['eng']), feed('E.us', ['eng']),
      feed('F.de', ['xxx'], 'Deutsch', true), feed('F.de', ['eng'], 'English', false)],
    blocklist: [], logos: [],
  };
  const { candidates } = curate(data, config);
  const ids = candidates.map((c) => c.id).sort();
  assert.deepEqual(ids, ['A.us', 'F.de']);
  assert.equal(candidates.find((c) => c.id === 'A.us').category, 'movies');
  const f = candidates.find((c) => c.id === 'F.de');
  assert.equal(f.streams.length, 1);
  assert.match(f.streams[0].url, /en\.m3u8/);
});

test('news caps', () => {
  const mk = (id, country) => ({ id, name: id, country, category: 'news', streams: [{}] });
  const list = [mk('BBCNews.uk', 'GB'), mk('DW.de', 'DE'), mk('CNN.us', 'US'), mk('AbanteTV.ph', 'PH'), mk('CLTV36.ph', 'PH'), mk('X.ph', 'PH'), mk('Y.ph', 'PH')];
  const out = applyCaps(list, config).map((c) => c.id);
  // international for everyone + up to 3 local news channels per country (the app shows the viewer's own)
  assert.deepEqual(out, ['BBCNews.uk', 'DW.de', 'CNN.us', 'AbanteTV.ph', 'CLTV36.ph', 'X.ph']);
});

test('xmltv parsing', () => {
  assert.equal(xmltvTime('20261117023200 +0000'), Date.UTC(2026, 10, 17, 2, 32));
  assert.equal(xmltvTime('20261117103200 +0800'), Date.UTC(2026, 10, 17, 2, 32));
  const xml = `<tv><programme channel="a" start="20261117020000 +0000" stop="20261117030000 +0000"><title>Hi &amp; Bye</title><desc>D</desc></programme>
  <programme channel="b" start="20261117020000 +0000" stop="20261117030000 +0000"><title>No</title></programme></tv>`;
  const r = parseXmltv(xml, new Set(['a']), 0, Infinity);
  assert.deepEqual(Object.keys(r), ['a']);
  assert.equal(r.a[0].t, 'Hi & Bye');
});

import { describeChannel, normTitle, genreLabel } from './lib.mjs';
test('channel description and tags', () => {
  const c = { name: 'Retro TV', country: 'US', tags: ['comedy'], streams: [{ source: 'fast' }] };
  const H = 3600e3;
  const progs = [
    { s: 0, e: 2 * H, t: 'Frasier', g: ['Comedy', 'Sitcom'] },
    { s: 2 * H, e: 3 * H, t: 'Wings', g: ['Comedy'] },
    { s: 3 * H, e: 3.5 * H, t: 'Becker', g: ['Sitcom'] },
  ];
  const d = describeChannel(c, progs, null);
  assert.equal(d.desc, 'Comedy and sitcom channel. Shows like Frasier, Wings and Becker.');
  assert.deepEqual(d.tags, ['Comedy', 'Sitcom', 'Free with ads']);
  assert.equal(describeChannel(c, progs, { desc: 'Official blurb.' }).desc, 'Official blurb.');
});
test('title normalization and genres', () => {
  assert.equal(normTitle('Star Trek: The Next Generation (1987)'), 'star trek the next generation');
  assert.equal(normTitle('Pokémon: Season 3'), 'pokemon');
  assert.equal(genreLabel('Science fiction'), 'Sci-fi');
  assert.equal(genreLabel('Series'), null);
});

import { guessLang, primaryLang } from './lib.mjs';
test('language guess from schedule text', () => {
  const en = Array.from({ length: 10 }, () => ({ t: 'The Big Show', d: 'A man and his dog travel to the coast with their friends in this story of the sea.' }));
  const es = Array.from({ length: 10 }, () => ({ t: 'El Gran Show', d: 'Un hombre y su perro viajan a la costa con los amigos para una historia del mar que es como ninguna.' }));
  assert.equal(guessLang(en), 'eng');
  assert.equal(guessLang(es), 'spa');
  assert.equal(guessLang([{ t: 'News' }]), null);
});
test('primary language is the main audio track', () => {
  assert.equal(primaryLang({ streams: [{ lang: 'hin' }], languages: ['hin', 'eng'] }), 'hin');
});

import { SHARE_JS, slug } from './share.mjs';
import vm from 'node:vm';
test('share page script is valid JavaScript', () => {
  assert.doesNotThrow(() => new vm.Script(SHARE_JS));
  assert.equal(slug('Foo Bar.us'), 'Foo_Bar.us');
});

test('share pages carry previews and valid structured data', async () => {
  const { buildShare } = await import('./share.mjs');
  const { mkdtemp, readFile: rf } = await import('node:fs/promises');
  const dir = await mkdtemp('/tmp/wth-share-');
  const now = Date.now();
  const chans = [{ id: 'Test.us', name: 'Test <TV>', category: 'series', lang: 'eng', desc: 'A "test" channel', logo: null }];
  const epg = { 'Test.us': [{ s: now - 6e5, e: now + 6e5, t: 'Show & Tell', d: 'Episode </script> one' }] };
  await buildShare(chans, epg, [{ id: 'series', name: 'TV Series' }], { outDir: dir, siteUrl: 'https://x.test/' }, () => {});
  const ch = await rf(`${dir}/s/Test.us.html`, 'utf8');
  const show = await rf(`${dir}/s/Test.us/${Math.round((now - 6e5) / 60000)}.html`, 'utf8');
  for (const page of [ch, show]) {
    assert.match(page, /og:image" content="https:\/\/x\.test\//);
    const json = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(page);
    assert.ok(json, 'has JSON-LD'); JSON.parse(json[1]);
  }
  assert.match(show, /"@type":"BroadcastEvent"/);
  assert.match(show, /og:image" content="https:\/\/x\.test\/s\/Test\.us\/show-tell\.jpg"/);
  assert.match(await rf(`${dir}/sitemap.xml`, 'utf8'), /<loc>https:\/\/x\.test\/s\/Test\.us\.html<\/loc>/);
});
