/* Web TV Hub — lean-back TV web app. No build step, no framework, works in TV browsers. */
(function () {
  'use strict';

  // ---------- storage (all personal data stays in this browser) ----------
  const LS = 'wth.';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } },
  };

  const FREE_REMINDERS = 3;
  const BAD_TTL = 24 * 3600e3;
  const START_TIMEOUT = 15000;
  const INTERESTS = {
    'Action': ['action', 'thriller', 'adventure', 'hero'],
    'Comedy': ['comedy', 'sitcom', 'funny', 'laugh'],
    'Crime & mystery': ['crime', 'mystery', 'detective', 'csi', 'court', 'cops'],
    'Reality & competition': ['reality', 'competition', 'game show', 'survivor'],
    'Anime': ['anime'],
    'Cartoons & kids': ['kids', 'cartoon', 'animation', 'junior', 'toon'],
    'Documentary & history': ['documentary', 'history', 'nature', 'science', 'wild'],
    'Motorsport': ['racing', 'motor', 'f1', 'rally', 'nascar', 'nhra'],
    'Combat sports': ['mma', 'boxing', 'fight', 'combat', 'kickboxing', 'wrestling', 'ufc'],
    'Football': ['football', 'soccer', 'fifa', 'madrid', 'goal'],
    'Basketball': ['basketball', 'nba', 'hoops'],
    'Sci-fi': ['sci-fi', 'star trek', 'space', 'alien'],
    'Westerns': ['western', 'cowboy'],
    'Food & travel': ['food', 'cooking', 'kitchen', 'travel'],
  };
  const ERAS = { classic: ['classic', 'retro', 'vintage', 'golden', 'oldies', '70s', '80s'], y2k: ['90s', '2000s', 'throwback'], modern: [] };

  // ---------- state ----------
  const S = {
    categories: [], channels: [], byId: new Map(), epg: {}, wtw: [],
    current: null, list: [], hls: null, attempt: 0, startTimer: null,
    favs: new Set(store.get('favs', [])),
    reminders: store.get('reminders', []),
    profile: store.get('profile', null),
    bad: store.get('bad', {}),
    byo: store.get('byo', null),
    interacted: false,
  };

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const video = $('#video');
  const NATIVE_HLS = !!video.canPlayType('application/vnd.apple.mpegurl');
  const HLSJS = !!(window.Hls && window.Hls.isSupported());
  // Streams without CORS (most Pluto TV / FAST redirects) only play in the browser's own HLS player.
  // Desktop Chrome/Edge/Firefox expose one but it can't handle their separate audio tracks, so we only
  // trust built-in HLS on Safari, Android (TV sticks, phones), webOS, Tizen and Fire TV.
  const UA = navigator.userAgent;
  const NATIVE_RELIABLE = NATIVE_HLS && (/Android|iPhone|iPad|Web0S|webOS|Tizen|SMART-TV|AFT|CrKey/i.test(UA) ||
    (/Macintosh/.test(UA) && /Safari/.test(UA) && !/Chrome|Chromium|Edg|Firefox/.test(UA)));

  // ---------- boot ----------
  async function boot() {
    tickClock(); setInterval(tickClock, 15000);
    try {
      const [c, e, w] = await Promise.all([
        fetch('data/channels.json').then((r) => r.json()),
        fetch('data/epg.json').then((r) => r.json()).catch(() => ({ epg: {} })),
        fetch('data/where-to-watch.json').then((r) => r.json()).catch(() => []),
      ]);
      S.categories = c.categories; S.epg = e.epg || {}; S.wtw = w;
      S.channels = c.channels.filter(playable);
      S.hidden = c.channels.length - S.channels.length;
      S.channels.forEach((ch) => S.byId.set(ch.id, ch));
      $('#updated').textContent = 'Channel list checked ' + relTime(c.generated) + ' · ' + S.channels.length + ' channels' +
        (S.hidden ? ' · ' + S.hidden + ' more free channels play on Android TV sticks, phones and Safari but not in this browser' : '');
    } catch (err) {
      $('#nowName').textContent = 'Could not load channels';
      $('#nowMeta').textContent = 'Check your connection and reload.';
      return;
    }
    loadByo();
    renderRows();
    const want = new URLSearchParams(location.search).get('ch') || store.get('last', null);
    const first = S.byId.get(want) || forYou()[0] || S.channels[0];
    if (first) play(first, { list: listFor(first) });
    setInterval(() => { renderEpg(); renderNowProg(); refreshCardsNow(); }, 30000);
    setInterval(checkReminders, 20000); checkReminders();
    if (!S.profile) setTimeout(openOnboarding, 600);
    else focusFirst();
  }

  function tickClock() { $('#clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function relTime(iso) {
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    return h < 48 ? h + ' h ago' : Math.round(h / 24) + ' days ago';
  }

  // ---------- EPG helpers ----------
  function progs(ch) { return (ch && S.epg[ch.id]) || []; }
  function nowIndex(list, t) { t = t || Date.now(); return list.findIndex((p) => p.s <= t && p.e > t); }
  function nowProg(ch) { const l = progs(ch); const i = nowIndex(l); return i >= 0 ? l[i] : null; }

  // ---------- personalization ----------
  function textOf(ch) {
    const p = progs(ch).filter((x) => x.e > Date.now()).slice(0, 4).map((x) => x.t + ' ' + (x.d || '')).join(' ');
    return (ch.name + ' ' + (ch.tags || []).join(' ') + ' ' + p).toLowerCase();
  }
  function scoreFor(ch) {
    const P = S.profile; if (!P || P.skipped) return S.favs.has(ch.id) ? 5 : 0;
    let s = (P.cats[ch.category] || 0) * 3;
    if (P.ph && ch.country === 'PH') s += 4;
    const txt = textOf(ch);
    for (const name of P.interests || []) for (const kw of INTERESTS[name] || []) if (txt.includes(kw)) { s += 2; break; }
    for (const era of P.eras || []) for (const kw of ERAS[era] || []) if (txt.includes(kw)) { s += 1.5; break; }
    if (S.favs.has(ch.id)) s += 5;
    if (isAllBad(ch)) s -= 10;
    return s;
  }
  function forYou() {
    if (!S.profile || S.profile.skipped) return [];
    return S.channels.map((c) => [scoreFor(c), c]).filter((x) => x[0] > 0).sort((a, b) => b[0] - a[0]).slice(0, 24).map((x) => x[1]);
  }
  function listFor(ch) {
    if (ch.category === 'byo') return S.byo ? S.byo.channels : [ch];
    return S.channels.filter((c) => c.category === ch.category);
  }

  // ---------- rows ----------
  function renderRows() {
    const rows = [];
    const fy = forYou();
    if (fy.length) rows.push({ id: 'foryou', title: 'For you', note: 'from your profile', list: fy });
    const favs = S.channels.filter((c) => S.favs.has(c.id));
    if (favs.length) rows.push({ id: 'favs', title: 'Favorites', list: favs });
    if (S.byo && S.byo.channels.length) rows.push({ id: 'byo', title: 'My playlist', note: 'private to this browser', list: S.byo.channels });
    const catOrder = S.categories.slice();
    if (S.profile && !S.profile.skipped) catOrder.sort((a, b) => (S.profile.cats[b.id] || 0) - (S.profile.cats[a.id] || 0));
    for (const cat of catOrder) {
      const list = S.channels.filter((c) => c.category === cat.id);
      if (list.length) rows.push({ id: cat.id, title: cat.name, note: list.length + ' channels', list });
    }
    $('#rows').innerHTML = rows.map((r) =>
      '<div class="row" data-row="' + r.id + '"><h2>' + esc(r.title) + (r.note ? ' <small>' + esc(r.note) + '</small>' : '') + '</h2>' +
      '<div class="cards">' + r.list.map((c) => cardHtml(c, r.id)).join('') + '</div></div>').join('');
    $$('#rows .card').forEach((el) => el.addEventListener('click', () => onCard(el)));
    $$('#rows img').forEach(imgFallback);
    markPlaying();
  }
  function cardHtml(c, row, note) {
    const np = nowProg(c);
    const initials = esc(c.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3));
    const badges = [];
    if (c.country === 'PH') badges.push('<span class="badge ph">PH</span>');
    if (S.favs.has(c.id)) badges.push('<span class="badge fav">★</span>');
    if (c.streams && c.streams[0] && c.streams[0].not247) badges.push('<span class="badge">Not 24/7</span>');
    if (c.streams && c.streams[0] && c.streams[0].geoBlocked) badges.push('<span class="badge">May be region-locked</span>');
    return '<button class="card" data-focus data-ch="' + esc(c.id) + '" data-row="' + row + '">' +
      '<div class="card-logo">' + (c.logo ? '<img loading="lazy" alt="" src="' + esc(c.logo) + '" data-initials="' + initials + '">' : '<span>' + initials + '</span>') + '</div>' +
      '<div class="card-name">' + esc(c.name) + '</div>' +
      '<div class="card-now">' + (note ? esc(note) : np ? 'Now: ' + esc(np.t) : '&nbsp;') + '</div>' +
      '<div class="badges">' + badges.join('') + '</div></button>';
  }
  function imgFallback(img) { img.addEventListener('error', () => { const s = document.createElement('span'); s.textContent = img.dataset.initials || ''; img.replaceWith(s); }, { once: true }); }
  function refreshCardsNow() {
    $$('.card[data-ch]').forEach((el) => {
      const c = chById(el.dataset.ch); if (!c) return;
      const np = nowProg(c); const n = $('.card-now', el); if (n && np) n.textContent = 'Now: ' + np.t;
    });
  }
  function chById(id) {
    if (S.byId.has(id)) return S.byId.get(id);
    return S.byo ? S.byo.channels.find((c) => c.id === id) : null;
  }
  function markPlaying() { $$('.card').forEach((el) => el.classList.toggle('playing', !!S.current && el.dataset.ch === S.current.id)); }

  function onCard(el) {
    const ch = chById(el.dataset.ch); if (!ch) return;
    if (S.current && S.current.id === ch.id) { enterFs(); return; }
    const row = el.dataset.row;
    const list = row === 'foryou' ? forYou() : row === 'favs' ? S.channels.filter((c) => S.favs.has(c.id)) : listFor(ch);
    play(ch, { list, user: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------- player ----------
  function isBad(url) { const t = S.bad[url]; return t && t > Date.now(); }
  function isAllBad(ch) { return (ch.streams || []).length > 0 && ch.streams.every((s) => isBad(s.url)); }
  function markBad(url) { S.bad[url] = Date.now() + BAD_TTL; for (const k in S.bad) if (S.bad[k] < Date.now()) delete S.bad[k]; store.set('bad', S.bad); }

  function plan(ch, user) {
    const out = [];
    for (const s of ch.streams || []) {
      if (!user && isBad(s.url)) continue;
      if (s.cors === false) { if (NATIVE_RELIABLE) out.push({ s, how: 'native' }); continue; }
      if (HLSJS) out.push({ s, how: 'hls' });
      if (NATIVE_HLS) out.push({ s, how: 'native' });
    }
    return out;
  }
  function playable(ch) { return plan(ch, true).length > 0; }

  function stopPlayback() {
    clearTimeout(S.startTimer);
    if (S.hls) { try { S.hls.destroy(); } catch (e) { /* ignore */ } S.hls = null; }
    video.removeAttribute('src'); try { video.load(); } catch (e) { /* ignore */ }
  }

  function play(ch, opts) {
    opts = opts || {};
    S.current = ch;
    if (opts.list && opts.list.length) S.list = opts.list;
    if (!S.list.includes(ch)) S.list = listFor(ch);
    if (ch.category !== 'byo') store.set('last', ch.id);
    S.attempts = plan(ch, !!opts.user); S.attempt = 0; S.userPick = !!opts.user;
    renderNow(); renderEpg(); markPlaying(); osd();
    if (!S.attempts.length) { failChannel(ch, NATIVE_HLS || HLSJS ? "This channel can't play in this browser." : "This browser can't play live TV streams (no HLS support)."); return; }
    tryAttempt();
  }

  function tryAttempt() {
    stopPlayback();
    const a = S.attempts[S.attempt];
    if (!a) { (S.attempts || []).forEach((x) => markBad(x.s.url)); failChannel(S.current, 'This channel is not responding right now.'); return; }
    setMsg('Tuning in…');
    const ch = S.current;
    S.startTimer = setTimeout(() => { if (S.current === ch) nextAttempt('timeout'); }, START_TIMEOUT);
    if (a.how === 'hls') {
      const hls = new window.Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 2, subtitleDisplay: false });
      S.hls = hls;
      let recovered = false;
      hls.on(window.Hls.Events.ERROR, (_, d) => {
        if (!d.fatal || S.hls !== hls) return;
        if (d.type === window.Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; hls.recoverMediaError(); return; }
        nextAttempt(d.details);
      });
      hls.loadSource(a.s.url);
      hls.attachMedia(video);
    } else {
      video.src = a.s.url;
    }
    const p = video.play(); if (p && p.catch) p.catch(() => { /* autoplay blocked: handled by unmute hint */ });
  }
  function nextAttempt(why) { if (!S.current) return; S.attempt++; tryAttempt(); }

  video.addEventListener('playing', () => { clearTimeout(S.startTimer); setMsg(''); S.skips = 0; $('#unmute').hidden = !video.muted; });
  video.addEventListener('error', () => { if (!S.hls && video.getAttribute('src')) nextAttempt('native_error'); });
  let stallTimer = null;
  video.addEventListener('waiting', () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => { if (!video.paused && video.readyState < 3) { setMsg('Reconnecting…'); nextAttempt('stall'); } }, 20000); });
  video.addEventListener('timeupdate', () => clearTimeout(stallTimer));

  function failChannel(ch, why) {
    stopPlayback();
    S.skips = (S.skips || 0) + 1;
    const i = S.list.indexOf(ch);
    const next = S.skips <= 3 ? nextPlayable(i, 1) : null;
    if (next && next !== ch) {
      toast(esc(ch.name) + ': ' + esc(why) + ' Switching to <b>' + esc(next.name) + '</b>.', null, 6000, 'skip');
      play(next, { list: S.list });
    } else {
      S.skips = 0;
      setMsg(why + ' Pick another channel below.');
    }
  }
  function nextPlayable(i, dir) {
    const n = S.list.length;
    for (let k = 1; k <= n; k++) {
      const c = S.list[(i + dir * k + n * k) % n];
      if (c && !isAllBad(c) && plan(c, false).length) return c;
    }
    return null;
  }
  function zap(dir) { if (!S.current) return; const c = nextPlayable(S.list.indexOf(S.current), dir); if (c) play(c, { list: S.list, user: true }); }

  // captions: off by default, one track at a time when on
  S.cc = store.get('cc', false);
  function applyCc() {
    const tracks = Array.from(video.textTracks || []);
    let shown = false;
    tracks.forEach((t) => { const show = S.cc && !shown && (t.kind === 'captions' || t.kind === 'subtitles'); t.mode = show ? 'showing' : 'disabled'; if (show) shown = true; });
    const b = $('#ccBtn'); if (b) { b.classList.toggle('on', S.cc); b.hidden = !tracks.length; }
  }
  if (video.textTracks) { video.textTracks.addEventListener('addtrack', () => setTimeout(applyCc, 0)); video.textTracks.addEventListener('change', () => { /* keep */ }); }
  video.addEventListener('loadedmetadata', applyCc);

  function setMsg(t) { $('#playerMsg').textContent = t || ''; }
  function unmuteOnce() {
    if (S.interacted) return; S.interacted = true;
    video.muted = false; $('#unmute').hidden = true;
    const p = video.play(); if (p && p.catch) p.catch(() => {});
  }
  $('#unmute').addEventListener('click', unmuteOnce);
  $('#player').addEventListener('click', () => { if (!S.interacted) unmuteOnce(); else if (document.body.classList.contains('fs')) exitFs(); else enterFs(); });

  function renderNow() {
    const ch = S.current; if (!ch) return;
    $('#nowName').textContent = ch.name;
    const cat = S.categories.find((c) => c.id === ch.category);
    const bits = [cat ? cat.name : 'My playlist'];
    if (ch.country) bits.push(ch.country === 'PH' ? 'Philippines' : ch.country);
    const s = ch.streams && ch.streams[0];
    if (s && s.source === 'fast') bits.push('Free ad-supported channel');
    $('#nowMeta').textContent = bits.join(' · ');
    const logo = $('#nowLogo');
    if (ch.logo) { logo.src = ch.logo; logo.hidden = false; logo.onerror = () => { logo.hidden = true; }; } else logo.hidden = true;
    const fav = S.favs.has(ch.id);
    const fb = $('#favBtn'); fb.textContent = fav ? '★ Favorite' : '☆ Favorite'; fb.classList.toggle('on', fav);
    fb.hidden = ch.category === 'byo';
    document.title = ch.name + ' — Web TV Hub';
    renderNowProg();
  }
  function renderNowProg() {
    const box = $('#nowProg'); if (!box || !S.current) return;
    const p = nowProg(S.current);
    box.innerHTML = p ? '<div class="np-label">On now</div><div class="np-title">' + esc(p.t) + (p.st ? ' — ' + esc(p.st) : '') + '</div>' + (p.d ? '<div class="np-desc">' + esc(p.d) + '</div>' : '') +
      '<div class="small">' + fmtTime(p.s) + ' – ' + fmtTime(p.e) + '</div>' : '';
  }

  // ---------- EPG bar: 1 past, live now, 2 next ----------
  function renderEpg() {
    const ch = S.current; const box = $('#epg'); if (!ch) return;
    const list = progs(ch); const t = Date.now(); const i = nowIndex(list, t);
    if (i < 0) { box.innerHTML = '<div class="epg-empty">No schedule available for this channel.</div>'; return; }
    const slot = (p, kind, label) => {
      if (!p) return '<div class="slot ' + kind + '"><div class="slot-label">' + label + '</div><div class="slot-desc">—</div></div>';
      let extra = '';
      if (kind === 'live') { const pct = Math.min(100, Math.max(0, ((t - p.s) / (p.e - p.s)) * 100)); extra = '<div class="progress"><i style="width:' + pct.toFixed(1) + '%"></i></div><div class="small">' + Math.max(1, Math.round((p.e - t) / 60000)) + ' min left</div>'; }
      if (kind === 'next') { const on = hasReminder(ch.id, p.s); extra = '<button class="remind' + (on ? ' on' : '') + '" data-focus data-remind="' + p.s + '">' + (on ? '✓ Reminder set' : '🔔 Remind me') + '</button>'; }
      return '<div class="slot ' + kind + '"><div class="slot-label">' + label + ' · ' + fmtTime(p.s) + '–' + fmtTime(p.e) + '</div>' +
        '<div class="slot-title">' + esc(p.t) + (p.st ? ' — ' + esc(p.st) : '') + '</div>' +
        (p.d ? '<div class="slot-desc">' + esc(p.d) + '</div>' : '') + extra + '</div>';
    };
    const focusedRemind = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.remind : null;
    box.innerHTML = slot(list[i - 1], 'past', 'Just aired') + slot(list[i], 'live', 'Live now') + slot(list[i + 1], 'next', 'Up next') + slot(list[i + 2], 'next', 'Later');
    $$('[data-remind]', box).forEach((b) => b.addEventListener('click', () => toggleReminder(ch, +b.dataset.remind)));
    if (focusedRemind) { const b = $('[data-remind="' + focusedRemind + '"]', box); if (b) focusEl(b); }
  }

  // ---------- reminders (in-app; while the site is open) ----------
  const OFFSETS = [24 * 3600e3, 3600e3, 15 * 60e3, 0];
  function hasReminder(chId, s) { return S.reminders.some((r) => r.ch === chId && r.s === s); }
  function toggleReminder(ch, s) {
    const p = progs(ch).find((x) => x.s === s); if (!p) return;
    if (hasReminder(ch.id, s)) { S.reminders = S.reminders.filter((r) => !(r.ch === ch.id && r.s === s)); toast('Reminder removed.'); }
    else {
      S.reminders = S.reminders.filter((r) => r.s > Date.now() - 3600e3);
      if (S.reminders.length >= FREE_REMINDERS) { toast('You can keep up to ' + FREE_REMINDERS + ' reminders on the free plan. Remove one to add another.'); return; }
      S.reminders.push({ ch: ch.id, name: ch.name, s: p.s, t: p.t, fired: OFFSETS.filter((o) => Date.now() >= p.s - o).map(String) });
      toast('We\'ll remind you about <b>' + esc(p.t) + '</b> on ' + esc(ch.name) + ' (1 hour and 15 minutes before, and when it starts) while this site is open.');
      if (window.Notification && Notification.permission === 'default') { try { Notification.requestPermission(); } catch (e) { /* unsupported */ } }
    }
    store.set('reminders', S.reminders); renderEpg();
  }
  function checkReminders() {
    const t = Date.now(); let changed = false;
    for (const r of S.reminders) {
      for (const o of OFFSETS) {
        if (r.fired.includes(String(o)) || t < r.s - o) continue;
        r.fired.push(String(o)); changed = true;
        if (t > r.s + 10 * 60e3) continue; // too late, skip silently
        const when = o === 0 ? 'is starting now' : o >= 24 * 3600e3 ? 'is on tomorrow at ' + fmtTime(r.s) : 'starts in ' + Math.round(o / 60000) + ' min';
        const msg = r.t + ' ' + when + ' on ' + r.name;
        toast(esc(msg), { label: 'Watch now', fn: () => { const c = chById(r.ch); if (c) play(c, { list: listFor(c), user: true }); } }, 15000);
        if (window.Notification && Notification.permission === 'granted' && document.hidden) { try { new Notification('Web TV Hub', { body: msg, icon: 'icon.svg' }); } catch (e) { /* ignore */ } }
      }
    }
    const before = S.reminders.length;
    S.reminders = S.reminders.filter((r) => r.s > t - 30 * 60e3);
    if (changed || before !== S.reminders.length) { store.set('reminders', S.reminders); renderEpg(); }
  }

  // ---------- toasts ----------
  function toast(html, action, ms, key) {
    if (key) { const old = $('#toasts [data-key="' + key + '"]'); if (old) old.remove(); }
    const el = document.createElement('div'); el.className = 'toast'; el.innerHTML = html; if (key) el.dataset.key = key;
    if (action) { const b = document.createElement('button'); b.className = 'btn primary'; b.setAttribute('data-focus', ''); b.textContent = action.label; b.onclick = () => { action.fn(); el.remove(); }; el.appendChild(document.createElement('br')); el.appendChild(b); }
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), ms || 6000);
  }

  // ---------- full screen ----------
  let osdEl = null, osdTimer = null;
  function enterFs() {
    if (document.body.classList.contains('fs')) return;
    document.body.classList.add('fs'); pushBack('fs');
    const el = $('#player'); if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    osd();
  }
  function exitFs() {
    document.body.classList.remove('fs');
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    const c = S.current && $('.card[data-ch="' + cssEsc(S.current.id) + '"]'); focusEl(c || $('[data-action="fullscreen"]'));
  }
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('fs')) document.body.classList.remove('fs'); });
  function osd() {
    if (!document.body.classList.contains('fs') || !S.current) return;
    if (!osdEl) { osdEl = document.createElement('div'); osdEl.className = 'fs-osd'; document.body.appendChild(osdEl); }
    const np = nowProg(S.current);
    osdEl.innerHTML = '<b>' + esc(S.current.name) + '</b>' + (np ? '<br>' + esc(np.t) + ' · until ' + fmtTime(np.e) : '') + '<br><span class="small">▲▼ change channel · Back to exit</span>';
    osdEl.style.display = 'block'; clearTimeout(osdTimer); osdTimer = setTimeout(() => { osdEl.style.display = 'none'; }, 4000);
  }

  // ---------- overlays ----------
  let overlayCloseFn = null;
  function openOverlay(html, onClose) {
    $('#panel').innerHTML = html; $('#overlay').hidden = false; overlayCloseFn = onClose || null; pushBack('overlay');
    $$('#panel img').forEach(imgFallback);
    setTimeout(() => focusEl($('#panel [data-autofocus]') || $('#panel [data-focus]')), 30);
  }
  function closeOverlay() {
    if ($('#overlay').hidden) return;
    $('#overlay').hidden = true; $('#panel').innerHTML = '';
    const f = overlayCloseFn; overlayCloseFn = null; if (f) f();
    focusFirst();
  }

  // onboarding / profile
  function openOnboarding() {
    const P = S.profile && !S.profile.skipped ? S.profile : { cats: {}, interests: [], eras: [], ph: true };
    const chip = (group, val, label, on) => '<button class="chip' + (on ? ' on' : '') + '" data-focus data-group="' + group + '" data-val="' + esc(val) + '">' + esc(label) + '</button>';
    openOverlay(
      '<h2>' + (S.profile && !S.profile.skipped ? 'Edit your profile' : 'Welcome! What do you like to watch?') + '</h2>' +
      '<p>Three quick picks so we can put the right channels first. Skip anytime — your answers stay on this device.</p>' +
      '<h3>1. Your favorite kinds of TV</h3><div class="chips">' + S.categories.map((c) => chip('cat', c.id, c.name, (P.cats[c.id] || 0) > 0)).join('') + '</div>' +
      '<h3>2. Shows and sports you enjoy</h3><div class="chips">' + Object.keys(INTERESTS).map((k) => chip('int', k, k, P.interests.includes(k))).join('') + '</div>' +
      '<h3>3. Your era</h3><div class="chips">' + chip('era', 'classic', 'Classic (before 1990)', P.eras.includes('classic')) + chip('era', 'y2k', '90s & 2000s', P.eras.includes('y2k')) + chip('era', 'modern', 'Newer shows', P.eras.includes('modern')) +
      chip('ph', 'ph', 'Show Philippine channels first', P.ph) + '</div>' +
      '<div class="panel-actions"><button class="btn" data-focus data-ob="skip">Skip</button><button class="btn primary" data-focus data-ob="save" data-autofocus>Start watching</button></div>',
      () => { if (!S.profile) { S.profile = { skipped: true, cats: {} }; store.set('profile', S.profile); } });
    $$('#panel .chip').forEach((b) => b.addEventListener('click', () => b.classList.toggle('on')));
    $('[data-ob="skip"]').onclick = () => { if (!S.profile) { S.profile = { skipped: true, cats: {} }; store.set('profile', S.profile); } closeOverlay(); };
    $('[data-ob="save"]').onclick = () => {
      const on = (g) => $$('#panel .chip.on[data-group="' + g + '"]').map((b) => b.dataset.val);
      const cats = {}; on('cat').forEach((id) => { cats[id] = 1; });
      S.profile = { cats, interests: on('int'), eras: on('era'), ph: on('ph').length > 0, skipped: false, updated: Date.now() };
      store.set('profile', S.profile); closeOverlay(); renderRows();
      const fy = forYou(); if (fy[0] && (!S.current || !S.userPick)) play(fy[0], { list: fy });
      toast('Profile saved. Your <b>For you</b> row is ready.');
    };
  }

  // search + where to watch
  function openSearch() {
    openOverlay('<h2>Search</h2><p>Channels and shows on the schedule.</p><input class="field" id="q" data-focus data-autofocus placeholder="Try: news, cartoons, Star Trek, NBA" autocomplete="off"><div id="sr"></div>' +
      '<div class="panel-actions"><button class="btn" data-focus data-close>Close</button></div>');
    const q = $('#q'); let t = null;
    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => runSearch(q.value), 200); });
    $('[data-close]').onclick = closeOverlay;
  }
  function runSearch(v) {
    const q = v.trim().toLowerCase(); const out = $('#sr'); if (!out) return;
    if (q.length < 2) { out.innerHTML = ''; return; }
    const hits = [];
    for (const c of S.channels.concat(S.byo ? S.byo.channels : [])) {
      const cat = S.categories.find((k) => k.id === c.category);
      if (c.name.toLowerCase().includes(q) || (cat && cat.name.toLowerCase().includes(q))) { hits.push({ c, why: '' }); continue; }
      const p = progs(c).find((x) => x.e > Date.now() && x.t.toLowerCase().includes(q));
      if (p) hits.push({ c, why: (p.s <= Date.now() ? 'On now: ' : fmtTime(p.s) + ': ') + p.t });
    }
    let html = '';
    const w = S.wtw.find((x) => x.keywords.some((k) => q.includes(k) || k.includes(q)));
    if (w || hits.length === 0) {
      const services = w ? w.services : [{ name: 'Search JustWatch (Philippines)', url: 'https://www.justwatch.com/ph/search?q=' + encodeURIComponent(v.trim()) }];
      html += '<div class="wtw"><h3>Where to watch officially' + (w ? ': ' + esc(w.title) : '') + '</h3><p class="small">' + (w ? "This isn't on free TV. You can watch it legally here:" : "We couldn't find this on free TV right now. Check where it streams legally:") + '</p>' +
        services.map((s) => '<a class="btn" data-focus target="_blank" rel="noopener" href="' + esc(s.url) + '">' + esc(s.name) + ' ↗</a>').join('') + '</div>';
    }
    if (hits.length) html += '<div class="results">' + hits.slice(0, 30).map((h) => cardHtml(h.c, 'search', h.why)).join('') + '</div>';
    out.innerHTML = html;
    $$('#sr .card').forEach((el) => el.addEventListener('click', () => { const c = chById(el.dataset.ch); closeOverlay(); if (c) play(c, { list: listFor(c), user: true }); }));
    $$('#sr img').forEach(imgFallback);
  }

  // bring your own playlist (1 slot, stored only in this browser)
  function loadByo() { if (S.byo && S.byo.channels) S.byo.channels.forEach((c) => { c.category = 'byo'; }); }
  function openSettings() {
    openOverlay('<h2>My playlist</h2><p>Add one .m3u playlist link of your own. It is saved only in this browser and never sent to our servers. Links must start with https:// and the server must allow web players, or they won\'t play here.</p>' +
      '<input class="field" id="m3u" data-focus data-autofocus placeholder="https://example.com/my-playlist.m3u" value="' + esc(S.byo ? S.byo.url : '') + '">' +
      '<p class="small" id="m3uMsg">' + (S.byo ? S.byo.channels.length + ' channels loaded.' : '') + '</p>' +
      '<div class="panel-actions">' + (S.byo ? '<button class="btn" data-focus data-m3u="remove">Remove playlist</button>' : '') + '<button class="btn" data-focus data-close>Close</button><button class="btn primary" data-focus data-m3u="save">Load playlist</button></div>');
    $('[data-close]').onclick = closeOverlay;
    const rm = $('[data-m3u="remove"]'); if (rm) rm.onclick = () => { S.byo = null; store.set('byo', null); renderRows(); closeOverlay(); toast('Playlist removed.'); };
    $('[data-m3u="save"]').onclick = async () => {
      const url = $('#m3u').value.trim(); const msg = $('#m3uMsg');
      if (!/^https:\/\//i.test(url)) { msg.textContent = 'Please use a link that starts with https://'; return; }
      msg.textContent = 'Loading…';
      try {
        const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status);
        const chans = parseM3u(await r.text());
        if (!chans.length) throw new Error('no channels found');
        S.byo = { url, channels: chans }; store.set('byo', S.byo); loadByo(); renderRows(); closeOverlay();
        toast('Loaded ' + chans.length + ' channels into <b>My playlist</b>.');
      } catch (e) { msg.textContent = "Couldn't load that playlist (" + e.message + "). The server may not allow web players to read it."; }
    };
  }
  function parseM3u(txt) {
    const lines = txt.split(/\r?\n/); const out = []; let cur = null;
    for (const raw of lines) {
      const l = raw.trim();
      if (l.startsWith('#EXTINF')) {
        const name = l.slice(l.lastIndexOf(',') + 1).trim();
        const logo = (/tvg-logo="([^"]*)"/.exec(l) || [])[1] || null;
        cur = { name: name || 'Channel', logo: logo && /^https:/.test(logo) ? logo : null };
      } else if (l && !l.startsWith('#') && cur) {
        if (/^https:\/\//i.test(l)) out.push({ id: 'byo:' + out.length, name: cur.name.slice(0, 80), logo: cur.logo, category: 'byo', streams: [{ url: l, cors: null }] });
        cur = null;
      }
      if (out.length >= 300) break;
    }
    return out;
  }

  function openAbout() {
    openOverlay('<h2>About Web TV Hub</h2>' +
      '<p>A free, curated guide to live channels that broadcasters already stream for free. We check every channel every 6 hours and hide the ones that are down.</p>' +
      '<p>We don\'t host or re-stream any video: each channel plays directly from its broadcaster or an official free ad-supported service. Channel data comes from the open <a href="https://github.com/iptv-org/iptv" target="_blank" rel="noopener">iptv-org</a> project; program guides for free ad-supported channels come from public XMLTV listings.</p>' +
      '<p>Your profile, favorites, reminders and playlist are stored only in this browser.</p>' +
      '<p>Broadcaster or rights-holder and want a channel removed? <a href="https://github.com/francis-h-francisco/web-tv-hub/issues/new?title=Removal%20request" target="_blank" rel="noopener">Open a removal request</a> and we\'ll take it down.</p>' +
      '<p class="small">This browser: ' + (HLSJS ? 'web player ✓' : 'web player ✗') + ' · ' + (NATIVE_RELIABLE ? 'built-in TV player ✓' : 'built-in TV player ✗') +
      (S.hidden ? ' · ' + S.hidden + ' free ad-supported channels (mostly Pluto TV) are hidden here because they only play in the built-in players of Android TV sticks, phones and Safari.' : '') + '</p>' +
      '<div class="panel-actions"><button class="btn" data-focus data-autofocus data-close>Close</button></div>');
    $('[data-close]').onclick = closeOverlay;
  }

  // ---------- actions ----------
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]'); if (!b) return;
    const a = b.dataset.action;
    if (a === 'search') openSearch();
    else if (a === 'profile') openOnboarding();
    else if (a === 'settings') openSettings();
    else if (a === 'about') openAbout();
    else if (a === 'fullscreen') enterFs();
    else if (a === 'next') zap(1);
    else if (a === 'cc') { S.cc = !S.cc; store.set('cc', S.cc); applyCc(); toast(S.cc ? 'Captions on.' : 'Captions off.', null, 2500, 'cc'); }
    else if (a === 'fav' && S.current) {
      const id = S.current.id;
      if (S.favs.has(id)) S.favs.delete(id); else { S.favs.add(id); toast('Added <b>' + esc(S.current.name) + '</b> to Favorites.'); }
      store.set('favs', [...S.favs]); renderNow(); renderRows();
    }
  });

  // ---------- back handling (remote Back, Esc, Android back) ----------
  let backDepth = 0;
  function pushBack(kind) { try { history.pushState({ wth: kind }, ''); backDepth++; } catch (e) { /* ignore */ } }
  function handleBack() {
    if (!$('#overlay').hidden) { closeOverlay(); return true; }
    if (document.body.classList.contains('fs')) { exitFs(); return true; }
    return false;
  }
  window.addEventListener('popstate', () => { backDepth = Math.max(0, backDepth - 1); handleBack(); });
  function back() { if (backDepth > 0) history.back(); else handleBack(); }

  // ---------- spatial navigation ----------
  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/"/g, '\\"'); }
  function focusables() {
    const root = !$('#overlay').hidden ? $('#panel') : document;
    return $$('[data-focus]', root).filter((el) => !el.hidden && el.offsetParent !== null && !(root === document && el.closest('#overlay')));
  }
  function focusEl(el) {
    if (!el) return;
    $$('.focused').forEach((x) => x.classList.remove('focused'));
    el.classList.add('focused');
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if ($('#overlay').hidden) { const row = el.closest('.row'); if (row) row.scrollIntoView({ block: 'nearest' }); }
  }
  function focusFirst() {
    const c = S.current && $('.card[data-ch="' + cssEsc(S.current.id) + '"]');
    focusEl(c || $('#rows [data-focus]') || $('[data-focus]'));
  }
  function move(dir) {
    const cur = document.activeElement && document.activeElement.hasAttribute('data-focus') ? document.activeElement : null;
    const all = focusables(); if (!all.length) return;
    if (!cur || !all.includes(cur)) { focusEl(all[0]); return; }
    const r = cur.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of all) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2;
      const dx = x - cx, dy = y - cy;
      let primary, cross;
      if (dir === 'left') { if (b.right > r.left + 2) continue; primary = -dx; cross = Math.abs(dy); }
      else if (dir === 'right') { if (b.left < r.right - 2) continue; primary = dx; cross = Math.abs(dy); }
      else if (dir === 'up') { if (b.bottom > r.top + 2) continue; primary = -dy; cross = Math.abs(dx); }
      else { if (b.top < r.bottom - 2) continue; primary = dy; cross = Math.abs(dx); }
      // in horizontal moves stay in the same row
      if ((dir === 'left' || dir === 'right') && (b.bottom < r.top || b.top > r.bottom)) cross *= 6;
      const sc = primary + cross * 2.2;
      if (sc < bestScore) { bestScore = sc; best = el; }
    }
    if (best) focusEl(best);
    else if (dir === 'up') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const BACK_KEYS = new Set(['Escape', 'GoBack', 'BrowserBack', 'Back']);
  document.addEventListener('keydown', (e) => {
    const k = e.key; const code = e.keyCode;
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
  document.addEventListener('focusin', (e) => { if (e.target.hasAttribute && e.target.hasAttribute('data-focus')) { $$('.focused').forEach((x) => x !== e.target && x.classList.remove('focused')); e.target.classList.add('focused'); } });
  document.addEventListener('pointerdown', () => { if (!S.interacted) unmuteOnce(); }, { once: true });

  boot();
})();
