/* Phone-as-remote for Web TV Hub. No account: the TV shows a QR code / 6-letter code, the phone scans it,
   and the two connect peer-to-peer (WebRTC). PeerJS's free public broker only introduces them. */
(function () {
  'use strict';
  const PREFIX = 'wth-remote-';
  const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I: easy to type
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6))).map((b) => ALPH[b % ALPH.length]).join('');

  function loadPeer() {
    return new Promise((res, rej) => {
      if (window.Peer) return res();
      const s = document.createElement('script'); s.src = 'vendor/peerjs.min.js'; s.onload = res; s.onerror = () => rej(new Error('Could not load remote library')); document.head.appendChild(s);
    });
  }

  // ------------------------------------------------------------ TV side
  const host = { peer: null, conns: new Set(), code: null, status: 'off', listeners: new Set() };
  function setStatus(s) { host.status = s; host.listeners.forEach((f) => f(s)); }

  async function startHost(api) {
    if (host.peer && !host.peer.destroyed) return host;
    await loadPeer();
    host.code = localStorage.getItem('wth.remoteCode') || newCode();
    localStorage.setItem('wth.remoteCode', host.code);
    setStatus('starting');
    const peer = new window.Peer(PREFIX + host.code, { debug: 0 });
    host.peer = peer;
    peer.on('open', () => setStatus(host.conns.size ? 'connected' : 'waiting'));
    peer.on('error', (e) => {
      if (e.type === 'unavailable-id') { // code taken (e.g. another tab): pick a new one
        localStorage.removeItem('wth.remoteCode'); peer.destroy(); host.peer = null; startHost(api); return;
      }
      setStatus('error');
    });
    peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) { /* ignore */ } });
    peer.on('connection', (conn) => {
      conn.on('open', () => { host.conns.add(conn); setStatus('connected'); api.toast('📱 Phone remote connected.'); send(conn, api.state()); });
      conn.on('data', (msg) => handle(api, msg, conn));
      conn.on('close', () => { host.conns.delete(conn); setStatus(host.conns.size ? 'connected' : 'waiting'); });
    });
    api.onChange(() => broadcast(api.state()));
    setInterval(() => broadcast(api.state()), 30000);
    return host;
  }
  function send(conn, data) { try { conn.send(data); } catch (e) { /* closed */ } }
  function broadcast(data) { host.conns.forEach((c) => send(c, data)); }
  function handle(api, m, conn) {
    if (!m || typeof m !== 'object') return;
    if (m.k) api.key(String(m.k));
    else if (m.play) api.play(String(m.play));
    else if (m.tab) api.setTab(String(m.tab));
    send(conn, api.state());
  }
  function newHostCode(api) {
    localStorage.removeItem('wth.remoteCode');
    host.conns.forEach((c) => c.close()); host.conns.clear();
    if (host.peer) host.peer.destroy(); host.peer = null;
    return startHost(api);
  }

  // ------------------------------------------------------------ phone side
  function controller(code) {
    document.body.className = 'remote-mode';
    document.title = 'Remote — Web TV Hub';
    document.body.innerHTML = '<div class="rc" id="rc"></div>';
    if (!code) return askCode();
    connect(code.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  }
  function askCode(msg) {
    $('#rc').innerHTML = '<div class="rc-head"><b>📱 Phone remote</b></div>' +
      '<p class="rc-p">' + (msg ? esc(msg) + '<br><br>' : '') + 'On your TV, open Web TV Hub → <b>Remote</b>, then scan the QR code with this phone or type the 6-letter code.</p>' +
      '<input class="field rc-code" id="rcIn" maxlength="6" placeholder="ABC123" autocomplete="off" autocapitalize="characters" spellcheck="false">' +
      '<button class="btn primary rc-go" id="rcGo">Connect</button><a class="rc-link" href="./">← Back to watching on this phone</a>';
    const go = () => { const v = $('#rcIn').value.toUpperCase().replace(/[^A-Z0-9]/g, ''); if (v.length === 6) { history.replaceState(null, '', '?remote=' + v); connect(v); } };
    $('#rcGo').onclick = go; $('#rcIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }
  async function connect(code) {
    $('#rc').innerHTML = '<div class="rc-head"><b>📱 Phone remote</b><span class="rc-dot wait">Connecting…</span></div><p class="rc-p">Connecting to TV code <b>' + esc(code) + '</b>…</p>';
    try { await loadPeer(); } catch (e) { return askCode(e.message); }
    const peer = new window.Peer({ debug: 0 });
    let conn = null, state = null, gotOpen = false;
    const fail = (why) => { if (!gotOpen) { try { peer.destroy(); } catch (e) { /* */ } askCode(why); } else { status('off', 'Disconnected · tap to reconnect'); } };
    peer.on('error', (e) => fail(e.type === 'peer-unavailable' ? "Couldn't find a TV with code " + code + '. Check the code on your TV.' : 'Connection problem: ' + (e.type || e.message)));
    peer.on('open', () => {
      conn = peer.connect(PREFIX + code, { reliable: true });
      const t = setTimeout(() => fail("The TV didn't answer. Make sure Web TV Hub is open on the TV."), 12000);
      conn.on('open', () => { clearTimeout(t); gotOpen = true; localStorage.setItem('wth.lastRemote', code); render(); status('ok', 'Connected'); });
      conn.on('data', (d) => { state = d; renderState(); });
      conn.on('close', () => status('off', 'Disconnected · tap to reconnect'));
    });
    const sendMsg = (m) => { if (conn && conn.open) { conn.send(m); if (navigator.vibrate) navigator.vibrate(12); } else status('off', 'Disconnected · tap to reconnect'); };
    function status(kind, text) { const el = $('#rcDot'); if (el) { el.className = 'rc-dot ' + kind; el.textContent = text; } }
    function render() {
      $('#rc').innerHTML =
        '<div class="rc-head"><b>📱 Remote</b><button class="rc-dot ok" id="rcDot">Connected</button></div>' +
        '<div class="rc-now" id="rcNow"></div>' +
        '<div class="rc-pad">' +
          '<button class="rc-b up" data-k="up" aria-label="Up">▲</button><button class="rc-b left" data-k="left" aria-label="Left">◀</button>' +
          '<button class="rc-b ok" data-k="ok">OK</button><button class="rc-b right" data-k="right" aria-label="Right">▶</button><button class="rc-b down" data-k="down" aria-label="Down">▼</button>' +
        '</div>' +
        '<div class="rc-row"><button class="rc-b wide" data-k="back">↩ Back</button><button class="rc-b wide" data-k="fs">⛶ Full screen</button></div>' +
        '<div class="rc-row"><div class="rc-rocker"><button class="rc-b" data-k="chup">CH ▲</button><button class="rc-b" data-k="chdown">CH ▼</button></div>' +
        '<div class="rc-rocker"><button class="rc-b" data-k="volup">VOL +</button><button class="rc-b" data-k="voldown">VOL −</button></div>' +
        '<div class="rc-rocker" style="flex:0 0 4rem"><button class="rc-b" data-k="pause" aria-label="Pause or play">⏯</button><button class="rc-b" data-k="mute" aria-label="Mute">🔇</button></div></div>' +
        '<div class="rc-tabs" id="rcTabs"></div><div class="rc-list" id="rcList"></div>' +
        '<a class="rc-link" href="./">Watch on this phone instead</a>';
      $('#rc').addEventListener('click', (e) => {
        const b = e.target.closest('[data-k]'); if (b) return sendMsg({ k: b.dataset.k });
        const p = e.target.closest('[data-play]'); if (p) return sendMsg({ play: p.dataset.play });
        const t = e.target.closest('[data-tab]'); if (t) return sendMsg({ tab: t.dataset.tab });
        if (e.target.id === 'rcDot' && !(conn && conn.open)) location.reload();
      });
      renderState();
    }
    function renderState() {
      if (!state || !$('#rcNow')) return;
      const c = state.ch, n = state.now, x = state.next;
      $('#rcNow').innerHTML = c ? ((c.logo ? '<img src="' + esc(c.logo) + '" alt="" onerror="this.remove()">' : '') +
        '<div><div class="rc-ch">' + esc(c.name) + '</div>' + (n ? '<div class="rc-prog">● ' + esc(n.t) + ' · until ' + fmtTime(n.e) + '</div>' : '') + (x ? '<div class="rc-next">Next ' + fmtTime(x.s) + ': ' + esc(x.t) + '</div>' : '') + '</div>') : '<div class="rc-prog">Nothing playing</div>';
      $('#rcTabs').innerHTML = (state.tabs || []).map((t) => '<button class="tab' + (t.id === state.tab ? ' on' : '') + '" data-tab="' + esc(t.id) + '">' + esc(t.name) + '</button>').join('');
      $('#rcList').innerHTML = (state.list || []).map((r) => '<button class="rc-item' + (c && r.id === c.id ? ' on' : '') + '" data-play="' + esc(r.id) + '"><b>' + esc(r.name) + '</b><span>' + esc(r.now || '') + '</span></button>').join('');
    }
  }

  window.WTHRemote = { startHost, newHostCode, controller, host, PREFIX };
})();
