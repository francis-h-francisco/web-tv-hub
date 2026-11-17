/* Web TV Hub — lean-back live TV for TVs, remotes and phones. No build step, no framework. */
(function () {
  'use strict';

  // ---------------------------------------------------------------- moved to webtv-hub.pages.dev
  // The old GitHub Pages address forwards to the new one and carries this browser's settings along
  // (each web address has its own storage), so nobody loses their profile, favorites or reminders.
  const NEW_HOME = 'https://webtv-hub.pages.dev/';
  if (location.hostname === 'francis-h-francisco.github.io' && !window.Capacitor) {
    const keep = ['profile', 'favs', 'reminders', 'history', 'byo', 'tab', 'kids', 'cc', 'remotePaired', 'remoteCode', 'last'];
    const carry = {};
    try { keep.forEach((k) => { const v = localStorage.getItem('wth.' + k); if (v != null) carry[k] = v; }); } catch (e) { /* storage blocked */ }
    const rest = location.pathname.replace(/^\/web-tv-hub\/?/, '');
    const hash = Object.keys(carry).length ? '#migrate=' + encodeURIComponent(JSON.stringify(carry)) : '';
    location.replace(NEW_HOME + rest + location.search + hash);
    return;
  }
  if (location.hash.indexOf('#migrate=') === 0) {
    try {
      const carry = JSON.parse(decodeURIComponent(location.hash.slice(9)));
      Object.keys(carry).forEach((k) => { if (localStorage.getItem('wth.' + k) == null) localStorage.setItem('wth.' + k, carry[k]); });
    } catch (e) { /* ignore a malformed hand-over */ }
    history.replaceState(null, '', location.pathname + location.search);
  }

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
  S.country = (S.profile && S.profile.country) || store.get('detectedCountry', null) || countryFromTimezone();

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

  // ---------------------------------------------------------------- location
  // Which country the viewer is in decides which channels can actually play. Detected from the network
  // (Cloudflare's public trace endpoint), with the device time zone as a fallback; changeable in the profile.
  const TZ_COUNTRY = { 'Asia/Manila': 'PH', 'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US', 'America/Los_Angeles': 'US', 'America/Phoenix': 'US', 'America/Anchorage': 'US', 'Pacific/Honolulu': 'US',
    'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Berlin': 'DE', 'Europe/Paris': 'FR', 'Europe/Madrid': 'ES', 'Europe/Rome': 'IT', 'Europe/Amsterdam': 'NL',
    'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO', 'Europe/Copenhagen': 'DK', 'Europe/Vienna': 'AT', 'Europe/Zurich': 'CH', 'Europe/Lisbon': 'PT', 'America/Sao_Paulo': 'BR', 'America/Mexico_City': 'MX',
    'America/Argentina/Buenos_Aires': 'AR', 'America/Santiago': 'CL', 'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Seoul': 'KR', 'Asia/Tokyo': 'JP', 'Asia/Singapore': 'SG', 'Asia/Kuala_Lumpur': 'MY',
    'Asia/Jakarta': 'ID', 'Asia/Bangkok': 'TH', 'Asia/Ho_Chi_Minh': 'VN', 'Asia/Hong_Kong': 'HK', 'Asia/Dubai': 'AE', 'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Perth': 'AU', 'Pacific/Auckland': 'NZ' };
  function countryFromTimezone() { try { return TZ_COUNTRY[Intl.DateTimeFormat().resolvedOptions().timeZone] || null; } catch (e) { return null; } }
  const normCountry = (c) => (c === 'UK' ? 'GB' : c);
  function countryName(cc) { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc); } catch (e) { return cc; } }
  async function detectCountry() {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
      const txt = await fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: ctrl.signal, cache: 'no-store' }).then((r) => r.text());
      clearTimeout(t);
      const m = /^loc=([A-Z]{2})$/m.exec(txt);
      if (m && m[1] !== 'XX') { store.set('detectedCountry', m[1]); return m[1]; }
    } catch (e) { /* offline or blocked: keep the time-zone guess */ }
    return null;
  }

  // ---------------------------------------------------------------- text matching (typo-tolerant)
  // ---------------------------------------------------------------- icons (one consistent line-icon set; emoji render differently on every device)
  const ICONS = {"globe": "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z\"/>", "pin": "<path d=\"M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z\"/><circle cx=\"12\" cy=\"10\" r=\"2.3\"/>", "play": "<path d=\"M7 4.5v15l12-7.5z\" fill=\"currentColor\" stroke=\"none\"/>", "pause": "<rect x=\"6\" y=\"4.5\" width=\"4\" height=\"15\" rx=\"1\" fill=\"currentColor\" stroke=\"none\"/><rect x=\"14\" y=\"4.5\" width=\"4\" height=\"15\" rx=\"1\" fill=\"currentColor\" stroke=\"none\"/>", "vol": "<path d=\"M3.5 9.5v5h3.8l4.7 4V5.5l-4.7 4z\" fill=\"currentColor\" stroke=\"none\"/><path d=\"M15.5 9a4.2 4.2 0 0 1 0 6M18.3 6.3a8 8 0 0 1 0 11.4\"/>", "mute": "<path d=\"M3.5 9.5v5h3.8l4.7 4V5.5l-4.7 4z\" fill=\"currentColor\" stroke=\"none\"/><path d=\"M16 9.5l5 5M21 9.5l-5 5\"/>", "voldown": "<path d=\"M3.5 9.5v5h3.8l4.7 4V5.5l-4.7 4z\" fill=\"currentColor\" stroke=\"none\"/><path d=\"M15.5 12h5.5\"/>", "volup": "<path d=\"M3.5 9.5v5h3.8l4.7 4V5.5l-4.7 4z\" fill=\"currentColor\" stroke=\"none\"/><path d=\"M15.5 12h5.5M18.25 9.25v5.5\"/>", "cast": "<path d=\"M2.5 17.5a4 4 0 0 1 4 4M2.5 13.5a8 8 0 0 1 8 8M2.5 9.5a12 12 0 0 1 12 12\"/><path d=\"M2.5 6.5v-1a2 2 0 0 1 2-2h15a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-2.5\"/>", "pip": "<rect x=\"2.5\" y=\"4.5\" width=\"19\" height=\"15\" rx=\"2\"/><rect x=\"12\" y=\"11\" width=\"7\" height=\"6\" rx=\"1\" fill=\"currentColor\" stroke=\"none\"/>", "moon": "<path d=\"M20 14.6A8.2 8.2 0 0 1 9.4 4a8.2 8.2 0 1 0 10.6 10.6z\"/>", "star": "<path d=\"M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z\"/>", "starOn": "<path d=\"M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z\" fill=\"currentColor\"/>", "share": "<path d=\"M12 3.5v11M7.5 8l4.5-4.5L16.5 8\"/><path d=\"M5 12.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-6.5\"/>", "fs": "<path d=\"M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5\"/>", "prev": "<path d=\"M6 5v14\"/><path d=\"M19 5L9 12l10 7z\" fill=\"currentColor\" stroke=\"none\"/>", "next": "<path d=\"M18 5v14\"/><path d=\"M5 5l10 7-10 7z\" fill=\"currentColor\" stroke=\"none\"/>", "remote": "<rect x=\"7\" y=\"2.5\" width=\"10\" height=\"19\" rx=\"2.5\"/><circle cx=\"12\" cy=\"8\" r=\"1.6\" fill=\"currentColor\" stroke=\"none\"/><path d=\"M10.5 17.5h3\"/>", "tv": "<rect x=\"2.5\" y=\"6\" width=\"19\" height=\"13\" rx=\"2\"/><path d=\"M8 3l4 3 4-3\"/>", "search": "<circle cx=\"11\" cy=\"11\" r=\"6.5\"/><path d=\"M20.5 20.5l-4.8-4.8\"/>", "user": "<circle cx=\"12\" cy=\"8\" r=\"4\"/><path d=\"M4 21a8 8 0 0 1 16 0\"/>", "menu": "<path d=\"M4 6.5h16M4 12h16M4 17.5h16\"/>"};
  const ic = (n) => '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">' + ICONS[n] + '</svg>';

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
    const rc = new URLSearchParams(location.search).get('remote');
    if (rc !== null) { stopPlayback(); loadScript('remote.js').then(() => window.WTHRemote.controller(rc)); return; }
    tickClock(); setInterval(tickClock, 15000);
    try {
      const [c, w, p] = await Promise.all([
        fetch('data/channels.json').then((r) => r.json()),
        fetch('data/where-to-watch.json').then((r) => r.json()).catch(() => []),
        fetch('data/people.json').then((r) => r.json()).catch(() => ({ cast: {} })),
      ]);
      S.categories = c.categories; S.wtw = Array.isArray(w) ? null : w; S.cast = p.cast || {}; S.generated = c.generated;
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
    const [cc] = await Promise.all([!(S.profile && S.profile.country) ? detectCountry() : null, loadSharedUnavailable()]);
    if (cc) S.country = cc;
    await loadEpgFor(neededLangs());
    pruneExpired();
    renderTabs(); renderGuide();
    const qp = new URLSearchParams(location.search);
    const want = qp.get('ch') || store.get('last', null);
    const wantCh = want && S.byId.get(want);
    if (qp.get('ch')) explainIfHidden(qp.get('ch'));
    const startCh = (wantCh && isVisible(wantCh)) ? wantCh : (forYou()[0] || bestStart());
    if (startCh) {
      // open the guide on the channel's own category so what's playing is visible
      if (!tabList().includes(startCh) && startCh.category !== 'byo') { S.tab = tabs().find((t) => t.list.includes(startCh)) ? tabs().find((t) => t.list.includes(startCh)).id : S.tab; renderTabs(); renderGuide(); }
      play(startCh, { list: tabList() });
      const rs = +qp.get('remind');
      if (rs && wantCh === startCh && rs > Date.now() && !hasReminder(startCh.id, rs) && progs(startCh).some((x) => x.s === rs)) setTimeout(() => toggleReminder(startCh, rs), 800);
      if (qp.get('ch') || qp.get('remind')) history.replaceState(null, '', location.pathname);
    }
    setInterval(() => { renderTimeline(); refreshGuideTimes(); }, 30000);
    setInterval(checkReminders, 20000); checkReminders();
    setTimeout(announcePicks, 4000);
    if (!S.profile) setTimeout(openProfile, 700); else focusGuide();
    registerSW(); initCast(); initPip();
    if (kids()) document.body.classList.add('kids');
    if (store.get('remotePaired', false) && !isMobile()) startRemoteHost();
  }

  // first-time start: a channel already confirmed working here, with a schedule, playable in the web player
  function bestStart() {
    const score = (c) => ((S.probes[c.id] || {}).ok ? 4 : 0) + (c.hasEpg ? 3 : 0) + (c.streams.some((s) => s.cors) ? 2 : 0) + (c.lang === 'eng' ? 1 : 0) - (c.streams[0] && c.streams[0].not247 ? 3 : 0);
    const v = visible().filter((c) => c.category !== 'news');
    return v.slice().sort((a, b) => score(b) - score(a))[0] || visible()[0];
  }
  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  }
  // a shared link opened somewhere the channel can't play: say why instead of silently showing something else
  function explainIfHidden(id) {
    const raw = (S.raw || []).find((x) => x.id === id);
    if (!raw) { setTimeout(() => toast("That channel isn't available any more. Here's what's on now."), 1500); return; }
    let why = null;
    if (!S.byId.has(id)) why = "can't play in this browser. Try the Android app or Safari.";
    else if (!regionOk(raw)) why = "isn't offered in " + countryName(S.country) + '.';
    else if (!langOk(raw)) why = 'is in ' + langName(raw.lang) + '. Add it with 🌐 to watch.';
    else if (isUnavailable(raw)) why = "isn't working where you are right now.";
    if (why) setTimeout(() => toast(esc(raw.name) + ' ' + esc(why) + " Here's what's on now instead.", null, 7000), 1500);
  }
  function tickClock() { $('#clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

  function neededLangs() {
    const s = new Set(S.langs.map(langKey));
    if (s.has('fil')) s.add('tgl');
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
  function isUnavailable(ch) { const t = S.unavail[ch.id]; return (!!t && t > Date.now()) || S.shared.has(ch.id); }
  // the language you actually hear: the channel's main audio track
  function langOk(ch) {
    if (ch.category === 'byo') return true;
    return S.langs.map(langKey).includes(langKey(ch.lang));
  }
  // offered where the viewer is: FAST channels list their countries; region-locked streams play in their home country
  function regionOk(ch) {
    if (ch.category === 'byo' || !S.country) return true;
    const cc = S.country;
    if (ch.regions && !ch.regions.map(normCountry).includes(cc)) return false;
    if (ch.streams && ch.streams.length && ch.streams.every((s) => s.geoBlocked) && normCountry(ch.country) !== cc) return false;
    if (ch.news === 'local' && normCountry(ch.country) !== cc) return false; // local news: only your own country's
    return true;
  }
  function isVisible(ch) { return !isUnavailable(ch) && langOk(ch) && regionOk(ch) && kidsOk(ch); }
  function visible() { return S.all.filter(isVisible); }
  function pruneExpired() {
    const now = Date.now(); let changed = false;
    for (const k in S.unavail) if (S.unavail[k] < now) { delete S.unavail[k]; changed = true; }
    for (const k in S.probes) if (S.probes[k].at + PROBE_TTL < now) { delete S.probes[k]; changed = true; }
    if (changed) { store.set('unavail', S.unavail); store.set('probes', S.probes); }
  }

  // ---------------------------------------------------------------- shared reports (anonymous)
  // Each device reports "played / didn't play" per channel (country comes from the network, nothing else
  // is sent). Channels several viewers in a country couldn't play are hidden for everyone there.
  const API = /\.pages\.dev$/.test(location.hostname) ? '/api' : 'https://webtv-hub.pages.dev/api';
  S.shared = new Set();
  async function loadSharedUnavailable() {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 3500);
      const j = await fetch(API + '/unavailable', { signal: ctrl.signal }).then((r) => r.json()); clearTimeout(t);
      (j.ids || []).forEach((id) => S.shared.add(id));
    } catch (e) { /* API not set up yet or offline: fine */ }
  }
  function report(ch, ok) {
    if (!ch || ch.category === 'byo') return;
    const day = Math.floor(Date.now() / 86400000), seen = store.get('reported', {});
    if (seen[ch.id] === day + ':' + ok) return;
    seen[ch.id] = day + ':' + ok; for (const k in seen) if (+String(seen[k]).split(':')[0] < day - 1) delete seen[k];
    store.set('reported', seen);
    try { fetch(API + '/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ch: ch.id, ok }), keepalive: true }).catch(() => {}); } catch (e) { /* ignore */ }
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
    // No popup: the count is shown quietly in More → About. Only the very first time ever do we explain it, once.
    S.hiddenCount = (S.hiddenCount || 0) + 1;
    if (!store.get('hidHintShown', false)) {
      clearTimeout(S.hideToastT);
      S.hideToastT = setTimeout(() => { store.set('hidHintShown', true); toast("Some channels don't play where you are, so we hide them for you. You'll find the count in More.", null, 6000, 'hidden'); }, 2500);
    }
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
        report(next, ok);
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
    // well-known stars even when nothing of theirs is on today
    const stars = (S.stars || []).filter((n) => !people.has(fold(n))).map((n, i) => ({ type: 'person', label: n, key: fold(n), n: Math.max(0, 3 - i / 1000), titles: [] }));
    suggestIndex = [...titles.values(), ...people.values(), ...chans, ...stars];
  }
  function loadStars() {
    if (S.stars || S.starsLoading) return;
    S.starsLoading = true;
    fetch('data/stars.json').then((r) => r.json()).then((j) => { S.stars = j.names || []; suggestIndex = null; }).catch(() => { S.starsLoading = false; });
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

  // ---------------------------------------------------------------- continue watching
  function addHistory(ch) {
    if (!ch || ch.category === 'byo') return;
    const h = store.get('history', []).filter((x) => x.id !== ch.id);
    h.unshift({ id: ch.id, at: Date.now() }); store.set('history', h.slice(0, 15));
  }
  function recent() { return store.get('history', []).map((x) => S.byId.get(x.id)).filter((c) => c && isVisible(c) && !(S.current && c.id === S.current.id)).slice(0, 12); }

  // ---------------------------------------------------------------- kids mode
  // Only kids & family animation channels; leaving needs the parent's PIN. (A soft lock: it lives in this browser.)
  const kids = () => !!(store.get('kids', null) || {}).on;
  function kidsOk(ch) { return !kids() || (ch.category === 'animations' && (ch.labels || []).some((l) => l === 'Kids' || l === 'Family')); }
  async function pinHash(pin) { const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('wth-kids:' + pin)); return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
  function openKids() {
    const k = store.get('kids', null);
    if (k && k.on) {
      openOverlay('<h2>Leave kids mode</h2><p>Enter the parent PIN.</p><input class="field" id="pin" data-focus data-autofocus inputmode="numeric" maxlength="6" type="password" autocomplete="off"><p class="small" id="pinMsg"></p>' +
        '<div class="panel-actions"><button class="btn" data-focus data-close>Cancel</button><button class="btn primary" data-focus id="pinGo">Unlock</button></div>');
      const go = async () => { if ((await pinHash($('#pin').value)) === k.pin) { store.set('kids', { on: false }); closeOverlay(); applyKids(); toast('Kids mode is off.', null, 2500); } else { $('#pinMsg').textContent = 'That PIN is not right.'; } };
      $('#pinGo').onclick = go; $('#pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      return;
    }
    openOverlay('<h2>Kids mode</h2><p>Shows only kids and family animation channels and hides everything else, including search and settings. Choose a 4-digit parent PIN; you\'ll need it to leave kids mode.</p>' +
      '<input class="field" id="pin" data-focus data-autofocus inputmode="numeric" maxlength="6" type="password" placeholder="PIN (4–6 digits)" autocomplete="off"><p class="small" id="pinMsg"></p>' +
      '<div class="panel-actions"><button class="btn" data-focus data-close>Cancel</button><button class="btn primary" data-focus id="pinGo">Turn on kids mode</button></div>');
    const go = async () => {
      const v = $('#pin').value.trim(); if (!/^\d{4,6}$/.test(v)) { $('#pinMsg').textContent = 'Use 4 to 6 digits.'; return; }
      store.set('kids', { on: true, pin: await pinHash(v) }); closeOverlay(); applyKids(); toast('🧒 Kids mode is on.', null, 3000);
    };
    $('#pinGo').onclick = go; $('#pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }
  function applyKids() {
    document.body.classList.toggle('kids', kids());
    S.tab = null; renderTabs(); renderGuide();
    if (S.current && !kidsOk(S.current)) { const c = tabList()[0]; if (c) play(c, { list: tabList() }); else { stopPlayback(); setMsg('No kids channels are available here right now.'); } }
  }

  // ---------------------------------------------------------------- sleep timer
  const SLEEP_STEPS = [0, 15, 30, 60, 90];
  S.sleepAt = 0;
  function cycleSleep() {
    const cur = S.sleepAt ? Math.round((S.sleepAt - Date.now()) / 60000) : 0;
    const next = SLEEP_STEPS.find((m) => m > cur + 1) || 0;
    S.sleepAt = next ? Date.now() + next * 60000 : 0;
    clearTimeout(S.sleepT);
    if (next) S.sleepT = setTimeout(sleepNow, next * 60000);
    const b = $('#sleepBtn'); b.classList.toggle('on', !!next); b.innerHTML = ic('moon') + (next ? '<span class="badge">' + next + '</span>' : '');
    toast(next ? '🌙 Sleep timer: TV turns off in ' + next + ' min.' : 'Sleep timer off.', null, 2500, 'sleep');
  }
  function sleepNow() {
    S.sleepAt = 0; const b = $('#sleepBtn'); b.classList.remove('on'); b.innerHTML = ic('moon');
    if (!S.paused) togglePause();
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    setMsg('🌙 Sleep timer ended. Press play to keep watching.');
  }

  // ---------------------------------------------------------------- picture-in-picture
  function initPip() {
    const ok = document.pictureInPictureEnabled || (video.webkitSupportsPresentationMode && typeof video.webkitSetPresentationMode === 'function');
    const b = $('#pipBtn'); if (b) b.hidden = !ok;
  }
  async function togglePip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (video.requestPictureInPicture) await video.requestPictureInPicture();
      else if (video.webkitSetPresentationMode) video.webkitSetPresentationMode(video.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
    } catch (e) { toast("Picture-in-picture isn't available for this channel.", null, 3000, 'pip'); }
  }

  // ---------------------------------------------------------------- tabs + guide
  function tabs() {
    const v = visible(); const t = [];
    if (kids()) { t.push({ id: 'kids', name: '🧒 Kids', list: v }); return t; }
    const fy = forYou(); if (fy.length) t.push({ id: 'foryou', name: 'For you', list: fy });
    const rc = recent(); if (rc.length) t.push({ id: 'recent', name: '⟲ Continue watching', list: rc });
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
  // With no saved choice, start on For you or the first category, not on short personal lists (Continue watching, Favorites).
  const defaultTab = (t) => t.find((x) => x.id === 'foryou' || x.id === 'kids') || t.find((x) => x.id !== 'recent' && x.id !== 'favs') || t[0];
  function tabList() { const t = tabs(); const cur = t.find((x) => x.id === S.tab) || defaultTab(t); return cur ? cur.list : []; }
  function renderTabs() {
    const t = tabs();
    // If the open tab vanished (e.g. Continue watching emptied once its only channel started playing),
    // switch tabs AND redraw the guide, so the list always matches the highlighted tab.
    if (!t.find((x) => x.id === S.tab)) { S.tab = defaultTab(t) ? defaultTab(t).id : null; if (S.tabRendered) queueMicrotask(renderGuide); }
    S.tabRendered = true;
    const langLabel = S.langs.map((l) => langName(l)).slice(0, 2).join(', ') + (S.langs.length > 2 ? ' +' + (S.langs.length - 2) : '');
    $('#tabs').innerHTML = t.map((x) => '<button class="tab' + (x.id === S.tab ? ' on' : '') + '" role="tab" data-focus data-tab="' + x.id + '">' + esc(x.name) + '<small>' + x.list.length + '</small></button>').join('') +
      '<button class="tab lang" data-focus data-action="langs">' + ic('globe') + ' ' + esc(langLabel) + '</button>' +
      '<button class="tab lang" data-focus data-action="location">' + ic('pin') + ' ' + esc(S.country ? countryName(S.country) : 'Location') + '</button>';
    requestAnimationFrame(() => { const on = $('#tabs .tab.on'); if (on && on.scrollIntoView && !isMobile()) { try { on.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* old browser */ } } updateTabArrows(); });
  }
  // Category row: scrolls sideways with a mouse wheel or trackpad, and shows arrows when there's more.
  function updateTabArrows() {
    const t = $('#tabs'); if (!t) return;
    const max = t.scrollWidth - t.clientWidth - 2;
    $('#tabsLeft').hidden = t.scrollLeft <= 2; $('#tabsRight').hidden = t.scrollLeft >= max;
  }
  (function initTabScroll() {
    const t = $('#tabs');
    t.addEventListener('wheel', (e) => {
      if (t.scrollWidth <= t.clientWidth) return;
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d) return;
      e.preventDefault(); t.scrollLeft += d * (e.deltaMode === 1 ? 30 : 1);
    }, { passive: false });
    t.addEventListener('scroll', updateTabArrows, { passive: true });
    window.addEventListener('resize', updateTabArrows);
    const page = (dir) => t.scrollBy({ left: dir * t.clientWidth * 0.8, behavior: 'smooth' });
    $('#tabsLeft').addEventListener('click', () => page(-1));
    $('#tabsRight').addEventListener('click', () => page(1));
  })();
  function setTab(id, keepFocus) {
    if (S.tab === id) return;
    S.tab = id; store.set('tab', id); renderTabs(); renderGuide(); notifyChange();
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
    const tags = S.favs.has(c.id) ? '<span class="tag">★</span>' : '';
    return '<button class="row' + (playing ? ' playing' : '') + '" data-focus data-ch="' + esc(c.id) + '"' + ((c.streams || []).some((x) => x.cors === true) ? '' : ' data-nocast') + '>' +
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
    S.current = ch; S.userPick = !!opts.user; S.paused = false; updateControls();
    if (opts.list && opts.list.length) S.list = opts.list;
    if (!S.list.includes(ch)) S.list = tabList().includes(ch) ? tabList() : visible().filter((c) => c.category === ch.category);
    if (!S.list.includes(ch)) S.list = [ch].concat(S.list);
    if (ch.category !== 'byo') store.set('last', ch.id);
    S.attempts = plan(ch, true); S.attempt = 0;
    renderNow(); renderTimeline(); refreshGuideTimes(); osd(); notifyChange();
    if (castConnected()) { stopPlayback(); castCurrent(); return; }
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
    if (S.current) { S.probes[S.current.id] = { ok: true, at: Date.now() }; store.set('probes', S.probes); report(S.current, true); addHistory(S.current); }
    setTimeout(startProber, 5000);
  });
  if (video.textTracks && video.textTracks.addEventListener) video.textTracks.addEventListener('addtrack', (e) => { if (e.track) e.track.mode = 'disabled'; });
  video.addEventListener('error', () => { if (!S.hls && video.getAttribute('src')) nextAttempt(); });
  video.addEventListener('waiting', () => { clearTimeout(S.stallTimer); S.stallTimer = setTimeout(() => { if (!S.paused && !video.paused && video.readyState < 3) { setMsg('Reconnecting…'); nextAttempt(); } }, 20000); });
  video.addEventListener('timeupdate', () => clearTimeout(S.stallTimer));

  /** A channel failed on this device: remove it everywhere, never leave it in the list. */
  function failChannel(why) {
    const ch = S.current; stopPlayback();
    const i = S.list.indexOf(ch);
    const next = S.list.slice(i + 1).concat(S.list.slice(0, Math.max(0, i))).find((c) => c !== ch && isVisible(c) && playable(c));
    markUnavailable(ch, 'play'); if (S.attempts.length) report(ch, false);
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

  // ---------------------------------------------------------------- pause / mute
  // Pausing live TV stops downloading (saves data); resuming jumps back to live, like a TV.
  S.paused = false;
  function togglePause() {
    if (!S.current) return;
    if (castConnected()) { castCmd('pause'); return; }
    if (!S.paused) {
      S.paused = true; video.pause(); if (S.hls) try { S.hls.stopLoad(); } catch (e) { /* ignore */ }
      toast('⏸ Paused. Press play to go back to live.', null, 2500, 'pause');
    } else {
      S.paused = false;
      if (S.hls) { try { S.hls.startLoad(-1); } catch (e) { /* ignore */ } }
      const jump = () => {
        try {
          if (S.hls && S.hls.liveSyncPosition) video.currentTime = S.hls.liveSyncPosition;
          else if (video.seekable && video.seekable.length) video.currentTime = Math.max(0, video.seekable.end(video.seekable.length - 1) - 3);
        } catch (e) { /* ignore */ }
        const p = video.play(); if (p && p.catch) p.catch(() => {});
      };
      jump(); toast('▶ Back to live', null, 1500, 'pause');
    }
    updateControls();
  }
  function toggleMute() {
    if (castConnected()) { castCmd('mute'); return; }
    if (video.muted) { unmuteFromUser(); } else { video.muted = true; }
    updateControls();
  }
  function unmuteFromUser() {
    S.interacted = true; video.muted = false; $('#unmute').hidden = true;
    const p = video.play(); if (p && p.catch) p.catch(() => {});
  }
  function updateControls() {
    const pb = $('#pauseBtn'), mb = $('#muteBtn');
    if (pb) { pb.innerHTML = ic(S.paused ? 'play' : 'pause'); pb.setAttribute('aria-label', S.paused ? 'Play (back to live)' : 'Pause'); pb.classList.toggle('on', S.paused); }
    if (mb) { mb.innerHTML = ic(video.muted ? 'mute' : 'vol'); mb.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute'); mb.classList.toggle('on', video.muted); }
  }
  video.addEventListener('volumechange', updateControls);

  function unmuteOnce() {
    if (S.interacted || remoteMode()) return; S.interacted = true; S.unmutedAt = Date.now();
    video.muted = false; $('#unmute').hidden = true;
    const p = video.play(); if (p && p.catch) p.catch(() => {});
  }
  $('#unmute').addEventListener('click', (e) => { e.stopPropagation(); unmuteOnce(); });
  // tap / click: unmute the first time, otherwise show the controls; double-tap / double-click: full screen
  // controls stay hidden until the screen is tapped; tap again (or wait) to hide them
  function showControls(ms) { const c = $('#pctl'); c.classList.add('show'); clearTimeout(S.pctlT); S.pctlT = setTimeout(() => c.classList.remove('show'), ms || 3500); }
  $('#player').addEventListener('click', (e) => {
    if (e.target.closest('#pctl')) { showControls(); return; } // keep them up while being used
    if (!S.interacted || Date.now() - (S.unmutedAt || 0) < 600) unmuteOnce();
    const c = $('#pctl');
    if (c.classList.contains('show')) { c.classList.remove('show'); clearTimeout(S.pctlT); } else showControls();
  });
  $('#player').addEventListener('mousemove', (e) => { if (e.pointerType !== 'touch' && !isMobile()) showControls(2500); });
  $('#player').addEventListener('dblclick', (e) => { if (e.target.closest('#pctl')) return; if (document.body.classList.contains('fs')) exitFs(); else enterFs(); });

  function renderNow() {
    const ch = S.current; if (!ch) return;
    $('#nowName').textContent = ch.name;
    const cat = S.categories.find((c) => c.id === ch.category);
    const bits = [cat ? cat.name : 'My playlist'];
    if (ch.lang && LANG_NAMES[ch.lang]) bits.push(langName(ch.lang));
    $('#nowMeta').innerHTML = esc(bits.join(' · ')) + (ch.labels || []).filter((t) => !cat || t !== cat.name).slice(0, 4).map((t) => ' <span class="tag">' + esc(t) + '</span>').join('') +
      (ch.desc ? '<div class="ch-desc">' + esc(ch.desc) + '</div>' : '');
    const logo = $('#nowLogo');
    if (ch.logo) { logo.src = ch.logo; logo.hidden = false; logo.onerror = () => { logo.hidden = true; }; } else logo.hidden = true;
    const fav = S.favs.has(ch.id); const fb = $('#favBtn');
    fb.innerHTML = ic(fav ? 'starOn' : 'star'); fb.classList.toggle('on', fav); fb.hidden = ch.category === 'byo';
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
    const remindBtn = (p) => { const on = hasReminder(ch.id, p.s); return '<div class="tl-actions"><button class="remind' + (on ? ' on' : '') + '" data-focus data-remind="' + p.s + '">' + (on ? '✓ Reminder set' : '🔔 Remind me') + '</button>' + shareBtn(p) + '</div>'; };
    const shareBtn = (p) => ch.category === 'byo' ? '' : '<button class="remind" data-focus data-share="' + p.s + '" aria-label="Share ' + esc(p.t) + '">↗ Share</button>';
    box.innerHTML =
      (prev ? '<div class="tl-seg past"><div class="tl-pill">Previous · ended ' + fmtTime(prev.e) + '</div><div class="tl-title">' + esc(prev.t) + '</div>' + sub(prev) + '</div>' : '<div class="tl-seg past none"><div class="tl-pill">Previous</div><div class="tl-sub">—</div></div>') +
      '<div class="tl-seg now"><div class="tl-pill">● Now playing</div><div class="tl-title">' + esc(now.t) + '</div>' + sub(now) + tags(now) +
        (now.d ? '<div class="tl-desc">' + esc(now.d) + '</div>' : '') +
        '<div class="tl-bar"><i style="width:' + pct.toFixed(1) + '%"></i></div><div class="tl-time">' + fmtTime(now.s) + ' – ' + fmtTime(now.e) + ' · ' + inMins(now.e - t) + ' left</div><div class="tl-actions">' + shareBtn(now) + '</div></div>' +
      (next ? '<div class="tl-seg next"><div class="tl-pill">Next · ' + fmtTime(next.s) + '</div><div class="tl-title">' + esc(next.t) + '</div>' + sub(next) + tags(next) + '<div class="tl-time">starts in ' + inMins(next.s - t) + '</div>' + remindBtn(next) + '</div>' : '<div class="tl-seg next"><div class="tl-pill">Up next</div><div class="tl-sub">Not listed yet</div></div>') +
      (later ? '<div class="tl-seg later"><div class="tl-pill">Later · ' + fmtTime(later.s) + '</div><div class="tl-title">' + esc(later.t) + '</div>' + sub(later) + remindBtn(later) + '</div>' : '<div class="tl-seg later"><div class="tl-pill">Later</div><div class="tl-sub">Not listed yet</div></div>');
    $$('[data-remind]', box).forEach((b) => b.addEventListener('click', () => toggleReminder(ch, +b.dataset.remind)));
    $$('[data-share]', box).forEach((b) => b.addEventListener('click', () => share(ch, list.find((x) => x.s === +b.dataset.share))));
    if (focusedRemind) { const b = $('[data-remind="' + focusedRemind + '"]', box); if (b) focusEl(b); }
  }

  // ---------------------------------------------------------------- reminders (while the app is open)
  const OFFSETS = [24 * 3600e3, 3600e3, 15 * 60e3, 0];
  // In the Android app, reminders are real phone notifications that fire even when the app is closed.
  const nativeNotes = () => (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) || null;
  const noteId = (chId, s, o) => { let h = 7; for (const ch of chId + s + o) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h) % 2000000000; };
  async function scheduleNative(r, cancel) {
    const LN = nativeNotes(); if (!LN) return;
    const ids = [3600e3, 15 * 60e3, 0].map((o) => ({ id: noteId(r.ch, r.s, o), o }));
    try {
      await LN.cancel({ notifications: ids.map((x) => ({ id: x.id })) });
      if (cancel) return;
      const perm = await LN.requestPermissions(); if (perm.display !== 'granted') return;
      await LN.schedule({ notifications: ids.filter((x) => r.s - x.o > Date.now()).map((x) => ({
        id: x.id, title: x.o ? r.t + ' starts in ' + mins(x.o) + ' min' : r.t + ' is starting now',
        body: 'On ' + r.name + ' · ' + fmtTime(r.s), schedule: { at: new Date(r.s - x.o), allowWhileIdle: true }, extra: { ch: r.ch },
      })) });
    } catch (e) { /* plugin unavailable */ }
  }
  function hasReminder(chId, s) { return S.reminders.some((r) => r.ch === chId && r.s === s); }
  function toggleReminder(ch, s) {
    const p = progs(ch).find((x) => x.s === s); if (!p) return;
    if (hasReminder(ch.id, s)) { S.reminders.filter((r) => r.ch === ch.id && r.s === s).forEach((r) => { scheduleNative(r, true); emailReminder(r, true); }); S.reminders = S.reminders.filter((r) => !(r.ch === ch.id && r.s === s)); toast('Reminder removed.', null, 2500); }
    else {
      S.reminders = S.reminders.filter((r) => r.s > Date.now() - 3600e3);
      if (S.reminders.length >= FREE_REMINDERS) { toast('You can keep up to ' + FREE_REMINDERS + ' reminders. Remove one in My TV to add another.'); return; }
      const rem = { ch: ch.id, name: ch.name, s: p.s, t: p.t, fired: OFFSETS.filter((o) => Date.now() >= p.s - o).map(String) };
      S.reminders.push(rem); scheduleNative(rem);
      if (emailToken()) emailReminder(rem);
      else if (EMAIL_ON && !nativeNotes() && !kids() && !S.emailOffered && (S.emailOffered = true)) setTimeout(() => toast('Want this reminder by email too?', { label: '📧 Email me', fn: () => openEmail(rem) }, 9000, 'emailoffer'), 1200);
      toast("We'll remind you about <b>" + esc(p.t) + '</b> at ' + fmtTime(p.s) + ' (also 1 hour and 15 minutes before)' + (nativeNotes() ? ', even when the app is closed.' : ' while this site is open. Get the Android app for notifications when it\'s closed.'));
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

  // ---------------------------------------------------------------- email reminders
  // Parked (2026-11-17): see docs/ROADMAP.md. Flip to true once a sender address is chosen and the
  // server's EMAIL_ENABLED variable is set.
  const EMAIL_ON = false;
  // Reminder emails never require marketing consent. Offers from our sister brands are a separate,
  // unticked choice (wording kept identical to cloudflare/functions/api/email/_email.js).
  const MARKETING_TEXT_HTML = 'Also send me occasional updates and offers from Web TV Hub and its sister brands: <a href="https://norvicka.pages.dev" target="_blank" rel="noopener">Norvicka Studio</a> (practical systems and automations for small businesses) and <a href="https://preview.pivory.pages.dev" target="_blank" rel="noopener">Pivory Systems</a> (ready-made, automated business systems). I can unsubscribe anytime.';
  const tzName = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return ''; } };
  function emailToken() { return EMAIL_ON ? store.get('emailToken', null) : null; }
  function reminderPayload(r) {
    const ch = S.byId.get(r.ch); const p = ch && progs(ch).find((x) => x.s === r.s);
    return { ch: r.ch, chName: r.name, title: r.t, start: r.s, url: ch ? shareUrl(ch, p) : undefined };
  }
  async function emailApi(path, method, body) {
    const r = await fetch(API + '/email/' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  }
  function emailReminder(r, remove) {
    const t = emailToken(); if (!t) return;
    const body = remove ? { token: t, ch: r.ch, start: r.s } : { token: t, reminder: reminderPayload(r) };
    emailApi('reminder', remove ? 'DELETE' : 'POST', body).then((j) => { if (j && j.resubscribe) store.set('emailToken', null); }).catch(() => {});
  }
  function openEmail(rem) {
    openOverlay('<h2>Email reminders</h2><p>We\'ll email you about an hour before the shows you set reminders for. Your address is used only for that, unless you choose otherwise below.</p>' +
      '<input class="field" id="em" data-focus type="email" inputmode="email" autocomplete="email" placeholder="you@example.com">' +
      '<label class="consent"><input type="checkbox" id="mk" data-focus> <span>' + MARKETING_TEXT_HTML + '</span></label>' +
      '<p class="small">Tapping the button means you agree to get reminder emails. We\'ll send a confirmation email first. <a href="privacy.html" target="_blank" rel="noopener">Privacy</a></p><p class="small" id="emMsg"></p>' +
      '<div class="panel-actions"><button class="btn" data-focus data-close>Not now</button><button class="btn primary" data-focus id="emGo">Email me reminders</button></div>');
    $('#emGo').onclick = async () => {
      const email = $('#em').value.trim(), msg = $('#emMsg');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg.textContent = 'Please check the email address.'; return; }
      $('#emGo').disabled = true; msg.textContent = 'Sending…';
      try {
        const j = await emailApi('subscribe', 'POST', { email, marketing: $('#mk').checked, tz: tzName(), token: emailToken(), reminder: rem ? reminderPayload(rem) : undefined });
        if (j.error) { msg.textContent = j.error; $('#emGo').disabled = false; return; }
        if (j.token) {
          store.set('emailToken', j.token);
          S.reminders.filter((r) => r !== rem && r.s > Date.now()).forEach((r) => emailReminder(r)); // reminders set earlier
        }
        closeOverlay();
        toast(j.confirmed ? '📧 Done. We\'ll email you about an hour before.' : '📧 Almost done: check your inbox and tap <b>Confirm my email</b> (from Web TV Hub). Reminders start after that.', null, 9000, 'email');
      } catch (e) { msg.textContent = "Couldn't reach Web TV Hub. Please try again in a moment."; $('#emGo').disabled = false; }
    };
  }

  async function renderEmailBox() {
    const box = $('#emailBox'); if (!box) return;
    const t = emailToken();
    const offer = () => { box.innerHTML = '<p>Get an email about an hour before the shows you set reminders for.</p><button class="btn small" data-focus id="emOpen">📧 Get reminders by email</button>'; $('#emOpen').onclick = () => openEmail(null); };
    if (!t) return offer();
    try {
      const j = await fetch(API + '/email/status?t=' + encodeURIComponent(t)).then((r) => r.json());
      if (!j.ok) { store.set('emailToken', null); return offer(); }
      const base = API + '/email/unsubscribe?t=' + encodeURIComponent(t);
      box.innerHTML = '<p>Sending to <b>' + esc(j.email) + '</b> · ' + (j.confirmed ? '✓ confirmed' : 'waiting for you to confirm (check your inbox)') + (j.marketing ? ' · offers on' : '') + '</p>' +
        '<div class="chips">' + (j.marketing ? '<a class="btn small" data-focus target="_blank" rel="noopener" href="' + esc(base + '&what=marketing') + '">Stop offers</a>' : '') +
        '<a class="btn small" data-focus target="_blank" rel="noopener" id="emStop" href="' + esc(base) + '">Stop all emails</a></div>';
      $('#emStop').addEventListener('click', () => store.set('emailToken', null));
    } catch (e) { box.innerHTML = '<p class="small">Email settings are unavailable right now.</p>'; }
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
    const m = /^<h2>([\s\S]*?)<\/h2>/.exec(html);
    if (m) html = '<div class="panel-head"><h2>' + m[1] + '</h2><button class="closex" data-focus data-close aria-label="Close">✕</button></div>' + html.slice(m[0].length);
    $('#toasts').innerHTML = ''; // nothing may cover what the dialog says (e.g. consent wording)
    $('#panel').innerHTML = html; $('#overlay').hidden = false; overlayClose = onClose || null;
    $$('#panel img').forEach(imgFallback);
    $$('#panel [data-close]').forEach((b) => b.addEventListener('click', closeOverlay));
    $('#panel').scrollTop = 0;
    // TV/desktop: put the remote's focus inside the dialog. Phones: no focus jump, no surprise keyboard.
    if (!isMobile()) setTimeout(() => focusEl($('#panel [data-autofocus]') || $('#panel [data-focus]')), 30);
  }
  $('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closeOverlay(); });
  function closeOverlay() {
    if ($('#overlay').hidden) return;
    $('#overlay').hidden = true; $('#panel').innerHTML = '';
    const f = overlayClose; overlayClose = null; if (f) f();
    setBottom('home'); focusGuide();
  }
  function setBottom(a) { $$('.bottombar button').forEach((b) => b.classList.toggle('on', b.dataset.action === a)); }
  function langCounts() {
    // count only channels you could actually watch where you are
    const counts = {}; S.all.filter((c) => regionOk(c) && !isUnavailable(c)).forEach((c) => { const k = langKey(c.lang); counts[k] = (counts[k] || 0) + 1; });
    const langs = Object.keys(counts).filter((k) => LANG_NAMES[k]).sort((a, b) => (a === 'eng' ? -1 : b === 'eng' ? 1 : counts[b] - counts[a]));
    return { counts, langs };
  }

  // Profile: languages, favorite shows/movies/stars, kinds of TV
  function openProfile() {
    setBottom('profile'); loadStars();
    const P = (S.profile && !S.profile.skipped) ? S.profile : { cats: {}, interests: [], eras: [], langs: S.langs, picks: [] };
    const draft = { picks: (P.picks || []).slice() };
    const { counts, langs } = langCounts();
    const chip = (group, val, label, on) => '<button class="chip' + (on ? ' on' : '') + '" data-focus data-group="' + group + '" data-val="' + esc(val) + '">' + esc(label) + '</button>';
    openOverlay(
      '<h2>' + (S.profile && !S.profile.skipped ? 'Your profile' : 'Welcome! Let\'s set up your TV') + '</h2>' +
      '<p>A few quick picks so the right channels come first. Everything here stays on this device. You can skip this.</p>' +
      '<h3>Favorite shows, movies or stars</h3><p class="small">Type a title or a name. Spelling doesn\'t have to be perfect. We\'ll show you when they\'re on.</p>' +
      '<input class="field" id="pickIn" data-focus placeholder="e.g. Frasier, Star Trek, Lucille Ball" autocomplete="off" autocapitalize="off" spellcheck="false"><div class="suggest" id="pickSug"></div><div class="chips" id="pickChips" style="margin-top:.6rem"></div>' +
      '<h3>Languages</h3><div class="chips">' + langs.map((l) => chip('lang', l, langName(l) + ' (' + counts[l] + ')', (P.langs || ['eng']).map(langKey).includes(l))).join('') + '</div>' +
      '<p class="small" style="margin-top:.8rem">📍 Showing channels available in <b>' + esc(S.country ? countryName(S.country) : 'your country') + '</b>. <a href="#" data-goloc>Change</a></p>' +
      '<h3>Kinds of TV you like</h3><div class="chips">' + S.categories.map((c) => chip('cat', c.id, c.name, ((P.cats || {})[c.id] || 0) > 0)).join('') + '</div>' +
      '<details class="more-prefs"' + ((P.interests || []).length || (P.eras || []).length ? ' open' : '') + '><summary data-focus tabindex="0">More preferences (optional)</summary>' +
      '<h3>Topics</h3><div class="chips">' + Object.keys(INTERESTS).map((k) => chip('int', k, k, (P.interests || []).includes(k))).join('') + '</div>' +
      '<h3>Era</h3><div class="chips">' + chip('era', 'classic', 'Classics (before 1990)', (P.eras || []).includes('classic')) + chip('era', 'y2k', '90s & 2000s', (P.eras || []).includes('y2k')) + chip('era', 'modern', 'Newer shows', (P.eras || []).includes('modern')) + '</div></details>' +
      '<h3>For families</h3><button class="btn small" data-focus data-action="kids">🧒 Turn on kids mode (with a parent PIN)</button>' +
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
    const typeLabel = (e) => e.type === 'person' ? (e.titles.length ? 'Star · in ' + e.titles.length + ' show' + (e.titles.length > 1 ? 's' : '') + ' on the schedule' : 'Star · we\'ll tell you when they\'re on') : e.type === 'channel' ? 'Channel' : (e.kind === 'movie' ? 'Movie' : 'Show') + ' · on the schedule';
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
    const gl = $('#panel [data-goloc]'); if (gl) gl.addEventListener('click', (e) => { e.preventDefault(); openLocation(); });
    const skip = $('[data-ob="skip"]'); if (skip) skip.onclick = () => { S.profile = { skipped: true, cats: {}, langs: ['eng'] }; store.set('profile', S.profile); closeOverlay(); };
    $('[data-ob="save"]').onclick = async () => {
      const on = (g) => $$('#panel .chip.on[data-group="' + g + '"]').map((b) => b.dataset.val);
      const cats = {}; on('cat').forEach((id) => { cats[id] = 1; });
      const langsSel = on('lang'); const pending = input.value.trim();
      if (pending.length >= 2) { const r = suggest(pending, 1); addPick(r[0] && r[0].s >= 0.75 ? r[0].e : null, pending); }
      S.profile = { cats, interests: on('int'), eras: on('era'), langs: langsSel.length ? langsSel : ['eng'], picks: draft.picks, skipped: false, updated: Date.now(), country: (S.profile && S.profile.country) || undefined };
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

  function openLocation() {
    const set = new Set(['PH', 'US', 'GB', 'CA', 'AU', 'NZ', 'IE', 'IN', 'SG', 'MY', 'DE', 'FR', 'ES', 'IT', 'NL', 'SE', 'NO', 'DK', 'BR', 'MX', 'AR', 'CL', 'KR', 'JP']);
    S.all.forEach((c) => { if (c.country && /^[A-Z]{2}$/.test(c.country)) set.add(normCountry(c.country)); (c.regions || []).forEach((r) => set.add(r)); });
    const list = [...set].map((cc) => ({ cc, name: countryName(cc) })).sort((x, y) => x.name.localeCompare(y.name));
    const auto = !(S.profile && S.profile.country);
    openOverlay('<h2>Your location</h2><p>Many channels are only offered in certain countries. We show the ones that can play where you are.' +
      (auto ? ' Detected automatically: <b>' + esc(S.country ? countryName(S.country) : 'unknown') + '</b>.' : '') + '</p>' +
      '<div class="chips"><button class="chip' + (auto ? ' on' : '') + '" data-focus data-cc="">📡 Detect automatically</button>' +
      list.map((x) => '<button class="chip' + (!auto && S.country === x.cc ? ' on' : '') + '" data-focus data-cc="' + x.cc + '">' + esc(x.name) + '</button>').join('') + '</div>');
    $$('#panel [data-cc]').forEach((b) => b.addEventListener('click', async () => {
      const cc = b.dataset.cc;
      S.profile = S.profile || { skipped: true, cats: {}, langs: S.langs };
      if (cc) { S.profile.country = cc; S.country = cc; } else { delete S.profile.country; S.country = (await detectCountry()) || countryFromTimezone(); }
      store.set('profile', S.profile); suggestIndex = null;
      closeOverlay(); renderTabs(); renderGuide();
      if (S.current && !isVisible(S.current)) { const c = bestStart(); if (c) play(c, { list: tabList() }); }
      toast('Showing channels available in <b>' + esc(countryName(S.country)) + '</b>.', null, 3000, 'loc');
    }));
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
      (isMobile() ? '<button class="btn primary" style="width:100%;margin-bottom:.4rem" data-focus data-action="remote">📱 Use this phone as a TV remote</button>' : '') +
      '<h3>Your picks on air (next 24 hours)</h3>' +
      (picks().length ? (onAir.length ? '<div class="list">' + onAir.map(li).join('') + '</div>' : '<p>None of your picks are on free TV in the next 24 hours.</p>') :
        '<p>Add favorite shows, movies or stars in your profile and we\'ll list when they\'re on.</p><button class="btn small" data-focus data-goprofile>Open profile</button>') +
      (other.length ? '<p class="small">📱 <b>' + other.map((p) => esc(p.label)).join(', ') + '</b> ' + (other.length > 1 ? 'are' : 'is') + ' on free TV soon, on channels that play on Android TV sticks, phones and Safari but not in this browser.</p>' : '') +
      (missing.length ? '<div class="wtw"><h3>Not on free TV right now</h3><p class="small">' + missing.map((p) => esc(p.label)).join(', ') + '</p>' +
        missing.slice(0, 2).map((p) => '<p class="small" style="margin-top:.8rem"><b>' + esc(p.label) + '</b></p>' + wtwButtons(p.label, wtwFor(p.label).list)).join('') + '</div>' : '') +
      '<h3>Reminders (' + rem.length + '/' + FREE_REMINDERS + ')</h3>' +
      (rem.length ? '<div class="list">' + rem.map((r) => '<button class="li" data-focus data-unrem="' + esc(r.ch) + '|' + r.s + '"><span class="when">' + fmtTime(r.s) + '</span><span class="what"><b>' + esc(r.t) + '</b><small>' + esc(r.name) + '</small></span><span class="small">Remove ✕</span></button>').join('') + '</div>' : '<p>No reminders yet. Use 🔔 Remind me on any upcoming show.</p>') +
      (EMAIL_ON ? '<h3>Email reminders</h3><div id="emailBox"><p class="small">Checking…</p></div>' : '') +
      '<h3>Favorite channels</h3>' +
      (favs.length ? '<div class="list">' + favs.map((c) => { const np = nowProg(c); return '<button class="li" data-focus data-play="' + esc(c.id) + '"><span class="when">' + (np ? '● NOW' : 'LIVE') + '</span><span class="what"><b>' + esc(c.name) + '</b><small>' + esc(np ? np.t : c.desc || '') + '</small></span><span class="small">Watch ▸</span></button>'; }).join('') + '</div>' : '<p>Tap ☆ next to a channel\'s name to add it here.</p>') +
      '<div class="panel-actions"><button class="btn" data-focus data-close data-autofocus>Close</button></div>');
    $$('#panel [data-play]').forEach((b) => b.addEventListener('click', () => {
      const c = S.byId.get(b.dataset.play); const s = +b.dataset.s;
      if (!c) return;
      if (s && s > Date.now()) { toggleReminder(c, s); openMyTv(); return; }
      closeOverlay(); play(c, { list: tabList(), user: true });
    }));
    $$('#panel [data-unrem]').forEach((b) => b.addEventListener('click', () => { const [ch, s] = b.dataset.unrem.split('|'); S.reminders.filter((r) => r.ch === ch && r.s === +s).forEach((r) => { scheduleNative(r, true); emailReminder(r, true); }); S.reminders = S.reminders.filter((r) => !(r.ch === ch && r.s === +s)); store.set('reminders', S.reminders); renderTimeline(); openMyTv(); }));
    const gp = $('#panel [data-goprofile]'); if (gp) gp.addEventListener('click', () => openProfile());
    renderEmailBox();
  }

  // Search with typo tolerance + "where to watch" for things that aren't on free TV
  // ---------------------------------------------------------------- where to watch (with the owner's affiliate links)
  // Data: data/where-to-watch.json, built from config/affiliates.json. Affiliate links are labelled and use rel="sponsored".
  const wtwServices = () => (S.wtw && Array.isArray(S.wtw.services) ? S.wtw.services : []).filter((x) => x.countries.includes('*') || (S.country && x.countries.includes(S.country)));
  function wtwLink(svc, q) {
    const dest = svc.url.split('{q}').join(encodeURIComponent(q || ''));
    if (!svc.wrap) return dest;
    return svc.wrap.includes('{url}') ? svc.wrap.split('{url}').join(encodeURIComponent(dest)) : svc.wrap;
  }
  /** Services for a search: ones known for it first, otherwise the general "Search on ..." ones. */
  function wtwFor(q) {
    const f = fold(q || ''); const here = wtwServices();
    const matched = f ? here.filter((x) => x.keywords.some((k) => { const fk = fold(k); return f.includes(fk) || (f.length > 3 && fk.includes(f)); })) : [];
    return { matched: matched.length > 0, list: (matched.length ? matched : here.filter((x) => x.suggest)).slice(0, 3) };
  }
  function justWatch(q) { return 'https://www.justwatch.com/' + (S.country || 'us').toLowerCase() + '/search?q=' + encodeURIComponent(q || ''); }
  function wtwButtons(q, list) {
    const btn = (href, label, svc) => '<a class="btn small" data-focus target="_blank" rel="' + (svc && svc.aff ? 'sponsored noopener' : 'noopener') + '"' + (svc ? ' data-out="' + esc(svc.id) + '"' : '') + ' href="' + esc(href) + '">' + esc(label) + ' ↗</a>';
    return list.map((x) => btn(wtwLink(x, q), x.url.includes('{q}') ? 'Search on ' + x.name : x.name, x)).join('') +
      btn(justWatch(q), 'Compare all services (JustWatch)', null) +
      (list.some((x) => x.aff) && S.wtw.disclosure ? '<p class="small aff-note">' + esc(S.wtw.disclosure) + '</p>' : '');
  }
  // anonymous click counts per service and country (no personal data), so the owner can see what's used
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[data-out]'); if (!a) return;
    try { navigator.sendBeacon(API + '/out', new Blob([JSON.stringify({ s: a.dataset.out })], { type: 'application/json' })); } catch (err) { /* ignore */ }
  }, true);

  function openSearch() {
    setBottom('search'); loadStars();
    openOverlay('<h2>Search</h2><p>Channels, shows, movies and stars. Typos are OK.</p><input class="field" id="q" data-focus data-autofocus placeholder="Try: frasier, star trek, cartoons, NBA" autocomplete="off" autocapitalize="off" spellcheck="false"><div id="sr" class="results"></div>' +
      '<div class="panel-actions"><button class="btn" data-focus data-close>Close</button></div>');
    const q = $('#q'); let t = null;
    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => runSearch(q.value), 200); });
    try { q.focus({ preventScroll: true }); } catch (e) { /* ignore */ } // search is the one dialog where opening the keyboard right away helps on phones too
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
    const w = wtwFor(q);
    // don't "correct" a title the viewer typed exactly right just because it's on a paid service
    const exactPaid = w.matched && wtwServices().some((x) => x.keywords.some((k) => fold(k) === f));
    if (!exactPaid && res[0] && res[0].s < 0.97 && fold(res[0].e.label) !== f) html += '<p class="small">Showing results for <b>' + esc(res[0].e.label) + '</b></p>';
    if (w.matched || uniq.length === 0) {
      html += '<div class="wtw"><h3>Where to watch officially</h3><p class="small">' + (uniq.length ? 'Also available on paid services:' : "We couldn't find this on free TV right now. You can watch it legally here:") + '</p>' + wtwButtons(q, w.list) + '</div>';
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
    setBottom('more');
    const url = location.origin + location.pathname;
    openOverlay('<h2>More</h2>' +
      '<h3>Open on another screen</h3><div style="display:flex;gap:1.4rem;align-items:center;flex-wrap:wrap"><div class="qr" id="qr"></div><div style="flex:1;min-width:14rem"><p>Scan with your phone camera, or type this address into your TV\'s browser (TV Bro, BrowseHere, Silk):</p><div class="bigurl">' + esc(url.replace(/^https:\/\//, '')) + '</div><p class="small">On a TV stick, bookmark it so it\'s one click next time.</p></div></div>' +
      '<h3>Android app</h3><p>Same TV, plus reminders that pop up even when the app is closed, and works as a remote for your TV.</p><a class="btn primary" data-focus href="download.html">Get the Android app</a>' +
      '<h3>Install as an app</h3><p>' + (installPrompt ? 'Add Web TV Hub to your home screen. It opens full screen like a regular app.' : 'On a phone, open your browser\'s menu and choose “Add to Home screen”. It opens full screen like a regular app.') + '</p>' + (installPrompt ? '<button class="btn primary" data-focus data-install>Install app</button>' : '') +
      '<h3>My playlist</h3><p>Add one .m3u playlist link of your own. It\'s saved only in this browser and never sent to us. Links must start with https:// and the server must allow web players.</p>' +
      '<input class="field" id="m3u" data-focus placeholder="https://example.com/my-playlist.m3u" value="' + esc(S.byo ? S.byo.url : '') + '"><p class="small" id="m3uMsg">' + (S.byo ? S.byo.channels.length + ' channels loaded.' : '') + '</p>' +
      '<div class="chips">' + (S.byo ? '<button class="btn small" data-focus data-m3u="remove">Remove playlist</button>' : '') + '<button class="btn small" data-focus data-m3u="save">Load playlist</button></div>' +
      '<h3>About</h3><p>A free guide to live channels that broadcasters already stream for free. We check every channel every 6 hours, and your device double-checks the ones you can see, so channels that don\'t work for you are removed automatically.</p>' +
      '<p>We don\'t host or re-stream any video. Channel data comes from the open <a href="https://github.com/iptv-org/iptv" target="_blank" rel="noopener">iptv-org</a> project; schedules and channel descriptions from public listings of free ad-supported services; cast information from <a href="https://www.wikidata.org" target="_blank" rel="noopener">Wikidata</a>.</p>' +
      '<p>To keep the guide honest, your device anonymously reports whether channels play (just the channel and works / doesn\'t work; your country comes from your network). Channels several viewers in a country can\'t play are hidden for everyone there. Nothing else is collected.</p>' +
      '<p class="links"><a href="download.html">Android app</a> · <a href="privacy.html" target="_blank" rel="noopener">Privacy</a> · <a href="terms.html" target="_blank" rel="noopener">Terms &amp; disclaimer</a></p>' +
      '<p>Rights-holder and want a channel removed? <a href="https://github.com/francis-h-francisco/web-tv-hub/issues/new?title=Removal%20request" target="_blank" rel="noopener">Open a removal request</a>.</p>' +
      '<p class="small">Channel list checked ' + esc(relTime(S.generated)) + '.' + (S.hiddenCount ? ' ' + S.hiddenCount + ' channel' + (S.hiddenCount > 1 ? 's were' : ' was') + " hidden this visit because " + (S.hiddenCount > 1 ? "they don't" : "it doesn't") + ' play where you are.' : '') + (S.hiddenForBrowser ? ' ' + S.hiddenForBrowser + ' more free channels play on Android TV sticks, phones and Safari but not in this browser.' : '') + '</p>' +
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
  const remoteMode = () => document.body.classList.contains('remote-mode');
  document.addEventListener('click', (e) => {
    if (remoteMode()) return;
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
    if (kids() && ['search', 'profile', 'more', 'langs', 'location', 'mytv', 'sharech'].includes(a)) { openKids(); return; }
    if (a === 'search') openSearch();
    else if (a === 'mytv') openMyTv();
    else if (a === 'profile') openProfile();
    else if (a === 'more') openMore();
    else if (a === 'langs') openLangs();
    else if (a === 'location') openLocation();
    else if (a === 'remote') openRemote();
    else if (a === 'home') { closeOverlay(); setBottom('home'); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    else if (a === 'fullscreen') enterFs();
    else if (a === 'sharech' && S.current) share(S.current, null);
    else if (a === 'pause') togglePause();
    else if (a === 'cast') castClick();
    else if (a === 'sleep') cycleSleep();
    else if (a === 'pip') togglePip();
    else if (a === 'kids') openKids();
    else if (a === 'mute') toggleMute();
    else if (a === 'fav' && S.current) {
      const id = S.current.id;
      if (S.favs.has(id)) S.favs.delete(id); else { S.favs.add(id); toast('Added <b>' + esc(S.current.name) + '</b> to Favorites.', null, 3000); }
      store.set('favs', [...S.favs]); renderNow(); renderTabs(); refreshGuideTimes();
    }
  });
  document.addEventListener('focusin', (e) => {
    if (remoteMode()) return;
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
    if (remoteMode()) return;
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
    if (!inField && (k === ' ' && !(e.target.closest && e.target.closest('button')) || k === 'k' || k === 'MediaPlayPause' || k === 'MediaPause' || k === 'MediaPlay')) { e.preventDefault(); togglePause(); return; }
    if (!inField && (k === 'm' || k === 'AudioVolumeMute')) { e.preventDefault(); toggleMute(); return; }
    const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[k];
    if (dir) {
      if (inField && (dir === 'left' || dir === 'right')) return;
      e.preventDefault(); move(dir);
    }
  });
  document.addEventListener('pointerdown', () => { if (!S.interacted) unmuteOnce(); }, { once: true });
  // remote/keyboard users get a visible focus ring; touch and mouse users don't
  document.addEventListener('keydown', (e) => { if (/^Arrow|^Enter$|^Tab$/.test(e.key) && !document.body.classList.contains('kbd')) document.body.classList.add('kbd'); }, true);
  document.addEventListener('pointerdown', () => document.body.classList.remove('kbd'), true);

  // ---------------------------------------------------------------- Chromecast
  // Uses Google's default Cast receiver, which loads the stream itself, so only streams that allow
  // other sites to read them (CORS) can be cast. The button only appears where casting is available.
  // Two ways to cast, same buttons: Chrome's web Cast SDK, or the Android app's native Cast (WthCast plugin,
  // Google's official Cast SDK). While casting, the phone shows a remote: channels, pause, volume, stop.
  const castState = { ctx: null, session: null, native: null, n: null, muted: false };
  const castConnected = () => !!castState.session || !!(castState.n && castState.n.state === 'connected');
  const castDevice = () => (castState.session ? castState.session.getCastDevice().friendlyName : (castState.n && castState.n.device) || 'your TV');
  function showCastButtons(on) {
    const b = $('#castBtn'); if (b) b.hidden = !on;
    const t = $('#castTop'); if (t) { t.hidden = !on; t.classList.toggle('on', castConnected()); t.innerHTML = ic('cast') + (castConnected() ? ' Casting' : ''); t.setAttribute('aria-label', castConnected() ? 'Casting to ' + castDevice() + '. Tap for options' : 'Cast to a TV'); }
  }
  function initCast() {
    const P = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.WthCast;
    if (P) {
      P.initialize().then((st) => {
        if (!st || !st.available) return;
        castState.native = P; onNativeState(st);
        P.addListener('state', onNativeState);
      }).catch(() => {});
      return;
    }
    if (!/Chrome|CriOS/.test(UA) || /Edg|OPR/.test(UA) || window.Capacitor) return;
    window.__onGCastApiAvailable = (ok) => {
      if (!ok || !window.cast || !cast.framework) return;
      const ctx = cast.framework.CastContext.getInstance();
      ctx.setOptions({ receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID, autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED });
      castState.ctx = ctx;
      showCastButtons(true);
      ctx.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, (ev) => {
        const st = ev.sessionState, SS = cast.framework.SessionState;
        if (st === SS.SESSION_STARTED || st === SS.SESSION_RESUMED) { castState.session = ctx.getCurrentSession(); castCurrent(); }
        if (st === SS.SESSION_ENDED) { castState.session = null; castEnded(); }
      });
    };
    const s = document.createElement('script'); s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1'; s.async = true; document.head.appendChild(s);
  }
  function onNativeState(st) {
    const was = castConnected();
    castState.n = st;
    showCastButtons(st.state !== 'no_devices' && st.state !== 'unavailable');
    const now = castConnected();
    if (now && !was) castCurrent();
    else if (!now && was) castEnded();
    if (now) {
      castState.muted = !!st.muted;
      S.paused = st.player === 'paused';
      if (st.error && !castState.errShown) { castState.errShown = true; toast((S.current ? esc(S.current.name) : 'This channel') + " didn't start on your TV. Try another channel.", null, 4500, 'cast'); }
      renderCastbar();
    }
  }
  function castable(ch) { return ch && (ch.streams || []).find((s) => s.cors === true); }
  async function castClick() {
    if (castState.native) { castState.native.showPicker().catch(() => {}); return; }
    if (!castState.ctx) return;
    if (!castable(S.current)) { toast("This channel can't be sent to a Chromecast. Most other channels can.", null, 4000, 'cast'); return; }
    if (castState.session) { castCurrent(); return; }
    try { await castState.ctx.requestSession(); } catch (e) { /* user closed the device picker */ }
  }
  function castCurrent() {
    const ch = S.current; if (!ch || !castConnected()) return;
    const s = castable(ch);
    if (!s) { renderCastbar(esc(ch.name) + " can't be cast. Pick another channel and your TV will play it."); toast(esc(ch.name) + " can't be cast. Pick another channel to send it to your TV.", null, 4000, 'cast'); return; }
    const np = nowProg(ch);
    const ok = () => { stopPlayback(); S.paused = false; castState.errShown = false; renderCastbar(); };
    const fail = () => toast("Your TV couldn't play " + esc(ch.name) + '. Try another channel.', null, 4000, 'cast');
    if (castState.native) {
      castState.native.load({ url: s.url, title: np ? np.t : ch.name, subtitle: ch.name, image: ch.logo || '' }).then(ok, fail);
      return;
    }
    const sess = castState.session;
    const info = new chrome.cast.media.MediaInfo(s.url, 'application/x-mpegURL');
    info.streamType = chrome.cast.media.StreamType.LIVE;
    const md = new chrome.cast.media.GenericMediaMetadata();
    md.title = np ? np.t : ch.name; md.subtitle = ch.name;
    if (ch.logo) md.images = [new chrome.cast.Image(ch.logo)];
    info.metadata = md;
    const req = new chrome.cast.media.LoadRequest(info); req.autoplay = true;
    sess.loadMedia(req).then(ok, fail);
  }
  function castEnded() {
    $('#castbar').hidden = true; document.body.classList.remove('casting'); showCastButtons(!!(castState.native || castState.ctx));
    setMsg(''); S.paused = false; updateControls();
    if (S.current) { toast('📱 Back to watching on this screen.', null, 2500, 'cast'); play(S.current, { list: S.list }); }
  }
  function renderCastbar(note) {
    if (!castConnected()) return;
    document.body.classList.add('casting'); showCastButtons(true);
    $('#castbar').hidden = false;
    $('#cbDev').innerHTML = ic('cast') + ' Playing on ' + esc(castDevice());
    const ch = S.current, np = ch && nowProg(ch);
    $('#cbWhat').innerHTML = note || (ch ? '<b>' + esc(ch.name) + '</b>' + (np ? ' · ' + esc(np.t) : '') : '');
    $('#cbPause').innerHTML = ic(S.paused ? 'play' : 'pause'); $('#cbPause').setAttribute('aria-label', S.paused ? 'Play' : 'Pause');
    $('#cbMute').classList.toggle('on', castState.muted);
  }
  function castCmd(k) {
    const P = castState.native, sess = castState.session;
    const media = sess && sess.getMediaSession && sess.getMediaSession();
    if (k === 'prev') zap(-1);
    else if (k === 'next') zap(1);
    else if (k === 'stop') { if (P) P.stop(); else if (castState.ctx) castState.ctx.endCurrentSession(true); }
    else if (k === 'pause') {
      S.paused = !S.paused;
      if (P) (S.paused ? P.pause() : P.play()).catch(() => {});
      else if (media) S.paused ? media.pause(null, () => {}, () => {}) : media.play(null, () => {}, () => {});
      renderCastbar();
    } else if (k === 'mute') {
      castState.muted = !castState.muted;
      if (P) P.setMuted({ muted: castState.muted }).catch(() => {}); else if (sess) sess.setMute(castState.muted);
      renderCastbar();
    } else if (k === 'volup' || k === 'voldown') {
      const d = k === 'volup' ? 0.1 : -0.1;
      if (P) P.changeVolume({ delta: d }).catch(() => {});
      else if (sess) sess.setVolume(Math.max(0, Math.min(1, sess.getVolume() + d)));
    }
  }
  // the remote covers the player: its taps must not toggle full screen or the player controls
  $('#castbar').addEventListener('click', (e) => { e.stopPropagation(); const b = e.target.closest('[data-cb]'); if (b) castCmd(b.dataset.cb); });
  $('#castbar').addEventListener('dblclick', (e) => e.stopPropagation());

  // ---------------------------------------------------------------- share (rich-preview links)
  const SITE = location.origin + location.pathname.replace(/[^/]*$/, '');
  const slug = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, '_');
  function shareUrl(ch, p) {
    // show pages exist for shows on now or starting within ~9 h of the last refresh; otherwise share the channel
    const gen = S.generated ? new Date(S.generated).getTime() : Date.now();
    if (p && p.s < gen + 9 * 3600e3) return SITE + 's/' + slug(ch.id) + '/' + Math.round(p.s / 60000) + '.html';
    return SITE + 's/' + slug(ch.id) + '.html';
  }
  async function share(ch, p) {
    if (!ch || ch.category === 'byo') return;
    const url = shareUrl(ch, p);
    const live = p && p.s <= Date.now();
    const text = p ? (live ? 'Watching ' + p.t + ' on ' + ch.name + ', free on Web TV Hub' : p.t + ' is on ' + ch.name + ' at ' + fmtTime(p.s) + ', free on Web TV Hub') : ch.name + ' is free on Web TV Hub';
    if (navigator.share && isMobile()) { try { await navigator.share({ title: p ? p.t : ch.name, text, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
    const enc = encodeURIComponent, u = enc(url), tx = enc(text);
    openOverlay('<h2>Share</h2><p>' + esc(p ? p.t + ' · ' + ch.name : ch.name) + (p ? '<br><span class="small">' + (live ? 'On now' : 'Starts ' + fmtTime(p.s)) + '. The link shows a preview card and stops working after the show ends.</span>' : '') + '</p>' +
      '<input class="field" id="shareUrl" readonly value="' + esc(url) + '">' +
      '<div class="chips" style="margin-top:.8rem"><button class="btn primary" data-focus data-autofocus id="copyLink">Copy link</button>' +
      '<a class="btn" data-focus target="_blank" rel="noopener" href="https://www.facebook.com/sharer/sharer.php?u=' + u + '">Facebook</a>' +
      '<a class="btn" data-focus target="_blank" rel="noopener" href="https://wa.me/?text=' + enc(text + ' ' + url) + '">WhatsApp</a>' +
      '<a class="btn" data-focus target="_blank" rel="noopener" href="https://x.com/intent/post?text=' + tx + '&url=' + u + '">X</a>' +
      '<a class="btn" data-focus target="_blank" rel="noopener" href="https://t.me/share/url?url=' + u + '&text=' + tx + '">Telegram</a>' +
      '<a class="btn" data-focus href="viber://forward?text=' + enc(text + ' ' + url) + '">Viber</a>' +
      '<a class="btn" data-focus href="mailto:?subject=' + enc(p ? p.t : ch.name) + '&body=' + enc(text + '\n' + url) + '">Email</a></div>');
    $('#copyLink').onclick = async () => {
      try { await navigator.clipboard.writeText(url); } catch (e) { const f = $('#shareUrl'); f.select(); document.execCommand && document.execCommand('copy'); }
      $('#copyLink').textContent = '✓ Copied';
    };
  }

  // ---------------------------------------------------------------- phone remote (TV side)
  const changeListeners = new Set();
  function notifyChange() { changeListeners.forEach((f) => { try { f(); } catch (e) { /* ignore */ } }); }
  function remoteState() {
    const c = S.current; const np = nowProg(c), nx = nextProg(c);
    return {
      ch: c ? { id: c.id, name: c.name, logo: c.logo || null } : null,
      now: np ? { t: np.t, s: np.s, e: np.e } : null, next: nx ? { t: nx.t, s: nx.s } : null,
      tab: S.tab, tabs: tabs().map((t) => ({ id: t.id, name: t.name })),
      list: tabList().slice(0, 80).map((x) => { const p = nowProg(x); return { id: x.id, name: x.name, now: p ? p.t : '' }; }),
      muted: video.muted, vol: video.volume,
    };
  }
  function remoteKey(k) {
    const fs = document.body.classList.contains('fs');
    if (k === 'up' || k === 'down' || k === 'left' || k === 'right') {
      if (fs && $('#overlay').hidden) { if (k === 'up') zap(-1); else if (k === 'down') zap(1); else osd(); return; }
      move(k); return;
    }
    if (k === 'ok') {
      if (fs) { osd(); return; }
      const ae = document.activeElement;
      if (ae && ae.id === 'player') { enterFs(); return; }
      if (ae && ae !== document.body && ae.click) ae.click(); else focusGuide();
      return;
    }
    if (k === 'back') { back(); return; }
    if (k === 'chup') { zap(-1); return; }
    if (k === 'chdown') { zap(1); return; }
    if (k === 'fs') { if (fs) exitFs(); else enterFs(); return; }
    if (k === 'volup' || k === 'voldown') { video.volume = Math.max(0, Math.min(1, video.volume + (k === 'volup' ? 0.1 : -0.1))); unmuteFromRemote(); toast('🔊 ' + Math.round(video.volume * 100) + '%', null, 1200, 'vol'); return; }
    if (k === 'mute') { if (video.muted) unmuteFromRemote(); else { video.muted = true; toast('🔇 Muted', null, 1200, 'vol'); } }
    if (k === 'pause') togglePause();
  }
  function unmuteFromRemote() {
    if (!video.muted) return;
    video.muted = false; S.interacted = true; $('#unmute').hidden = true;
    const p = video.play();
    if (p && p.catch) p.catch(() => { video.muted = true; video.play().catch(() => {}); toast('To allow sound, press any button on the TV remote (or click the TV screen) once.', null, 6000, 'vol'); });
  }
  window.WTH = {
    state: remoteState, key: remoteKey, onChange: (f) => changeListeners.add(f),
    play: (id) => { const c = S.byId.get(id); if (c) play(c, { list: tabList(), user: true }); },
    setTab: (id) => setTab(id), toast: (m) => toast(esc(m), null, 3500, 'remote'),
  };
  async function startRemoteHost() {
    if (!window.WTHRemote) await loadScript('remote.js');
    return window.WTHRemote.startHost(window.WTH);
  }
  async function openRemote() {
    if (isMobile()) { location.href = location.pathname + '?remote='; return; } // phone: become the remote
    openOverlay('<h2>Phone remote</h2><p>Control this TV from your phone. No account or app needed.</p>' +
      '<div style="display:flex;gap:1.6rem;align-items:center;flex-wrap:wrap"><div class="qr" id="qr"></div><div style="flex:1;min-width:16rem">' +
      '<p>1. Open your phone camera and scan the code.<br>2. Or on your phone open <b>' + esc((location.host + location.pathname).replace(/\/$/, '')) + '</b> → My TV → Use as remote, and type:</p>' +
      '<div class="bigcode" id="rcCode">······</div><p class="small" id="rcStatus">Starting…</p>' +
      '<button class="btn small" data-focus id="rcNew">New code</button></div></div>');
    store.set('remotePaired', true);
    try {
      const h = await startRemoteHost();
      const show = () => {
        const code = window.WTHRemote.host.code; const el = $('#rcCode'); if (!el) return;
        el.textContent = code; drawQr(location.origin + location.pathname + '?remote=' + code);
        const st = $('#rcStatus'); if (st) st.textContent = { starting: 'Starting…', waiting: 'Waiting for your phone…', connected: '✅ Phone connected', error: 'Remote service unavailable right now. Try “New code”.' }[h.status] || '';
      };
      h.listeners.add(show); show();
      $('#rcNew').onclick = async () => { await window.WTHRemote.newHostCode(window.WTH); show(); };
    } catch (e) { const st = $('#rcStatus'); if (st) st.textContent = 'Remote unavailable: ' + e.message; }
  }

  // ---------------------------------------------------------------- installable app (offline shell)
  if (nativeNotes()) { try { nativeNotes().addListener('localNotificationActionPerformed', (ev) => { const id = ev && ev.notification && ev.notification.extra && ev.notification.extra.ch; const c = id && S.byId.get(id); if (c) play(c, { list: tabList(), user: true }); }); } catch (e) { /* ignore */ } }
  function registerSW() {
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  boot();
})();
