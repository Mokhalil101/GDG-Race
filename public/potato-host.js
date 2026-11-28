/* HOT POTATO CODE - big screen. Plain DOM on a fixed 1280x800 stage scaled to the window (projector friendly).
   The server never sends the fuse seconds here: only a coarse stage (0..3), so the bar just "creeps" per stage. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function show(id, on) { $(id).classList.toggle('hidden', !on); }
  var BASE = location.pathname.replace(/\/potato(\/.*)?$/, ''); // this page is <base>/potato/
  var RM = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var DARK_TEXT = { yellow: 1, pink: 1, cyan: 1, lime: 1, white: 1 };
  var CX = 640, CY = 430, RX = 340, RY = 279;

  // ---------- stage ----------
  var stage = $('pstage');
  function fit() { var s = Math.min(window.innerWidth / 1280, window.innerHeight / 800); stage.style.transform = 'translate(-50%, -50%) scale(' + s + ')'; }
  window.addEventListener('resize', fit); fit();
  function enterFullscreen() {
    var d = document.documentElement;
    if (document.fullscreenElement || !d.requestFullscreen) return;
    try { var p = d.requestFullscreen({ navigationUI: 'hide' }); if (p && p.catch) p.catch(function () {}); } catch (e) { /* unsupported */ }
  }
  function toggleFullscreen() { if (document.fullscreenElement) document.exitFullscreen(); else enterFullscreen(); }
  document.addEventListener('fullscreenchange', function () { fit(); setTimeout(fit, 120); wake(); });
  var idleTimer = null;
  function wake() { document.body.classList.remove('idle'); clearTimeout(idleTimer); idleTimer = setTimeout(function () { if (document.fullscreenElement) document.body.classList.add('idle'); }, 3500); }
  window.addEventListener('mousemove', wake); window.addEventListener('keydown', wake); wake();

  // ---------- sound ----------
  var audio = {
    ctx: null, muted: (function () { try { return localStorage.getItem('gdg_muted') === '1'; } catch (e) { return false; } })(),
    ensure: function () { if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* none */ } } if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
    tone: function (f, d, type, vol, delay) {
      if (this.muted || !this.ctx) return;
      var t = this.ctx.currentTime + (delay || 0), o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = type || 'square'; o.frequency.value = f; g.gain.setValueAtTime(vol || 0.08, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g); g.connect(this.ctx.destination); o.start(t); o.stop(t + d + 0.02);
    },
    tick: function (hi) { this.tone(hi ? 1200 : 900, 0.04, 'square', 0.05); },
    toss: function () { this.tone(500, 0.12, 'triangle', 0.08); this.tone(800, 0.14, 'triangle', 0.08, 0.08); },
    wrong: function () { this.tone(180, 0.18, 'sawtooth', 0.07); },
    boom: function () { [140, 110, 80, 60].forEach(function (f, i) { audio.tone(f, 0.35, 'sawtooth', 0.12, i * 0.05); }); },
    win: function () { [523, 659, 784, 1046, 784, 1046, 1318].forEach(function (f, i) { audio.tone(f, 0.22, 'triangle', 0.12, i * 0.14); }); },
  };
  ['click', 'keydown', 'touchstart'].forEach(function (ev) { window.addEventListener(ev, function () { audio.ensure(); }, { passive: true }); });
  function renderMute() { $('mute-lbl').textContent = audio.muted ? 'off' : 'on'; }
  renderMute();

  // ---------- socket ----------
  var socket = io('/potato', { path: BASE + '/socket.io', transports: ['websocket', 'polling'] });
  var mode = null, code = null, S = null, closed = false;

  function toast(text, bad) { var t = el('div', bad ? 'bad' : '', text); $('toasts').appendChild(t); setTimeout(function () { t.remove(); }, 3200); }

  var HOLD = {
    locked: ['Hold on!', 'Games start at the game stations.', 'Find someone from the <b>Registration Team</b> (green badge) and they\'ll open a game for you.'],
    closed: ['Station closed', 'This station was closed by the Registration Team.', 'Thanks for playing! The room has ended. Ask the <b>Registration Team</b> to open the station again for another game.'],
    expired: ['Hold on!', 'This station has expired.', 'Station links only work on the day they were opened. Ask the <b>Registration Team</b> to open it again.'],
    connecting: ['Hold on!', 'Connecting to the game station…', 'One moment while the big screen gets ready.'],
    dev: ['Hold on!', 'Local development server.', 'This server has no station key, so it uses the dev host key instead. Never run it like this at an event.'],
  };
  function hold(kind, err) {
    var h = HOLD[kind] || HOLD.locked;
    $('holdon').dataset.variant = kind;
    $('holdon-title').textContent = h[0]; $('holdon-lead').textContent = h[1]; $('holdon-body').innerHTML = h[2];
    $('hold-err').textContent = err || '';
    show('dev-form', kind === 'dev');
    code = null; S = null; render();
  }
  hold('connecting');

  function create(secret) {
    if (closed) return;
    var payload = { origin: location.origin };
    if (mode === 'dev') {
      var saved = null;
      try { saved = sessionStorage.getItem('gdg_potato_code'); secret = secret || sessionStorage.getItem('gdg_secret'); } catch (e) { /* ignore */ }
      if (!secret) return hold('dev');
      payload.secret = secret; if (saved) payload.code = saved;
    }
    socket.emit('potato:create', payload, function (res) {
      if (!res || !res.ok) {
        if (res && res.code === 'STATION_CLOSED') { closed = true; return hold(res.variant === 'expired' ? 'expired' : 'closed'); }
        try { sessionStorage.removeItem('gdg_secret'); } catch (e) { /* ignore */ }
        return hold(mode === 'dev' ? 'dev' : 'locked', res && res.code !== 'STATION' ? res.error : '');
      }
      code = res.code;
      try { sessionStorage.setItem('gdg_potato_code', res.code); if (secret) sessionStorage.setItem('gdg_secret', secret); } catch (e) { /* ignore */ }
      $('qr').src = res.qr; $('l-code').textContent = res.code; $('l-url').textContent = res.joinUrl.replace(/^https?:\/\//, '');
      apply(res.state);
    });
  }

  socket.on('hello', function (h) { mode = h && h.mode === 'dev' ? 'dev' : 'station'; create(); });
  socket.on('connect', function () { show('conn', false); });
  socket.on('disconnect', function () { show('conn', !closed); });
  socket.on('station-closed', function (d) { closed = true; hold(d && d.reason === 'expired' ? 'expired' : 'closed'); });
  socket.on('potato:kicked', function () { if (!closed) hold('locked'); });
  socket.on('potato:state', function (s) { apply(s); });
  $('dev-form').addEventListener('submit', function (ev) { ev.preventDefault(); var v = $('dev-secret').value; if (v) create(v); });

  // ---------- apply ----------
  function byId(id) { if (!S) return null; for (var i = 0; i < S.players.length; i++) if (S.players[i].id === id) return S.players[i]; return null; }
  function apply(s) {
    if (!s) return;
    var p = S;
    S = s;
    // sounds + one-off effects from the transition
    if (p && p.code === s.code) {
      var top = s.feed[0], ptop = p.feed[0];
      if (top && (!ptop || top.t !== ptop.t || top.type !== ptop.type || top.id !== ptop.id)) {
        if (top.type === 'pass') audio.toss(); else if (top.type === 'wrong') audio.wrong(); else if (top.type === 'boom') { audio.boom(); burst(top.id); }
      }
      if (s.phase === 'finished' && p.phase !== 'finished' && s.winner) { audio.win(); confetti(); }
      if (s.phase === 'intro' && (p.phase !== 'intro' || p.round !== s.round)) resetFuse();
    }
    render();
  }

  // ---------- render ----------
  function render() {
    var ph = code && S ? S.phase : null;
    show('s-hold', !ph);
    show('title', ph === 'lobby' || ph === 'intro' || ph === 'live' || ph === 'boom');
    show('s-lobby', ph === 'lobby');
    show('s-game', ph === 'intro' || ph === 'live' || ph === 'boom');
    show('s-end', ph === 'finished');
    show('dock', !!ph);
    if (!ph) return;
    renderDock();
    if (ph === 'lobby') renderLobby();
    else if (ph === 'finished') renderEnd();
    else renderGame();
  }

  function renderDock() {
    var ph = S.phase, running = ph === 'intro' || ph === 'live' || ph === 'boom';
    var vis = { start: ph === 'lobby', pause: running, end: running, again: ph === 'finished', mute: true, fullscreen: true };
    Array.prototype.forEach.call($('dock').querySelectorAll('[data-act]'), function (b) { b.classList.toggle('hidden', !vis[b.dataset.act]); });
    $('pause-lbl').textContent = S.paused ? 'Resume' : 'Pause';
  }

  function face(p, cls) {
    var f = el('span', 'face' + (DARK_TEXT[p.color] ? ' dark' : '') + (cls ? ' ' + cls : ''), p.name.slice(0, 2).toUpperCase());
    f.style.background = p.hex; return f;
  }
  function seatNode(p) {
    var s = el('div', 'seat'); s.dataset.id = p.id;
    s.appendChild(face(p)); s.appendChild(el('span', 'tag', p.name));
    return s;
  }

  function renderLobby() {
    var n = S.players.length;
    $('l-count').textContent = n + ' / ' + S.max;
    var box = $('l-faces'); box.innerHTML = '';
    S.players.forEach(function (p) { var s = seatNode(p); if (!p.connected) s.classList.add('off'); box.appendChild(s); });
    for (var i = n; i < Math.max(S.min, Math.min(S.max, 12)); i++) { var w = el('div', 'seat'); w.appendChild(el('span', 'empty')); w.appendChild(el('span', 'tag', 'free seat')); w.style.opacity = '.5'; box.appendChild(w); }
    var ready = S.players.filter(function (p) { return p.connected; }).length;
    $('b-start').disabled = ready < S.min;
    $('l-hint').textContent = ready < S.min ? 'Need ' + (S.min - ready) + ' more player' + (S.min - ready === 1 ? '' : 's') + ' to start (4 to 12).' : 'Press Space when everyone is in.';
  }

  // seats on an ellipse around the cream circle
  var seatEls = {};
  function seatPos(i, n) { var a = -Math.PI / 2 + i * (Math.PI * 2 / n); return { x: Math.round(CX + Math.cos(a) * RX), y: Math.round(CY + Math.sin(a) * RY) }; }
  var positions = {};
  function layoutSeats() {
    var box = $('seats');
    var list = S.players.filter(function (p) { return !p.spectator; });
    var keep = {};
    list.forEach(function (p, i) {
      var s = seatEls[p.id];
      if (!s) { s = seatNode(p); seatEls[p.id] = s; box.appendChild(s); }
      var pos = seatPos(i, list.length); positions[p.id] = pos;
      s.style.left = pos.x + 'px'; s.style.top = pos.y + 'px';
      s.classList.toggle('out', p.out);
      s.classList.toggle('off', !p.connected && !p.out);
      s.classList.toggle('bomb', !p.out && S.holder === p.id && (S.phase === 'live' || S.phase === 'intro') && !S.flight);
      s.querySelector('.tag').textContent = p.out ? p.name + ' · out' : p.name;
      keep[p.id] = 1;
    });
    Object.keys(seatEls).forEach(function (id) { if (!keep[id]) { seatEls[id].remove(); delete seatEls[id]; } });
    var spect = S.players.length - list.length;
    show('g-spect', spect > 0);
    $('g-spect').textContent = spect + ' waiting for the next game';
  }

  function bombAt(id) { var p = positions[id]; if (!p) return null; return { x: p.x + (CX - p.x) * 0.3, y: p.y + (CY - p.y) * 0.3 }; }

  var STAGES = [['FUSE LIT', 70, 5], ['SPARKING…', 44, 4.5], ['HISSING!', 20, 4], ['ABOUT TO BLOW!', 5, 3]];
  var fuseStage = -1;
  function resetFuse() {
    var i = $('c-fuse-i'); i.style.transition = 'none'; i.style.width = '100%'; void i.offsetWidth; fuseStage = -1;
  }
  function renderFuse() {
    var i = $('c-fuse-i'), live = S.phase === 'live';
    $('c-fuse').classList.toggle('cold', !live || S.paused);
    if (S.phase === 'intro') { $('c-fuse-lbl').textContent = 'FUSE: ??? SECONDS'; $('c-fuse-lbl').className = 'fuse-lbl'; return; }
    if (S.phase === 'boom') { i.style.transition = 'width .2s'; i.style.width = '0%'; $('c-fuse-lbl').textContent = 'BOOM!'; return; }
    if (S.paused || S.flight) { // freeze where it is
      var w = i.getBoundingClientRect().width / Math.max(1, $('c-fuse').getBoundingClientRect().width) * 100;
      i.style.transition = 'none'; i.style.width = w.toFixed(1) + '%'; fuseStage = -1;
    } else if (S.stage !== fuseStage) {
      fuseStage = S.stage;
      var st = STAGES[S.stage] || STAGES[0];
      i.style.transition = 'width ' + st[2] + 's linear'; i.style.width = st[1] + '%';
    }
    var st2 = STAGES[S.stage] || STAGES[0];
    $('c-fuse-lbl').textContent = st2[0]; $('c-fuse-lbl').className = 'fuse-lbl s' + S.stage;
  }

  function renderGame() {
    $('g-round').textContent = String(S.round);
    $('g-alive').textContent = S.alive + '/' + S.inGame;
    layoutSeats();
    var h = byId(S.holder), bomb = $('bomb');
    var k = 'The bomb is with', who = h ? h.name.toUpperCase() + '!' : '…', sub = 'Answer to pass it on…';
    if (S.phase === 'intro') { k = 'Round ' + S.round + ' · the bomb starts with'; sub = 'Get ready… the fuse is secret!'; }
    if (S.flight) { var to = byId(S.flight.to), from = byId(S.flight.from); k = (from ? from.name : '') + ' threw it to'; who = to ? to.name.toUpperCase() + '!' : '…'; sub = 'Catch!'; }
    if (S.phase === 'boom') { var b = S.feed[0]; k = 'BOOM!'; who = b && b.type === 'boom' ? b.name.toUpperCase() : '…'; sub = 'is out of the circle'; }
    $('c-k').textContent = k; $('c-who').textContent = who; $('c-sub').textContent = sub;
    renderFuse();
    // bomb
    var target = S.flight ? S.flight.to : S.holder;
    var pos = S.phase !== 'boom' ? bombAt(target) : null;
    show('bomb', !!pos);
    if (pos) {
      bomb.classList.toggle('flying', !!S.flight && !RM);
      bomb.classList.toggle('calm', S.phase === 'intro' || S.paused);
      bomb.style.left = pos.x.toFixed(0) + 'px'; bomb.style.top = pos.y.toFixed(0) + 'px';
    }
    // feed
    var feed = $('feed'); feed.innerHTML = '';
    S.feed.slice(0, 3).forEach(function (f) {
      var t = f.type === 'pass' ? f.name + ' passed it to ' + f.to + ' · ' + f.sec.toFixed(1) + ' s!' : f.type === 'wrong' ? f.name + ' got it wrong · fuse −2 s' : 'BOOM! ' + f.name + ' is out';
      feed.appendChild(el('div', f.type, t));
    });
    // banner
    var big = null, small = '';
    if (S.paused) { big = 'PAUSED'; small = 'The station holder paused the game'; }
    show('banner', !!big);
    if (big) { $('banner-big').textContent = big; $('banner-small').textContent = small; }
  }

  function burst(id) {
    var p = positions[id]; if (!p) return;
    var b = el('div', 'burst'); b.style.left = p.x + 'px'; b.style.top = p.y + 'px';
    var pts = [];
    for (var i = 0; i < 24; i++) { var r = i % 2 ? 70 : 145, a = i * Math.PI / 12; pts.push((150 + Math.cos(a) * r).toFixed(0) + ',' + (150 + Math.sin(a) * r).toFixed(0)); }
    b.innerHTML = '<svg viewBox="0 0 300 300"><polygon points="' + pts.join(' ') + '" fill="#fbbc04" stroke="#1b1340" stroke-width="8" stroke-linejoin="round"/><polygon points="' + pts.map(function (q) { var a = q.split(','); return (150 + (a[0] - 150) * 0.6).toFixed(0) + ',' + (150 + (a[1] - 150) * 0.6).toFixed(0); }).join(' ') + '" fill="#ea4335"/></svg><b class="ol4">BOOM!</b>';
    $('bursts').appendChild(b);
    setTimeout(function () { b.remove(); }, 3600);
  }

  // ---------- results ----------
  function renderEnd() {
    var w = byId(S.winner);
    $('e-title').textContent = w ? 'LAST ONE STANDING!' : 'GAME OVER';
    var champ = $('e-champ');
    champ.classList.toggle('hidden', !w);
    if (w) {
      var f = $('e-face'); f.textContent = w.name.slice(0, 2).toUpperCase(); f.style.background = w.hex; f.style.color = DARK_TEXT[w.color] ? '#1b1340' : '#fff';
      $('e-name').textContent = w.name;
      $('e-meta').textContent = 'survived ' + S.round + ' round' + (S.round === 1 ? '' : 's') + ' of hot potato';
    }
    $('e-sub').textContent = w ? S.inGame + ' players · ' + S.round + ' rounds · nobody knew the fuse' : 'The station holder ended the game';
    var ol = $('e-rank'); ol.innerHTML = '';
    (S.ranking || []).forEach(function (id, i) {
      var p = byId(id); if (!p) return;
      var li = el('li'), d = el('span', 'dot'); d.style.background = p.hex;
      li.appendChild(el('b', null, (i + 1) + '.')); li.appendChild(d); li.appendChild(el('span', 'nm', p.name));
      li.appendChild(el('small', null, p.out ? 'out in round ' + p.outRound : (w && w.id === p.id ? 'winner' : 'still in')));
      ol.appendChild(li);
    });
    $('e-rank-h').textContent = 'HOW LONG THEY LASTED';
    var rank = document.querySelector('.p-rank');
    rank.style.right = w ? '110px' : ''; rank.style.left = w ? '' : '420px';
  }
  function confetti() {
    if (RM) return;
    var colors = ['#4285F4', '#EA4335', '#FBBC04', '#34A853', '#FFF6E0', '#A142F4'];
    for (var i = 0; i < 70; i++) {
      var c = el('div', 'confetti'); c.style.left = Math.random() * 1280 + 'px'; c.style.background = colors[i % colors.length];
      c.style.animationDuration = (2.5 + Math.random() * 2.5) + 's'; c.style.animationDelay = (Math.random() * 1.2) + 's';
      stage.appendChild(c); setTimeout(function (n) { n.remove(); }, 6500, c);
    }
  }

  // fuse tick sound: faster when it is about to blow (the stage only, never the seconds)
  var lastTick = 0;
  setInterval(function () {
    if (!S || S.phase !== 'live' || S.paused || S.flight) return;
    var gap = [900, 600, 350, 180][S.stage] || 900, now = Date.now();
    if (now - lastTick >= gap) { lastTick = now; audio.tick(S.stage >= 2); }
  }, 60);

  // ---------- station controls ----------
  var armed = null;
  function emit(ev) { socket.emit(ev, {}, function (res) { if (res && !res.ok) { if (res.code === 'STATION_CLOSED') { closed = true; hold('closed'); } else toast(res.error || 'Not allowed right now', true); } }); }
  function act(a) {
    if (!S) return;
    if (a === 'start' && S.phase === 'lobby') emit('potato:start');
    else if (a === 'pause') emit('potato:pause');
    else if (a === 'end') {
      if (armed === 'end') { armed = null; emit('potato:end'); }
      else { armed = 'end'; toast('Press End again to finish the game now'); setTimeout(function () { if (armed === 'end') armed = null; }, 3000); }
    }
    else if (a === 'again' && S.phase === 'finished') emit('potato:again');
    else if (a === 'mute') { audio.muted = !audio.muted; try { localStorage.setItem('gdg_muted', audio.muted ? '1' : '0'); } catch (e) { /* ignore */ } renderMute(); }
    else if (a === 'fullscreen') toggleFullscreen();
  }
  $('dock').addEventListener('click', function (ev) { var b = ev.target.closest('[data-act]'); if (b) act(b.dataset.act); });
  $('b-start').addEventListener('click', function () { enterFullscreen(); act('start'); });
  $('b-again').addEventListener('click', function () { act('again'); });
  window.addEventListener('keydown', function (ev) {
    var tag = (ev.target.tagName || '').toLowerCase();
    if (tag === 'input' || ev.ctrlKey || ev.metaKey || ev.altKey || !S) return;
    var k = ev.key.toLowerCase();
    if (k === ' ' || k === 'enter') { ev.preventDefault(); if (S.phase === 'lobby') act('start'); else if (S.phase === 'finished') act('again'); }
    else if (k === 'p') act('pause');
    else if (k === 'e') act('end');
    else if (k === 'm') act('mute');
    else if (k === 'f') act('fullscreen');
  });

  render();
})();
