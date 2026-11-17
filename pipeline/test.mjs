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
      feed('F.de', ['deu'], 'Deutsch', true), feed('F.de', ['eng'], 'English', false)],
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
  assert.deepEqual(out, ['BBCNews.uk', 'DW.de', 'AbanteTV.ph', 'CLTV36.ph', 'X.ph']);
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
