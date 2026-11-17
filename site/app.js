/* Web TV Hub — lean-back live TV for TVs, remotes and phones. No build step, no framework. */
(function () {
  'use strict';

  // ---------------------------------------------------------------- storage
  // Everything personal stays in this browser.
  const LS = 'wth.';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) { /* full or blocked */ } },
  };

  const FREE_REMINDERS = 3;
  const UNAVAILABLE_TTL = 12 * 3600e3;   // hidden channels get another chance after 12 h
  const PROBE_TTL = 6 * 3600e3;          // re-check a working channel every 6 h
  const START_TIMEOUT = 15000;
  const LANG_NAMES = {
    eng: 'English', fil: 'Filipino', tgl: 'Filipino', spa: 'Spanish', por: 'Portuguese', fra: 'French', fre: 'French',
    deu: 'German', ger: 'German', ita: 'Italian', hin: 'Hindi', ara: 'Arabic', jpn: 'Japanese', kor: 'Korean', zho: 'Chinese',
    cmn: 'Chinese', ind: 'Indonesian', msa: 'Malay', vie: 'Vietnamese', tha: 'Thai', rus: 'Russian', tam: 'Tamil', kur: 'Kurdish',
  };
  const langName = (l) => LANG_NAMES[l] || l;
  const langKey = (l) => (l === 'tgl' ? 'fil' : l === 'fre' ? 'fra' : l === 'ger' ? 'deu' : l === 'cmn' ? 'zho' : l);
  const INTERESTS = {
    'Action': ['action', 'thriller', 'adventure'], 'Comedy': ['comedy', 'sitcom', 'funny'], 'Crime & mystery': ['crime', 'mystery', 'detective', 'true crime'],
    'Reality & competition': ['reality', 'competition', 'game show'], 'Anime': ['anime'], 'Cartoons & kids': ['kids', 'animation', 'cartoon'],
    'Documentary & history': ['documentary', 'history', 'nature', 'science', 'real stories'], 'Motorsport': ['racing', 'motor', 'f1', 'rally', 'nascar'],
    'Combat sports': ['mma', 'boxing', 'fight', 'combat', 'wrestling'], 'Football': ['football', 'soccer', 'fifa'], 'Basketball': ['basketball', 'nba'],
    'Sci-fi': ['sci-fi', 'star trek', 'space'], 'Westerns': ['western'], 'Food & travel': ['food', 'cooking', 'travel'],
  };

  // ---------------------------------------------------------------- state
  const S = {
    all: [], byId: new Map(), categories: [], epg: {}, epgLoaded: new Set(), cast: {}, wtw: [],
    current: null, list: [], tab: store.get('tab', null), hls: null, attempts: [], attempt: 0, userPick: false,
    favs: new Set(store.get('favs', [])),
    reminders: store.get('reminders', []),
    profile: store.get('profile', null),
    unavail: store.get('unavail', {}),
    probes: store.get('probes', {}),
    byo: store.get('byo', null),
    interacted: false,
  };
  S.langs = (S.profile && S.profile.langs && S.profile.langs.length) ? S.profile.langs : ['eng'];

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const mins = (ms) => Math.max(1, Math.round(ms / 60000));
  const inMins = (ms) => { const m = mins(ms); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : ''); };
  const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"'));
  const isMobile = () => window.matchMedia('(max-width: 900px)').matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const video = $('#video');
  const NATIVE_HLS = !!video.canPlayType('application/vnd.apple.mpegurl');
  const HLSJS = !!(window.Hls && window.Hls.isSupported());
  // Streams without CORS (most Pluto TV redirects) only play in a device's own HLS player. Desktop Chrome/Edge/
  // Firefox can't handle their separate audio tracks, so built-in HLS is trusted only on Safari, Android, webOS, Tizen, Fire TV.
  const UA = navigator.userAgent;
  const NATIVE_RELIABLE = NATIVE_HLS && (/Android|iPhone|iPad|Web0S|webOS|Tizen|SMART-TV|AFT|CrKey/i.test(UA) ||
    (/Macintosh/.test(UA) && /Safari/.test(UA) && !/Chrome|Chromium|Edg|Firefox/.test(UA)));

  // ---------------------------------------------------------------- text matching (typo-tolerant)
  function fold(s) {
    return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function cleanTitle(t) { return String(t || '').replace(/\s*\((19|20)\d\d\)\s*$/, '').replace(/\s*[:\-–]\s*(season|series)\s*\d+.*$/i, '').trim(); }
  const normTitle = (t) => fold(cleanTitle(t));
  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    let prev2 = null, prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1); // swapped letters
      }
      prev2 = prev.slice(); const t = prev; prev = cur; cur = t;
    }
    return prev[n];
  }
  /** 0..1 similarity between a typed query and a candidate (both folded). */
  function similarity(q, c) {
    if (!q || !c) return 0;
    if (q === c) return 1;
    if (c.startsWith(q)) return 0.97 - Math.min(0.15, (c.length - q.length) * 0.004);
    if ((' ' + c).includes(' ' + q)) return 0.9;
    const qt = q.split(' '), ct = c.split(' ');
    let total = 0, weight = 0;
    for (const t of qt) {
      let best = 0;
      for (const u of ct) {
        let s = 1 - lev(t, u) / Math.max(t.length, u.length);
        if (t.length >= 3 && u.startsWith(t)) s = Math.max(s, 0.92);
        if (s > best) best = s;
      }
      total += best * t.length; weight += t.length;
    }
    let score = weight ? total / weight : 0;
    if (ct.length > qt.length) score *= 0.85 + 0.15 * qt.length / ct.length;
    return score;
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    tickClock(); setInterval(tickClock, 15000);
    try {
      const [c, w, p] = await Promise.all([
        fetch('data/channels.json').then((r) => r.json()),
        fetch('data/where-to-watch.json').then((r) => r.json()).catch(() => []),
        fetch('data/people.json').then((r) => r.json()).catch(() => ({ cast: {} })),
      ]);
      S.categories = c.categories; S.wtw = w; S.cast = p.cast || {}; S.generated = c.generated;
      S.raw = c.channels;
      S.all = c.channels.filter(playable);
      S.hiddenForBrowser = c.channels.length - S.all.length;
      S.all.forEach((ch) => S.byId.set(ch.id, ch));
      if (S.byo) S.byo.channels.forEach((ch) => { ch.category = 'byo'; S.byId.set(ch.id, ch); });
    } catch (err) {
      $('#nowName').textContent = 'Could not load channels';
      $('#nowMeta').textContent = 'Check your connection and reload.';
      return;
    }
    await loadEpgFor(neededLangs());
    pruneExpired();
    renderTabs(); renderGuide();
    const want = new URLSearchParams(location.search).get('ch') || store.get('last', null);
    const wantCh = want && S.byId.get(want);
    const startCh = (wantCh && isVisible(wantCh)) ? wantCh : (forYou()[0] || bestStart());
    if (startCh) play(startCh, { list: tabList() });
    setInterval(() => { renderTimeline(); refreshGuideTimes(); }, 30000);
    setInterval(checkReminders, 20000); checkReminders();
    setTimeout(announcePicks, 4000);
    if (!S.profile) setTimeout(openProfile, 700); else focusGuide();
    registerSW();
  }

  // first-time start: a channel already confirmed working here, with a schedule, playable in the web player
  function bestStart() {
    const score = (c) => ((S.probes[c.id] || {}).ok ? 4 : 0) + (c.hasEpg ? 3 : 0) + (c.streams.some((s) => s.cors) ? 2 : 0) + (c.lang === 'eng' ? 1 : 0) - (c.streams[0] && c.streams[0].not247 ? 3 : 0);
    const v = visible().filter((c) => c.category !== 'news');
    return v.slice().sort((a, b) => score(b) - score(a))[0] || visible()[0];
  }
  function tickClock() { $('#clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

  function neededLangs() {
    const s = new Set(S.langs.map(langKey));
    if (s.has('fil')) s.add('tgl');
    // Philippine channels stay available when the viewer wants local channels
    if (!S.profile || S.profile.ph !== false) S.all.filter((c) => c.country === 'PH').forEach((c) => s.add(c.lang));
    return [...s];
  }
  async function loadEpgFor(langs) {
    const files = new Set(S.all.filter((c) => langs.includes(c.lang) || langs.includes(langKey(c.lang))).map((c) => c.lang));
    await Promise.all([...files].filter((l) => !S.epgLoaded.has(l)).map(async (l) => {
      S.epgLoaded.add(l);
      try { const j = await fetch('data/epg/' + encodeURIComponent(l) + '.json').then((r) => r.json()); Object.assign(S.epg, j.epg); } catch (e) { S.epgLoaded.delete(l); }
    }));
  }

  // ---------------------------------------------------------------- availability
  function playable(ch) { return plan(ch).length > 0; }
  function isUnavailable(ch) { const t = S.unavail[ch.id]; return !!t && t > Date.now(); }
  function langOk(ch) {
    if (ch.category === 'byo') return true;
    if (ch.country === 'PH' && (!S.profile || S.profile.ph !== false)) return true;
    const want = new Set(S.langs.map(langKey));
    return (ch.languages && ch.languages.length ? ch.languages : [ch.lang]).some((l) => want.has(langKey(l)));
  }
  function isVisible(ch) { return !isUnavailable(ch) && langOk(ch); }
  function visible() { return S.all.filter(isVisible); }
  function pruneExpired() {
    const now = Date.now(); let changed = false;
    for (const k in S.unavail) if (S.unavail[k] < now) { delete S.unavail[k]; changed = true; }
    for (const k in S.probes) if (S.probes[k].at + PROBE_TTL < now) { delete S.probes[k]; changed = true; }
    if (changed) { store.set('unavail', S.unavail); store.set('probes', S.probes); }
  }

  /** Remove a channel from every list the moment we know it can't play here. */
  function markUnavailable(ch, reason) {
    if (!ch || ch.category === 'byo') return;
    S.unavail[ch.id] = Date.now() + UNAVAILABLE_TTL; store.set('unavail', S.unavail);
    suggestIndex = null;
    const row = $('.row[data-ch="' + cssEsc(ch.id) + '"]');
    const hadFocus = !!row && row === document.activeElement;
    const sib = row && (row.nextElementSibling || row.previousElementSibling);
    const rerender = () => { renderTabs(); renderGuide(); if (hadFocus && sib && sib.dataset) focusRow(sib.dataset.ch); };
    if (row) { row.classList.add('gone'); setTimeout(rerender, 300); } else renderTabs();
    if (reason !== 'probe') return;
    S.hiddenCount = (S.hiddenCount || 0) + 1;
    clearTimeout(S.hideToastT);
    S.hideToastT = setTimeout(() => { toast('Hid ' + S.hiddenCount + ' channel' + (S.hiddenCount > 1 ? 's' : '') + " that aren't available where you are right now.", null, 5000, 'hidden'); S.hiddenCount = 0; }, 2500);
  }

  // Background check from the viewer's own network (catches region locks), two channels at a time.
  function startProber() {
    if (S.proberStarted) return; S.proberStarted = true;
    const queue = () => {
      const tabIds = new Set(tabList().map((c) => c.id));
      return visible().filter((c) => c !== S.current && !S.probes[c.id] && c.streams.some((s) => s.cors))
        .sort((a, b) => (tabIds.has(b.id) ? 1 : 0) - (tabIds.has(a.id) ? 1 : 0));
    };
    const busy = new Set();
    const worker = async () => {
      for (;;) {
        if (document.hidden) { await sleep(5000); continue; }
        const next = queue().find((c) => !busy.has(c.id));
        if (!next) return;
        busy.add(next.id);
        const ok = await probe(next);
        S.probes[next.id] = { ok, at: Date.now() }; store.set('probes', S.probes);
        if (!ok) markUnavailable(next, 'probe');
        await sleep(400);
      }
    };
    worker(); worker();
  }
  async function probe(ch) {
    const s = ch.streams.find((x) => x.cors); if (!s) return true;
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 9000);
    const first = (txt) => txt.split(/\r?\n/).map((l) => l.trim()).find((l) => l && l[0] !== '#');
    try {
      let r = await fetch(s.url, { signal: ctrl.signal, cache: 'no-store' }); if (!r.ok) return false;
      let txt = await r.text(); let base = r.url;
      if (txt.includes('#EXT-X-STREAM-INF')) {
        const v = first(txt); if (!v) return false;
        r = await fetch(new URL(v, base).href, { signal: ctrl.signal, cache: 'no-store' }); if (!r.ok) return false;
        txt = await r.text(); base = r.url;
      }
      const seg = first(txt); if (!seg) return false;
      r = await fetch(new URL(seg, base).href, { signal: ctrl.signal, headers: { Range: 'bytes=0-1023' }, cache: 'no-store' });
      return r.ok || r.status === 206;
    } catch (e) {
      // a timeout on a slow connection is not proof the channel is gone
      return e.name === 'AbortError';
    } finally { clearTimeout(t); }
  }

  // ---------------------------------------------------------------- guide data helpers
  function progs(ch) { return (ch && S.epg[ch.id]) || []; }
  function nowIndex(list, t) { t = t || Date.now(); return list.findIndex((p) => p.s <= t && p.e > t); }
  function nowProg(ch) { const l = progs(ch); const i = nowIndex(l); return i >= 0 ? l[i] : null; }
  function nextProg(ch) { const l = progs(ch); const i = nowIndex(l); return i >= 0 ? l[i + 1] : l.find((p) => p.s > Date.now()); }

  // ---------------------------------------------------------------- picks: favorite shows, movies, stars
  let suggestIndex = null;
  function buildSuggestIndex() {
    const titles = new Map(); const people = new Map();
    // every show on the schedule in the viewer's languages, even on channels this browser can't play,
    // so suggestions recognise "Frasier" anywhere; My TV then says where it can actually be watched
    const rawById = new Map((S.raw || []).map((c) => [c.id, c]));
    for (const [cid, list] of Object.entries(S.epg)) {
      const ch = rawById.get(cid) || S.byId.get(cid); if (!ch || !langOk(ch)) continue;
      for (const p of list) {
        if (p.e < Date.now()) continue;
        const k = normTitle(p.t); if (!k || k.length < 2) continue;
        const e = titles.get(k) || { type: 'title', label: cleanTitle(p.t), key: k, n: 0, kind: p.c };
        e.n++; titles.set(k, e);
      }
    }
    for (const [k, cast] of Object.entries(S.cast)) {
      if (!titles.has(k)) continue;
      for (const name of cast) {
        const pk = fold(name);
        const e = people.get(pk) || { type: 'person', label: name, key: pk, n: 0, titles: [] };
        e.n++; e.titles.push(k); people.set(pk, e);
      }
    }
    const chans = visible().map((c) => ({ type: 'channel', label: c.name, key: fold(c.name), n: 1, id: c.id }));
    suggestIndex = [...titles.values(), ...people.values(), ...chans];
  }
  function suggest(q, limit) {
    if (!suggestIndex) buildSuggestIndex();
    const f = fold(q); if (f.length < 2) return [];
    const out = [];
    for (const e of suggestIndex) {
      const s = similarity(f, e.key);
      if (s >= 0.62) out.push({ e, s: s + Math.min(0.05, e.n * 0.002) + (e.type === 'person' ? 0.01 : 0) });
    }
    return out.sort((a, b) => b.s - a.s).slice(0, limit || 6);
  }
  function picks() { return (S.profile && S.profile.picks) || []; }
  function titleKeysFor(pick) {
    if (pick.type === 'title') return new Set([pick.key]);
    if (pick.type === 'person') {
      const s = new Set();
      for (const [k, cast] of Object.entries(S.cast)) if (cast.some((n) => fold(n) === pick.key)) s.add(k);
      return s;
    }
    return null;
  }
  /** Programmes in the next 24 h that match the viewer's picks. */
  function picksOnAir() {
    const now = Date.now(), until = now + 24 * 3600e3, out = [], seen = new Set();
    for (const pick of picks()) {
      const keys = titleKeysFor(pick);
      for (const [cid, list] of Object.entries(S.epg)) {
        const ch = S.byId.get(cid); if (!ch || !isVisible(ch)) continue;
        for (const p of list) {
          if (p.e <= now || p.s > until) continue;
          let hit = false;
          if (pick.type === 'channel') hit = pick.id === cid && p.s <= now;
          else if (keys) hit = keys.has(normTitle(p.t)) || (pick.type === 'title' && similarity(pick.key, normTitle(p.t)) >= 0.93);
          else hit = similarity(fold(pick.q), normTitle(p.t)) >= 0.85;
          if (hit && !seen.has(cid + p.s)) { seen.add(cid + p.s); out.push({ ch, p, pick }); }
        }
      }
    }
    return out.sort((a, b) => a.p.s - b.p.s);
  }
  function announcePicks() {
    const live = picksOnAir().filter((x) => x.p.s <= Date.now());
    if (!live.length || (S.current && live.some((x) => x.ch === S.current))) return;
    const x = live[0];
    toast('<b>' + esc(x.p.t) + '</b> is on now on ' + esc(x.ch.name) + '.', { label: 'Watch now', fn: () => play(x.ch, { list: tabList(), user: true }) }, 12000);
  }

  // ---------------------------------------------------------------- personalization
  function textOf(ch) {
    const p = progs(ch).filter((x) => x.e > Date.now()).slice(0, 4).map((x) => x.t + ' ' + (x.g || []).join(' ')).join(' ');
    return (ch.name + ' ' + (ch.labels || []).join(' ') + ' ' + p).toLowerCase();
  }
  function scoreFor(ch, pickChannels) {
    const P = S.profile;
    let s = S.favs.has(ch.id) ? 5 : 0;
    if (pickChannels && pickChannels.has(ch.id)) s += pickChannels.get(ch.id);
    if (!P || P.skipped) return s;
    s += ((P.cats || {})[ch.category] || 0) * 3;
    if (P.ph && ch.country === 'PH') s += 3;
    const txt = textOf(ch);
    for (const name of P.interests || []) for (const kw of INTERESTS[name] || []) if (txt.includes(kw)) { s += 2; break; }
    if ((P.eras || []).includes('classic') && /classic|retro|vintage|oldies/.test(txt)) s += 1.5;
    if (ch.hasEpg) s += 0.5;
    return s;
  }
  function forYou() {
    if (!S.profile || S.profile.skipped) return [];
    const pc = new Map();
    for (const x of picksOnAir()) {
      const w = x.p.s <= Date.now() ? 8 : x.p.s - Date.now() < 3 * 3600e3 ? 4 : 1;
      pc.set(x.ch.id, Math.max(pc.get(x.ch.id) || 0, w));
    }
    return visible().map((c) => [scoreFor(c, pc), c]).filter((x) => x[0] > 0.5).sort((a, b) => b[0] - a[0]).slice(0, 40).map((x) => x[1]);
  }

  // ---------------------------------------------------------------- tabs + guide
  function tabs() {
    const v = visible(); const t = [];
    const fy = forYou(); if (fy.length) t.push({ id: 'foryou', name: 'For you', list: fy });
    const favs = v.filter((c) => S.favs.has(c.id)); if (favs.length) t.push({ id: 'favs', name: '★ Favorites', list: favs });
    const order = ['series', 'movies', 'sitcoms', 'animations', 'sports', 'news'];
    const cats = S.categories.slice().sort((a, b) => (order.indexOf(a.id) + 99) % 99 - (order.indexOf(b.id) + 99) % 99);
    for (const cat of cats) {
      // channels with a schedule first, so the guide reads like a TV guide
      const l = v.filter((c) => c.category === cat.id).sort((a, b) => (b.hasEpg ? 1 : 0) - (a.hasEpg ? 1 : 0));
      if (l.length) t.push({ id: cat.id, name: cat.name, list: l });
    }
    if (S.byo && S.byo.channels.length) t.push({ id: 'byo', name: 'My playlist', list: S.byo.channels });
    return t;
  }
  function tabList() { const t = tabs(); const cur = t.find((x) => x.id === S.tab) || t[0]; return cur ? cur.list : []; }
  function renderTabs() {
    const t = tabs();
    if (!t.find((x) => x.id === S.tab)) S.tab = t[0] ? t[0].id : null;
    const langLabel = S.langs.map((l) => langName(l)).slice(0, 2).join(', ') + (S.langs.length > 2 ? ' +' + (S.langs.length - 2) : '');
    $('#tabs').innerHTML = t.map((x) => '<button class="tab' + (x.id === S.tab ? ' on' : '') + '" role="tab" data-focus data-tab="' + x.id + '">' + esc(x.name) + '<small>' + x.list.length + '</small></button>').join('') +
      '<button class="tab lang" data-focus data-action="langs">🌐 ' + esc(langLabel) + '</button>';
  }
  function setTab(id, keepFocus) {
    if (S.tab === id) return;
    S.tab = id; store.set('tab', id); renderTabs(); renderGuide();
    $('#guide').scrollTop = 0;
    if (keepFocus) focusEl($('.tab[data-tab="' + cssEsc(id) + '"]'));
  }

  function rowHtml(c) {
    const np = nowProg(c), nx = nextProg(c), t = Date.now();
    const initials = esc(c.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3));
    const playing = S.current && S.current.id === c.id;
    let now;
    if (np) {
      const pct = Math.min(100, ((t - np.s) / (np.e - np.s)) * 100).toFixed(0);
      now = '<div class="r-now"><em>NOW</em>' + esc(np.t) + '</div><div class="r-bar"><i style="width:' + pct + '%"></i></div>';
    } else {
      now = '<div class="r-now"><em>LIVE</em>' + esc(c.desc || '') + '</div>';
    }
    const next = nx ? '<div class="r-next"><em>NEXT ' + fmtTime(nx.s) + '</em><span>' + esc(nx.t) + '</span></div>' : '<div class="r-next"></div>';
    const tags = (c.country === 'PH' ? '<span class="tag ph">PH</span>' : '') + (S.favs.has(c.id) ? '<span class="tag">★</span>' : '');
    return '<button class="row' + (playing ? ' playing' : '') + '" data-focus data-ch="' + esc(c.id) + '">' +
      '<div class="r-logo">' + (c.logo ? '<img loading="lazy" alt="" src="' + esc(c.logo) + '" data-i="' + initials + '">' : '<span>' + initials + '</span>') + '</div>' +
      '<div class="r-main"><div class="r-name"><b>' + esc(c.name) + '</b>' + tags + (playing ? '<span class="r-watching">▶ WATCHING</span>' : '') + '</div>' + now + '</div>' + next + '</button>';
  }
  function renderGuide() {
    const list = tabList();
    const ae = document.activeElement;
    const focusedId = ae && ae.classList && ae.classList.contains('row') ? ae.dataset.ch : null;
    $('#guide').innerHTML = list.length ? list.map(rowHtml).join('') :
      '<div class="g-empty">No channels here right now.<br>Try another category or add a language with 🌐.</div>';
    $$('#guide img').forEach(imgFallback);
    if (focusedId) focusRow(focusedId, true);
  }
  function refreshGuideTimes() {
    $$('#guide .row').forEach((el) => {
      const c = S.byId.get(el.dataset.ch); if (!c) return;
      const d = document.createElement('div'); d.innerHTML = rowHtml(c); const n = d.firstChild;
      el.innerHTML = n.innerHTML; el.classList.toggle('playing', n.classList.contains('playing'));
    });
    $$('#guide img').forEach(imgFallback);
  }
  function imgFallback(img) { if (img.dataset.fb) return; img.dataset.fb = 1; img.addEventListener('error', () => { const s = document.createElement('span'); s.textContent = img.dataset.i || ''; img.replaceWith(s); }, { once: true }); }
  function focusRow(id, quiet) {
    const r = $('.row[data-ch="' + cssEsc(id) + '"]');
    if (!r) return;
    if (quiet) { r.classList.add('focused'); try { r.focus({ preventScroll: true }); } catch (e) { r.focus(); } } else focusEl(r);
  }
  function focusGuide() {
    if (isMobile()) return; // no focus rings on touch screens
    const id = S.current && S.current.id; const r = id && $('.row[data-ch="' + cssEsc(id) + '"]');
    focusEl(r || $('#guide .row') || $('[data-focus]'));
  }

  function renderPeek(ch) {
    const el = $('#peek'); if (!el || !ch) return;
    const np = nowProg(ch), nx = nextProg(ch);
    el.innerHTML = '<b>' + esc(ch.name) + '</b> — ' + esc(ch.desc || '') +
      (np ? '<br><b>Now:</b> ' + esc(np.t) + (np.d ? ' — ' + esc(np.d.slice(0, 140)) + (np.d.length > 140 ? '…' : '') : '') : '') +
      (nx ? '<br><b>Next ' + fmtTime(nx.s) + ':</b> ' + esc(nx.t) : '') +
      '<div class="tags">' + (ch.labels || []).map((t) => '<span class="tag">' + esc(t) + '</span>').join('') + (ch.lang && LANG_NAMES[ch.lang] ? '<span class="tag">' + esc(langName(ch.lang)) + '</span>' : '') + '</div>';
  }

  // ---------------------------------------------------------------- player
  function plan(ch, preferLang) {
    const out = [];
    const streams = (ch.streams || []).slice();
    if (preferLang) streams.sort((a, b) => (S.langs.map(langKey).includes(langKey(b.lang)) ? 1 : 0) - (S.langs.map(langKey).includes(langKey(a.lang)) ? 1 : 0));
    for (const s of streams) {
      if (s.cors === false) { if (NATIVE_RELIABLE) out.push({ s, how: 'native' }); continue; }
      if (HLSJS) out.push({ s, how: 'hls' });
      if (NATIVE_HLS) out.push({ s, how: 'native' });
    }
    return out;
  }
  function stopPlayback() {
    clearTimeout(S.startTimer); clearTimeout(S.stallTimer);
    if (S.hls) { try { S.hls.destroy(); } catch (e) { /* ignore */ } S.hls = null; }
    video.removeAttribute('src'); try { video.load(); } catch (e) { /* ignore */ }
  }
  function play(ch, opts) {
    opts = opts || {};
    S.current = ch; S.userPick = !!opts.user;
    if (opts.list && opts.list.length) S.list = opts.list;
    if (!S.list.includes(ch)) S.list = tabList().includes(ch) ? tabList() : [ch];
    if (ch.category !== 'byo') store.set('last', ch.id);
    S.attempts = plan(ch, true); S.attempt = 0;
    renderNow(); renderTimeline(); refreshGuideTimes(); osd();
    if (!S.attempts.length) { failChannel("This channel can't play in this browser."); return; }
    tryAttempt();
  }
  function tryAttempt() {
    stopPlayback();
    const a = S.attempts[S.attempt];
    if (!a) { failChannel(); return; }
    setMsg('Tuning in…');
    const ch = S.current;
    S.startTimer = setTimeout(() => { if (S.current === ch) nextAttempt(); }, START_TIMEOUT);
    if (a.how === 'hls') {
      const hls = new window.Hls({ enableWorker: true, backBufferLength: 30, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 2, subtitleDisplay: false, enableCEA708Captions: false });
      S.hls = hls; let recovered = false;
      hls.on(window.Hls.Events.ERROR, (_, d) => {
        if (!d.fatal || S.hls !== hls) return;
        if (d.type === window.Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; hls.recoverMediaError(); return; }
        nextAttempt();
      });
      hls.loadSource(a.s.url); hls.attachMedia(video);
    } else {
      video.src = a.s.url;
    }
    const p = video.play(); if (p && p.catch) p.catch(() => {});
  }
  function nextAttempt() { if (!S.current) return; S.attempt++; tryAttempt(); }
  video.addEventListener('playing', () => {
    clearTimeout(S.startTimer); setMsg(''); $('#unmute').hidden = !video.muted || S.interacted;
    Array.from(video.textTracks || []).forEach((t) => { t.mode = 'disabled'; }); // captions off: most channels don't provide reliable ones
    if (S.current) { S.probes[S.current.id] = { ok: true, at: Date.now() }; store.set('probes', S.probes); }
    setTimeout(startProber, 5000);
  });
  if (video.textTracks && video.textTracks.addEventListener) video.textTracks.addEventListener('addtrack', (e) => { if (e.track) e.track.mode = 'disabled'; });
  video.addEventListener('error', () => { if (!S.hls && video.getAttribute('src')) nextAttempt(); });
  video.addEventListener('waiting', () => { clearTimeout(S.stallTimer); S.stallTimer = setTimeout(() => { if (!video.paused && video.readyState < 3) { setMsg('Reconnecting…'); nextAttempt(); } }, 20000); });
  video.addEventListener('timeupdate', () => clearTimeout(S.stallTimer));

  /** A channel failed on this device: remove it everywhere, never leave it in the list. */
  function failChannel(why) {
    const ch = S.current; stopPlayback();
    const i = S.list.indexOf(ch);
    const next = S.list.slice(i + 1).concat(S.list.slice(0, Math.max(0, i))).find((c) => c !== ch && isVisible(c) && playable(c));
    markUnavailable(ch, 'play');
    if (!S.userPick && next) {
      // lean-back start: quietly move on, the broken channel is already gone from the guide
      toast(esc(ch.name) + " isn't available right now, so we removed it. Now playing <b>" + esc(next.name) + '</b>.', null, 5000, 'skip');
      play(next, { list: S.list });
    } else {
      setMsg((why || ch.name + " isn't available where you are right now.") + " We've removed it from your guide. Pick another channel.");
      $('#nowMeta').textContent = 'Unavailable';
      if (next) setTimeout(() => focusRow(next.id), 350);
    }
  }
  function zap(dir) {
    const l = S.list.filter((c) => isVisible(c)); if (!l.length) return;
    const i = l.indexOf(S.current); const c = l[(i + dir + l.length) % l.length];
    if (c) play(c, { list: S.list, user: true });
  }
  function setMsg(t) { $('#playerMsg').textContent = t || ''; }
  function unmuteOnce() {
    if (S.interacted) return; S.interacted = true;
    video.muted = false; $('#unmute').hidden = true;
    const p = video.play(); if (p && p.catch) p.catch(() => {});
  }
  $('#unmute').addEventListener('click', (e) => { e.stopPropagation(); unmuteOnce(); });
  $('#player').addEventListener('click', () => { if (!S.interacted) unmuteOnce(); else if (document.body.classList.contains('fs')) exitFs(); else enterFs(); });

  function renderNow() {
    const ch = S.current; if (!ch) return;
    $('#nowName').textContent = ch.name;
    const cat = S.categories.find((c) => c.id === ch.category);
    const bits = [cat ? cat.name : 'My playlist'];
    if (ch.lang && LANG_NAMES[ch.lang]) bits.push(langName(ch.lang));
    if (ch.country === 'PH') bits.push('Philippines');
    $('#nowMeta').innerHTML = esc(bits.join(' · ')) + (ch.labels || []).filter((t) => !cat || t !== cat.name).slice(0, 4).map((t) => ' <span class="tag">' + esc(t) + '</span>').join('') +
      (ch.desc ? '<div class="ch-desc">' + esc(ch.desc) + '</div>' : '');
    const logo = $('#nowLogo');
    if (ch.logo) { logo.src = ch.logo; logo.hidden = false; logo.onerror = () => { logo.hidden = true; }; } else logo.hidden = true;
    const fav = S.favs.has(ch.id); const fb = $('#favBtn');
    fb.textContent = fav ? '★' : '☆'; fb.classList.toggle('on', fav); fb.hidden = ch.category === 'byo';
    fb.setAttribute('aria-label', fav ? 'Remove from favorites' : 'Add to favorites');
    document.title = ch.name + ' — Web TV Hub';
  }

  // ---------------------------------------------------------------- timeline: previous / now / next / later
  function renderTimeline() {
    const ch = S.current; const box = $('#timeline'); if (!ch) return;
    const list = progs(ch); const t = Date.now(); const i = nowIndex(list, t);
    if (i < 0) {
      box.innerHTML = '<div class="tl-empty"><b>Live channel.</b> This broadcaster doesn\'t publish a schedule, so we can\'t show what\'s on next.</div>';
      return;
    }
    const tags = (p) => (p.g && p.g.length ? '<div class="tl-tags">' + p.g.map((g) => '<span class="tag">' + esc(g) + '</span>').join('') + (p.y ? '<span class="tag">' + p.y + '</span>' : '') + '</div>' : '');
    const sub = (p) => { const s = [p.ep, p.st].filter(Boolean).join(' · '); return s ? '<div class="tl-sub">' + esc(s) + '</div>' : ''; };
    const prev = list[i - 1], now = list[i], next = list[i + 1], later = list[i + 2];
    const pct = Math.min(100, ((t - now.s) / (now.e - now.s)) * 100);
    const ae = document.activeElement;
    const focusedRemind = ae && ae.dataset ? ae.dataset.remind : null;
    const remindBtn = (p) => { const on = hasReminder(ch.id, p.s); return '<button class="remind' + (on ? ' on' : '') + '" data-focus data-remind="' + p.s + '">' + (on ? '✓ Reminder set' : '🔔 Remind me') + '</button>'; };
    box.innerHTML =
      (prev ? '<div class="tl-seg past"><div class="tl-pill">Previous · ended ' + fmtTime(prev.e) + '</div><div class="tl-title">' + esc(prev.t) + '</div>' + sub(prev) + '</div>' : '<div class="tl-seg past"><div class="tl-pill">Previous</div><div class="tl-sub">—</div></div>') +
      '<div class="tl-seg now"><div class="tl-pill">● Now playing</div><div class="tl-title">' + esc(now.t) + '</div>' + sub(now) + tags(now) +
        (now.d ? '<div class="tl-desc">' + esc(now.d) + '</div>' : '') +
        '<div class="tl-bar"><i style="width:' + pct.toFixed(1) + '%"></i></div><div class="tl-time">' + fmtTime(now.s) + ' – ' + fmtTime(now.e) + ' · ' + inMins(now.e - t) + ' left</div></div>' +
      (next ? '<div class="tl-seg next"><div class="tl-pill">Up next · ' + fmtTime(next.s) + '</div><div class="tl-title">' + esc(next.t) + '</div>' + sub(next) + tags(next) + '<div class="tl-time">starts in ' + inMins(next.s - t) + '</div>' + remindBtn(next) + '</div>' : '<div class="tl-seg next"><div class="tl-pill">Up next</div><div class="tl-sub">Not listed yet</div></div>') +
      (later ? '<div class="tl-seg later"><div class="tl-pill">Later · ' + fmtTime(later.s) + '</div><div class="tl-title">' + esc(later.t) + '</div>' + sub(later) + remindBtn(later) + '</div>' : '<div class="tl-seg later"><div class="tl-pill">Later</div><div class="tl-sub">Not listed yet</div></div>');
    $$('[data-remind]', box).forEach((b) => b.addEventListener('click', () => toggleReminder(ch, +b.dataset.remind)));
    if (focusedRemind) { const b = $('[data-remind="' + focusedRemind + '"]', box); if (b) focusEl(b); }
  }

  // ---------------------------------------------------------------- reminders (while the app is open)
  const OFFSETS = [24 * 3600e3, 3600e3, 15 * 60e3, 0];
  function hasReminder(chId, s) { return S.reminders.some((r) => r.ch === chId && r.s === s); }
  function toggleReminder(ch, s) {
    const p = progs(ch).find((x) => x.s === s); if (!p) return;
    if (hasReminder(ch.id, s)) { S.reminders = S.reminders.filter((r) => !(r.ch === ch.id && r.s === s)); toast('Reminder removed.', null, 2500); }
    else {
      S.reminders = S.reminders.filter((r) => r.s > Date.now() - 3600e3);
      if (S.reminders.length >= FREE_REMINDERS) { toast('You can keep up to ' + FREE_REMINDERS + ' reminders. Remove one in My TV to add another.'); return; }
      S.reminders.push({ ch: ch.id, name: ch.name, s: p.s, t: p.t, fired: OFFSETS.filter((o) => Date.now() >= p.s - o).map(String) });
      toast("We'll remind you about <b>" + esc(p.t) + '</b> at ' + fmtTime(p.s) + ' (also 1 hour and 15 minutes before) while this app is open.');
      if (window.Notification && Notification.permission === 'default') { try { Notification.requestPermission(); } catch (e) { /* unsupported */ } }
    }
    store.set('reminders', S.reminders); renderTimeline();
  }
  function checkReminders() {
    const t = Date.now(); let changed = false;
    for (const r of S.reminders) {
      for (const o of OFFSETS) {
        if (r.fired.includes(String(o)) || t < r.s - o) continue;
        r.fired.push(String(o)); changed = true;
        if (t > r.s + 10 * 60e3) continue;
        const when = o === 0 ? 'is starting now' : o >= 24 * 3600e3 ? 'is on tomorrow at ' + fmtTime(r.s) : 'starts in ' + mins(o) + ' min';
        const msg = r.t + ' ' + when + ' on ' + r.name;
        toast(esc(msg), { label: 'Watch now', fn: () => { const c = S.byId.get(r.ch); if (c) play(c, { list: tabList(), user: true }); } }, 15000);
        if (window.Notification && Notification.permission === 'granted' && document.hidden) { try { new Notification('Web TV Hub', { body: msg, icon: 'icon-192.png' }); } catch (e) { /* ignore */ } }
      }
    }
    const before = S.reminders.length;
    S.reminders = S.reminders.filter((r) => r.s > t - 30 * 60e3);
    if (changed || before !== S.reminders.length) { store.set('reminders', S.reminders); renderTimeline(); }
  }

  // ---------------------------------------------------------------- toasts
  function toast(html, action, ms, key) {
    if (key) { const old = $('#toasts [data-key="' + key + '"]'); if (old) old.remove(); }
    const el = document.createElement('div'); el.className = 'toast'; el.innerHTML = html; if (key) el.dataset.key = key;
    if (action) { const b = document.createElement('button'); b.className = 'btn primary'; b.setAttribute('data-focus', ''); b.textContent = action.label; b.onclick = () => { action.fn(); el.remove(); }; el.appendChild(document.createElement('br')); el.appendChild(b); }
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), ms || 6000);
  }

  // ---------------------------------------------------------------- full screen
  let osdEl = null, osdTimer = null;
  function enterFs() {
    if (document.body.classList.contains('fs')) return;
    document.body.classList.add('fs'); pushBack();
    const el = $('#player'); if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    osd();
  }
  function exitFs() {
    document.body.classList.remove('fs');
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    focusGuide();
  }
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('fs')) document.body.classList.remove('fs'); });
  function osd() {
    if (!document.body.classList.contains('fs') || !S.current) return;
    if (!osdEl) { osdEl = document.createElement('div'); osdEl.className = 'fs-osd'; document.body.appendChild(osdEl); }
    const np = nowProg(S.current), nx = nextProg(S.current);
    osdEl.innerHTML = '<b>' + esc(S.current.name) + '</b>' + (np ? '<br>Now: ' + esc(np.t) + ' · until ' + fmtTime(np.e) : '') + (nx ? '<br>Next ' + fmtTime(nx.s) + ': ' + esc(nx.t) : '') + '<br><span class="small">▲▼ change channel · Back to exit</span>';
    osdEl.classList.add('show'); clearTimeout(osdTimer); osdTimer = setTimeout(() => osdEl.classList.remove('show'), 4500);
  }

  // ---------------------------------------------------------------- overlays
  let overlayClose = null;
  function openOverlay(html, onClose) {
    if ($('#overlay').hidden) pushBack();
    $('#panel').innerHTML = html; $('#overlay').hidden = false; overlayClose = onClose || null;
    $$('#panel img').forEach(imgFallback);
    $$('#panel [data-close]').forEach((b) => b.addEventListener('click', closeOverlay));
    $('#panel').scrollTop = 0;
    // TV/desktop: put the remote's focus inside the dialog. Phones: no focus jump, no surprise keyboard.
    if (!isMobile()) setTimeout(() => focusEl($('#panel [data-autofocus]') || $('#panel [data-focus]')), 30);
  }
  function closeOverlay() {
    if ($('#overlay').hidden) return;
    $('#overlay').hidden = true; $('#panel').innerHTML = '';
    const f = overlayClose; overlayClose = null; if (f) f();
    setBottom('home'); focusGuide();
  }
  function setBottom(a) { $$('.bottombar button').forEach((b) => b.classList.toggle('on', b.dataset.action === a)); }
  function langCounts() {
    const counts = {}; S.all.forEach((c) => { const k = langKey(c.lang); counts[k] = (counts[k] || 0) + 1; });
    const langs = Object.keys(counts).filter((k) => LANG_NAMES[k]).sort((a, b) => (a === 'eng' ? -1 : b === 'eng' ? 1 : counts[b] - counts[a]));
    return { counts, langs };
  }

  // Profile: languages, favorite shows/movies/stars, kinds of TV
  function openProfile() {
    setBottom('profile');
    const P = (S.profile && !S.profile.skipped) ? S.profile : { cats: {}, interests: [], eras: [], ph: true, langs: S.langs, picks: [] };
    const draft = { picks: (P.picks || []).slice() };
    const { counts, langs } = langCounts();
    const chip = (group, val, label, on) => '<button class="chip' + (on ? ' on' : '') + '" data-focus data-group="' + group + '" data-val="' + esc(val) + '">' + esc(label) + '</button>';
    openOverlay(
      '<h2>' + (S.profile && !S.profile.skipped ? 'Your profile' : 'Welcome! Let\'s set up your TV') + '</h2>' +
      '<p>A few quick picks so the right channels come first. Everything here stays on this device. You can skip this.</p>' +
      '<h3>Favorite shows, movies or stars</h3><p class="small">Type a title or a name. Spelling doesn\'t have to be perfect. We\'ll show you when they\'re on.</p>' +
      '<input class="field" id="pickIn" data-focus placeholder="e.g. Frasier, Star Trek, Lucille Ball" autocomplete="off" autocapitalize="off" spellcheck="false"><div class="suggest" id="pickSug"></div><div class="chips" id="pickChips" style="margin-top:.6rem"></div>' +
      '<h3>Languages</h3><div class="chips">' + langs.map((l) => chip('lang', l, langName(l) + ' (' + counts[l] + ')', (P.langs || ['eng']).map(langKey).includes(l))).join('') + chip('ph', 'ph', '🇵🇭 Always show Philippine channels', P.ph !== false) + '</div>' +
      '<h3>Kinds of TV you like</h3><div class="chips">' + S.categories.map((c) => chip('cat', c.id, c.name, ((P.cats || {})[c.id] || 0) > 0)).join('') + '</div>' +
      '<details class="more-prefs"' + ((P.interests || []).length || (P.eras || []).length ? ' open' : '') + '><summary data-focus tabindex="0">More preferences (optional)</summary>' +
      '<h3>Topics</h3><div class="chips">' + Object.keys(INTERESTS).map((k) => chip('int', k, k, (P.interests || []).includes(k))).join('') + '</div>' +
      '<h3>Era</h3><div class="chips">' + chip('era', 'classic', 'Classics (before 1990)', (P.eras || []).includes('classic')) + chip('era', 'y2k', '90s & 2000s', (P.eras || []).includes('y2k')) + chip('era', 'modern', 'Newer shows', (P.eras || []).includes('modern')) + '</div></details>' +
      '<div class="panel-actions">' + (S.profile ? '<button class="btn" data-focus data-close>Cancel</button>' : '<button class="btn" data-focus data-ob="skip">Skip</button>') + '<button class="btn primary" data-focus data-ob="save" data-autofocus>' + (S.profile && !S.profile.skipped ? 'Save' : 'Start watching') + '</button></div>',
      () => { if (!S.profile) { S.profile = { skipped: true, cats: {}, langs: ['eng'] }; store.set('profile', S.profile); } });
    $$('#panel .chip[data-group]').forEach((b) => b.addEventListener('click', () => b.classList.toggle('on')));
    const input = $('#pickIn'), sug = $('#pickSug');
    const icon = (t) => (t === 'person' ? '👤 ' : t === 'channel' ? '📺 ' : t === 'title' ? '🎬 ' : '🔎 ');
    const renderPicks = () => {
      $('#pickChips').innerHTML = draft.picks.map((p, i) => '<button class="chip on" data-focus data-rm="' + i + '">' + icon(p.type) + esc(p.label) +
        (p.q && fold(p.q) !== p.key && p.type !== 'text' ? ' <small>(you typed “' + esc(p.q) + '”)</small>' : '') + '<span class="x">✕</span></button>').join('');
      $$('#pickChips [data-rm]').forEach((b) => b.addEventListener('click', () => { draft.picks.splice(+b.dataset.rm, 1); renderPicks(); }));
    };
    const addPick = (e, q) => {
      const p = e ? { type: e.type, label: e.label, key: e.key, id: e.id, q } : { type: 'text', label: q, key: fold(q), q };
      if (!draft.picks.some((x) => x.type === p.type && x.key === p.key)) draft.picks.push(p);
      input.value = ''; sug.innerHTML = ''; renderPicks(); focusEl(input);
    };
    const typeLabel = (e) => e.type === 'person' ? 'Star · in ' + e.titles.length + ' show' + (e.titles.length > 1 ? 's' : '') + ' on the schedule' : e.type === 'channel' ? 'Channel' : (e.kind === 'movie' ? 'Movie' : 'Show') + ' · on the schedule';
    const showSug = () => {
      const q = input.value.trim(); const res = suggest(q, 6);
      sug.innerHTML = res.map((r, i) => '<button class="sug" data-focus data-si="' + i + '"><span>' + esc(r.e.label) + '</span><small>' + typeLabel(r.e) + '</small></button>').join('') +
        (q.length >= 2 ? '<button class="sug" data-focus data-si="-1"><span>Add “' + esc(q) + '” anyway</span><small>we\'ll watch for it</small></button>' : '');
      $$('#pickSug [data-si]').forEach((b) => b.addEventListener('click', () => { const i = +b.dataset.si; addPick(i >= 0 ? res[i].e : null, q); }));
    };
    let tmr = null;
    input.addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(showSug, 150); });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return; e.preventDefault();
      const q = input.value.trim(); if (q.length < 2) return;
      const res = suggest(q, 1);
      addPick(res[0] && res[0].s >= 0.75 ? res[0].e : null, q); // auto-correct obvious typos
    });
    renderPicks();
    const skip = $('[data-ob="skip"]'); if (skip) skip.onclick = () => { S.profile = { skipped: true, cats: {}, langs: ['eng'] }; store.set('profile', S.profile); closeOverlay(); };
    $('[data-ob="save"]').onclick = async () => {
      const on = (g) => $$('#panel .chip.on[data-group="' + g + '"]').map((b) => b.dataset.val);
      const cats = {}; on('cat').forEach((id) => { cats[id] = 1; });
      const langsSel = on('lang'); const pending = input.value.trim();
      if (pending.length >= 2) { const r = suggest(pending, 1); addPick(r[0] && r[0].s >= 0.75 ? r[0].e : null, pending); }
      S.profile = { cats, interests: on('int'), eras: on('era'), ph: on('ph').length > 0, langs: langsSel.length ? langsSel : ['eng'], picks: draft.picks, skipped: false, updated: Date.now() };
      store.set('profile', S.profile);
      closeOverlay(); await applyLangs(S.profile.langs);
      if (forYou().length) { S.tab = 'foryou'; store.set('tab', 'foryou'); }
      renderTabs(); renderGuide();
      const onAir = picksOnAir();
      toast('Profile saved.' + (onAir.length ? ' <b>' + onAir.length + '</b> showings of your picks in the next 24 hours. See <b>My TV</b>.' : ''), null, 6000);
      if (!S.userPick) { const fy = forYou(); if (fy[0] && fy[0] !== S.current) play(fy[0], { list: fy }); }
    };
  }
  async function applyLangs(langs) {
    S.langs = langs; suggestIndex = null;
    await loadEpgFor(neededLangs());
    renderTabs(); renderGuide();
  }
  function openLangs() {
    const { counts, langs } = langCounts();
    openOverlay('<h2>Languages</h2><p>Show channels in these languages. English is the default.</p><div class="chips">' +
      langs.map((l) => '<button class="chip' + (S.langs.map(langKey).includes(l) ? ' on' : '') + '" data-focus data-l="' + l + '">' + esc(langName(l)) + ' (' + counts[l] + ')</button>').join('') +
      '</div><div class="panel-actions"><button class="btn" data-focus data-close>Cancel</button><button class="btn primary" data-focus data-autofocus data-save>Apply</button></div>');
    $$('#panel [data-l]').forEach((b) => b.addEventListener('click', () => b.classList.toggle('on')));
    $('[data-save]').onclick = async () => {
      const l = $$('#panel .chip.on').map((b) => b.dataset.l);
      const langs2 = l.length ? l : ['eng'];
      if (S.profile) S.profile.langs = langs2; else S.profile = { skipped: true, cats: {}, langs: langs2 };
      store.set('profile', S.profile);
      closeOverlay(); await applyLangs(langs2);
    };
  }

  // My TV: picks on air, reminders, favorites
  function openMyTv() {
    setBottom('mytv');
    const onAir = picksOnAir().slice(0, 25);
    const matched = new Set(onAir.map((x) => x.pick.key));
    const elsewhere = new Set();
    for (const pk of picks()) {
      if (matched.has(pk.key)) continue;
      const keys = titleKeysFor(pk);
      for (const c of S.raw || []) {
        if (S.byId.has(c.id) || !langOk(c)) continue;
        if (progs(c).some((p) => p.e > Date.now() && (keys ? keys.has(normTitle(p.t)) : similarity(fold(pk.q), normTitle(p.t)) >= 0.85))) { elsewhere.add(pk.key); break; }
      }
    }
    const missing = picks().filter((p) => !matched.has(p.key) && !elsewhere.has(p.key));
    const other = picks().filter((p) => elsewhere.has(p.key));
    const li = (x) => {
      const live = x.p.s <= Date.now();
      return '<button class="li" data-focus data-play="' + esc(x.ch.id) + '" data-s="' + x.p.s + '"><span class="when' + (live ? ' live' : '') + '">' + (live ? '● LIVE' : fmtTime(x.p.s)) + '</span>' +
        '<span class="what"><b>' + esc(x.p.t) + '</b><small>' + esc(x.ch.name) + (x.pick.type === 'person' ? ' · with ' + esc(x.pick.label) : '') + '</small></span><span class="small">' + (live ? 'Watch ▸' : (hasReminder(x.ch.id, x.p.s) ? '🔔 Set' : '🔔 Remind')) + '</span></button>';
    };
    const rem = S.reminders.filter((r) => r.s > Date.now() - 30 * 60e3);
    const favs = visible().filter((c) => S.favs.has(c.id));
    openOverlay('<h2>My TV</h2>' +
      '<h3>Your picks on air (next 24 hours)</h3>' +
      (picks().length ? (onAir.length ? '<div class="list">' + onAir.map(li).join('') + '</div>' : '<p>None of your picks are on free TV in the next 24 hours.</p>') :
        '<p>Add favorite shows, movies or stars in your profile and we\'ll list when they\'re on.</p><button class="btn small" data-focus data-goprofile>Open profile</button>') +
      (other.length ? '<p class="small">📱 <b>' + other.map((p) => esc(p.label)).join(', ') + '</b> ' + (other.length > 1 ? 'are' : 'is') + ' on free TV soon, on channels that play on Android TV sticks, phones and Safari but not in this browser.</p>' : '') +
      (missing.length ? '<div class="wtw"><h3>Not on free TV right now</h3><p class="small">' + missing.map((p) => esc(p.label)).join(', ') + '</p>' +
        missing.slice(0, 3).map((p) => '<a class="btn small" data-focus target="_blank" rel="noopener" href="https://www.justwatch.com/ph/search?q=' + encodeURIComponent(p.label) + '">Where to watch “' + esc(p.label) + '” ↗</a>').join('') + '</div>' : '') +
      '<h3>Reminders (' + rem.length + '/' + FREE_REMINDERS + ')</h3>' +
      (rem.length ? '<div class="list">' + rem.map((r) => '<button class="li" data-focus data-unrem="' + esc(r.ch) + '|' + r.s + '"><span class="when">' + fmtTime(r.s) + '</span><span class="what"><b>' + esc(r.t) + '</b><small>' + esc(r.name) + '</small></span><span class="small">Remove ✕</span></button>').join('') + '</div>' : '<p>No reminders yet. Use 🔔 Remind me on any upcoming show.</p>') +
      '<h3>Favorite channels</h3>' +
      (favs.length ? '<div class="list">' + favs.map((c) => { const np = nowProg(c); return '<button class="li" data-focus data-play="' + esc(c.id) + '"><span class="when">' + (np ? '● NOW' : 'LIVE') + '</span><span class="what"><b>' + esc(c.name) + '</b><small>' + esc(np ? np.t : c.desc || '') + '</small></span><span class="small">Watch ▸</span></button>'; }).join('') + '</div>' : '<p>Tap ☆ next to a channel\'s name to add it here.</p>') +
      '<div class="panel-actions"><button class="btn" data-focus data-close data-autofocus>Close</button></div>');
    $$('#panel [data-play]').forEach((b) => b.addEventListener('click', () => {
      const c = S.byId.get(b.dataset.play); const s = +b.dataset.s;
      if (!c) return;
      if (s && s > Date.now()) { toggleReminder(c, s); openMyTv(); return; }
      closeOverlay(); play(c, { list: tabList(), user: true });
    }));
    $$('#panel [data-unrem]').forEach((b) => b.addEventListener('click', () => { const [ch, s] = b.dataset.unrem.split('|'); S.reminders = S.reminders.filter((r) => !(r.ch === ch && r.s === +s)); store.set('reminders', S.reminders); renderTimeline(); openMyTv(); }));
    const gp = $('#panel [data-goprofile]'); if (gp) gp.addEventListener('click', () => openProfile());
  }

  // Search with typo tolerance + "where to watch" for things that aren't on free TV
  function openSearch() {
    setBottom('search');
    openOverlay('<h2>Search</h2><p>Channels, shows, movies and stars. Typos are OK.</p><input class="field" id="q" data-focus data-autofocus placeholder="Try: frasier, star trek, cartoons, NBA" autocomplete="off" autocapitalize="off" spellcheck="false"><div id="sr" class="results"></div>' +
      '<div class="panel-actions"><button class="btn" data-focus data-close>Close</button></div>');
    const q = $('#q'); let t = null;
    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => runSearch(q.value), 200); });
    if (!isMobile()) setTimeout(() => q.focus(), 60);
  }
  function runSearch(v) {
    const out = $('#sr'); if (!out) return;
    const q = v.trim(); const f = fold(q);
    if (f.length < 2) { out.innerHTML = ''; return; }
    const hits = [];
    const res = suggest(q, 8);
    for (const r of res) {
      const e = r.e;
      if (e.type === 'channel') { const c = S.byId.get(e.id); if (c) { const np = nowProg(c); hits.push({ c, label: c.name, sub: np ? 'Now: ' + np.t : (c.desc || '') }); } continue; }
      const keys = e.type === 'person' ? new Set(e.titles) : new Set([e.key]);
      for (const [cid, list] of Object.entries(S.epg)) {
        const c = S.byId.get(cid); if (!c || !isVisible(c)) continue;
        const p = list.find((x) => x.e > Date.now() && keys.has(normTitle(x.t)));
        if (p) hits.push({ c, p, label: p.t, sub: (p.s <= Date.now() ? 'Live now' : fmtTime(p.s)) + ' · ' + c.name + (e.type === 'person' ? ' · with ' + e.label : '') });
      }
    }
    for (const cat of S.categories) if (fold(cat.name).includes(f) || similarity(f, fold(cat.name)) > 0.8) visible().filter((c) => c.category === cat.id).slice(0, 6).forEach((c) => hits.push({ c, label: c.name, sub: cat.name }));
    const seen = new Set();
    const uniq = hits.filter((h) => { const k = h.c.id + (h.p ? h.p.s : ''); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 20);
    let html = '';
    if (res[0] && res[0].s < 0.97 && fold(res[0].e.label) !== f) html += '<p class="small">Showing results for <b>' + esc(res[0].e.label) + '</b></p>';
    const w = S.wtw.find((x) => x.keywords.some((k) => f.includes(fold(k)) || (f.length > 3 && fold(k).includes(f))));
    if (w || uniq.length === 0) {
      const services = w ? w.services : [{ name: 'Search JustWatch (Philippines)', url: 'https://www.justwatch.com/ph/search?q=' + encodeURIComponent(q) }];
      html += '<div class="wtw"><h3>Where to watch officially' + (w ? ': ' + esc(w.title) : '') + '</h3><p class="small">' + (w ? "This isn't on free TV. You can watch it legally here:" : "We couldn't find this on free TV right now. Check where it streams legally:") + '</p>' +
        services.map((s) => '<a class="btn small" data-focus target="_blank" rel="noopener" href="' + esc(s.url) + '">' + esc(s.name) + ' ↗</a>').join('') + '</div>';
    }
    if (uniq.length) html += '<div class="list" style="margin-top:1rem">' + uniq.map((h) => '<button class="li" data-focus data-play="' + esc(h.c.id) + '"><span class="when' + (h.p && h.p.s <= Date.now() ? ' live' : '') + '">' + (h.p ? (h.p.s <= Date.now() ? '● LIVE' : fmtTime(h.p.s)) : 'Channel') + '</span><span class="what"><b>' + esc(h.label) + '</b><small>' + esc(h.sub) + '</small></span><span class="small">Watch ▸</span></button>').join('') + '</div>';
    out.innerHTML = html;
    $$('#sr [data-play]').forEach((b) => b.addEventListener('click', () => {
      const c = S.byId.get(b.dataset.play); closeOverlay(); if (!c) return;
      if (S.tab !== 'foryou' && S.tab !== c.category) setTab(c.category);
      play(c, { list: tabList(), user: true });
    }));
  }

  // More: open on another screen (QR), install, my playlist, about
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
  function openMore() {
    const url = location.origin + location.pathname;
    openOverlay('<h2>More</h2>' +
      '<h3>Open on another screen</h3><div style="display:flex;gap:1.4rem;align-items:center;flex-wrap:wrap"><div class="qr" id="qr"></div><div style="flex:1;min-width:14rem"><p>Scan with your phone camera, or type this address into your TV\'s browser (TV Bro, BrowseHere, Silk):</p><div class="bigurl">' + esc(url.replace(/^https:\/\//, '')) + '</div><p class="small">On a TV stick, bookmark it so it\'s one click next time.</p></div></div>' +
      '<h3>Install as an app</h3><p>' + (installPrompt ? 'Add Web TV Hub to your home screen. It opens full screen like a regular app.' : 'On a phone, open your browser\'s menu and choose “Add to Home screen”. It opens full screen like a regular app.') + '</p>' + (installPrompt ? '<button class="btn primary" data-focus data-install>Install app</button>' : '') +
      '<h3>My playlist</h3><p>Add one .m3u playlist link of your own. It\'s saved only in this browser and never sent to us. Links must start with https:// and the server must allow web players.</p>' +
      '<input class="field" id="m3u" data-focus placeholder="https://example.com/my-playlist.m3u" value="' + esc(S.byo ? S.byo.url : '') + '"><p class="small" id="m3uMsg">' + (S.byo ? S.byo.channels.length + ' channels loaded.' : '') + '</p>' +
      '<div class="chips">' + (S.byo ? '<button class="btn small" data-focus data-m3u="remove">Remove playlist</button>' : '') + '<button class="btn small" data-focus data-m3u="save">Load playlist</button></div>' +
      '<h3>About</h3><p>A free guide to live channels that broadcasters already stream for free. We check every channel every 6 hours, and your device double-checks the ones you can see, so channels that don\'t work for you are removed automatically.</p>' +
      '<p>We don\'t host or re-stream any video. Channel data comes from the open <a href="https://github.com/iptv-org/iptv" target="_blank" rel="noopener">iptv-org</a> project; schedules and channel descriptions from public listings of free ad-supported services; cast information from <a href="https://www.wikidata.org" target="_blank" rel="noopener">Wikidata</a>.</p>' +
      '<p>Rights-holder and want a channel removed? <a href="https://github.com/francis-h-francisco/web-tv-hub/issues/new?title=Removal%20request" target="_blank" rel="noopener">Open a removal request</a>.</p>' +
      '<p class="small">Channel list checked ' + esc(relTime(S.generated)) + '.' + (S.hiddenForBrowser ? ' ' + S.hiddenForBrowser + ' more free channels play on Android TV sticks, phones and Safari but not in this browser.' : '') + '</p>' +
      '<div class="panel-actions"><button class="btn" data-focus data-close data-autofocus>Close</button></div>');
    drawQr(url);
    const ib = $('[data-install]'); if (ib) ib.onclick = async () => { installPrompt.prompt(); await installPrompt.userChoice.catch(() => {}); installPrompt = null; closeOverlay(); };
    const rm = $('[data-m3u="remove"]'); if (rm) rm.onclick = () => { S.byo = null; store.set('byo', null); renderTabs(); renderGuide(); closeOverlay(); toast('Playlist removed.'); };
    $('[data-m3u="save"]').onclick = loadPlaylist;
  }
  function relTime(iso) {
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60); return h < 48 ? h + ' h ago' : Math.round(h / 24) + ' days ago';
  }
  function drawQr(text) {
    const draw = () => { const el = $('#qr'); if (!el) return; try { const qr = window.qrcode(0, 'M'); qr.addData(text); qr.make(); el.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true }); } catch (e) { el.hidden = true; } };
    if (window.qrcode) return draw();
    const s = document.createElement('script'); s.src = 'vendor/qrcode.js'; s.onload = draw; s.onerror = () => { const el = $('#qr'); if (el) el.hidden = true; }; document.head.appendChild(s);
  }
  async function loadPlaylist() {
    const url = $('#m3u').value.trim(); const msg = $('#m3uMsg');
    if (!/^https:\/\//i.test(url)) { msg.textContent = 'Please use a link that starts with https://'; return; }
    msg.textContent = 'Loading…';
    try {
      const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status);
      const chans = parseM3u(await r.text()); if (!chans.length) throw new Error('no channels found');
      S.byo = { url, channels: chans }; store.set('byo', S.byo);
      chans.forEach((c) => S.byId.set(c.id, c));
      closeOverlay(); setTab('byo'); toast('Loaded ' + chans.length + ' channels into <b>My playlist</b>.');
    } catch (e) { msg.textContent = "Couldn't load that playlist (" + e.message + "). The server may not allow web players to read it."; }
  }
  function parseM3u(txt) {
    const out = []; let cur = null;
    for (const raw of txt.split(/\r?\n/)) {
      const l = raw.trim();
      if (l.startsWith('#EXTINF')) { const logo = (/tvg-logo="([^"]*)"/.exec(l) || [])[1]; cur = { name: l.slice(l.lastIndexOf(',') + 1).trim() || 'Channel', logo: logo && /^https:/.test(logo) ? logo : null }; }
      else if (l && l[0] !== '#' && cur) { if (/^https:\/\//i.test(l)) out.push({ id: 'byo:' + out.length, name: cur.name.slice(0, 80), logo: cur.logo, category: 'byo', lang: 'und', streams: [{ url: l, cors: null }], desc: 'From your playlist' }); cur = null; }
      if (out.length >= 300) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- clicks
  document.addEventListener('click', (e) => {
    const row = e.target.closest('.row[data-ch]');
    if (row) {
      const c = S.byId.get(row.dataset.ch); if (!c) return;
      if (S.current === c && !$('#playerMsg').textContent) { enterFs(); return; }
      play(c, { list: tabList(), user: true });
      if (isMobile()) window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const tab = e.target.closest('[data-tab]'); if (tab) { setTab(tab.dataset.tab, !isMobile()); return; }
    const b = e.target.closest('[data-action]'); if (!b) return;
    const a = b.dataset.action;
    if (a === 'search') openSearch();
    else if (a === 'mytv') openMyTv();
    else if (a === 'profile') openProfile();
    else if (a === 'more') openMore();
    else if (a === 'langs') openLangs();
    else if (a === 'home') { closeOverlay(); setBottom('home'); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    else if (a === 'fullscreen') enterFs();
    else if (a === 'fav' && S.current) {
      const id = S.current.id;
      if (S.favs.has(id)) S.favs.delete(id); else { S.favs.add(id); toast('Added <b>' + esc(S.current.name) + '</b> to Favorites.', null, 3000); }
      store.set('favs', [...S.favs]); renderNow(); renderTabs(); refreshGuideTimes();
    }
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target; if (!el.hasAttribute || !el.hasAttribute('data-focus')) return;
    $$('.focused').forEach((x) => x !== el && x.classList.remove('focused')); el.classList.add('focused');
    if (el.dataset.ch) renderPeek(S.byId.get(el.dataset.ch));
    // TV feel: resting on a category for a moment opens it
    if (el.dataset.tab && !isMobile()) { clearTimeout(S.tabT); S.tabT = setTimeout(() => { if (document.activeElement === el) setTab(el.dataset.tab, true); }, 450); }
  });

  // ---------------------------------------------------------------- back handling (remote Back, Esc, Android back)
  let backDepth = 0;
  function pushBack() { try { history.pushState({ wth: 1 }, ''); backDepth++; } catch (e) { /* ignore */ } }
  function handleBack() {
    if (!$('#overlay').hidden) { closeOverlay(); return true; }
    if (document.body.classList.contains('fs')) { exitFs(); return true; }
    return false;
  }
  window.addEventListener('popstate', () => { backDepth = Math.max(0, backDepth - 1); handleBack(); });
  function back() { if (backDepth > 0) history.back(); else handleBack(); }

  // ---------------------------------------------------------------- spatial navigation for D-pads
  function focusables() {
    const root = !$('#overlay').hidden ? $('#panel') : document;
    return $$('[data-focus]', root).filter((el) => !el.hidden && el.offsetParent !== null && (root !== document || !el.closest('#overlay')));
  }
  function focusEl(el) {
    if (!el) return;
    $$('.focused').forEach((x) => x.classList.remove('focused'));
    el.classList.add('focused');
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function move(dir) {
    const ae = document.activeElement;
    const cur = ae && ae.hasAttribute && ae.hasAttribute('data-focus') ? ae : null;
    const all = focusables(); if (!all.length) return;
    if (!cur || !all.includes(cur)) { focusEl($('#guide .row.playing') || all[0]); return; }
    // in the guide, up/down walks the rows: fast and predictable on a remote
    if (cur.classList.contains('row') && (dir === 'up' || dir === 'down')) {
      const sib = dir === 'down' ? cur.nextElementSibling : cur.previousElementSibling;
      if (sib && sib.classList.contains('row')) { focusEl(sib); return; }
      if (dir === 'up') { focusEl($('#tabs .tab.on') || $('#tabs .tab')); return; }
      return;
    }
    if (cur.classList.contains('tab') && dir === 'down') { focusEl($('#guide .row')); return; }
    const r = cur.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of all) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2;
      let primary, cross;
      if (dir === 'left') { if (b.right > r.left + 2) continue; primary = cx - x; cross = Math.abs(y - cy); }
      else if (dir === 'right') { if (b.left < r.right - 2) continue; primary = x - cx; cross = Math.abs(y - cy); }
      else if (dir === 'up') { if (b.bottom > r.top + 2) continue; primary = cy - y; cross = Math.abs(x - cx); }
      else { if (b.top < r.bottom - 2) continue; primary = y - cy; cross = Math.abs(x - cx); }
      if ((dir === 'left' || dir === 'right') && (b.bottom < r.top || b.top > r.bottom)) cross *= 4;
      const sc = primary + cross * 2.2;
      if (sc < bestScore) { bestScore = sc; best = el; }
    }
    if (best) focusEl(best);
  }
  $('#player').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !document.body.classList.contains('fs')) { e.preventDefault(); if (!S.interacted) unmuteOnce(); enterFs(); } });
  const BACK_KEYS = new Set(['Escape', 'GoBack', 'BrowserBack', 'Back']);
  document.addEventListener('keydown', (e) => {
    const k = e.key, code = e.keyCode;
    const inField = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
    if (!S.interacted && !inField) unmuteOnce();
    if (BACK_KEYS.has(k) || code === 461 || code === 10009 || (k === 'Backspace' && !inField)) { e.preventDefault(); back(); return; }
    if (document.body.classList.contains('fs') && $('#overlay').hidden) {
      if (k === 'ArrowUp' || k === 'ChannelUp' || k === 'PageUp') { e.preventDefault(); zap(-1); return; }
      if (k === 'ArrowDown' || k === 'ChannelDown' || k === 'PageDown') { e.preventDefault(); zap(1); return; }
      if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Enter') { e.preventDefault(); osd(); return; }
    }
    if (k === 'ChannelUp' || k === 'PageUp') { e.preventDefault(); zap(-1); return; }
    if (k === 'ChannelDown' || k === 'PageDown') { e.preventDefault(); zap(1); return; }
    const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[k];
    if (dir) {
      if (inField && (dir === 'left' || dir === 'right')) return;
      e.preventDefault(); move(dir);
    }
  });
  document.addEventListener('pointerdown', () => { if (!S.interacted) unmuteOnce(); }, { once: true });

  // ---------------------------------------------------------------- installable app (offline shell)
  function registerSW() {
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  boot();
})();
