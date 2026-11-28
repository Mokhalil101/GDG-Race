/* AMONG BUGS - big screen. Plain DOM on a fixed 1280x800 stage scaled to the window (projector friendly).
   This screen is public: it never receives roles (until the game is over) and a faked fix looks like any other fix. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function show(id, on) { $(id).classList.toggle('hidden', !on); }
  function mmss(ms) { var s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  var BASE = location.pathname.replace(/\/among(\/.*)?$/, ''); // this page is <base>/among/
  var RM = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var MOVE_MS = 3000;
  // room boxes on the 1280x800 map (design: AmongMap)
  var GEO = { bridge: [140, 290, 290, 170], lab: [140, 520, 290, 170], server: [520, 190, 250, 160], cafe: [520, 540, 250, 170], engine: [860, 330, 270, 230] };
  var REASON_TXT = {
    ship: 'The ship is 100% fixed!', voted: 'Every Bug was thrown off the ship!', sabotage: 'A sabotage was not fixed in time.',
    outnumbered: 'The Bugs outnumbered the crew.', time: 'Time ran out before the ship was fixed.', ended: 'The station holder ended the game.',
  };

  // ---------- stage ----------
  var stage = $('astage');
  function fit() { var s = Math.min(window.innerWidth / 1280, window.innerHeight / 800); stage.style.transform = 'translate(-50%, -50%) scale(' + s + ')'; }
  window.addEventListener('resize', fit); fit();
  (function stars() {
    var box = $('stars'), rnd = function (i, m) { return (((Math.sin(i * 57.9) * 43758.5453) % 1) + 1) % 1 * m; };
    for (var i = 0; i < 50; i++) {
      var s = el('span', 'astar'), z = 2 + Math.round(rnd(i + 2, 3));
      s.style.left = rnd(i, 1280).toFixed(0) + 'px'; s.style.top = rnd(i + 1, 800).toFixed(0) + 'px'; s.style.width = z + 'px'; s.style.height = z + 'px';
      s.style.animationDuration = (1.4 + rnd(i + 4, 2)).toFixed(1) + 's';
      box.appendChild(s);
    }
  })();
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
    fix: function () { this.tone(880, 0.08, 'triangle', 0.07); this.tone(1320, 0.1, 'triangle', 0.07, 0.07); },
    alarm: function () { for (var i = 0; i < 4; i++) { this.tone(700, 0.18, 'sawtooth', 0.06, i * 0.4); this.tone(500, 0.18, 'sawtooth', 0.06, i * 0.4 + 0.2); } },
    meeting: function () { [523, 392, 523, 392].forEach(function (f, i) { audio.tone(f, 0.2, 'square', 0.08, i * 0.22); }); },
    win: function () { [523, 659, 784, 1046, 784, 1046, 1318].forEach(function (f, i) { audio.tone(f, 0.22, 'triangle', 0.12, i * 0.14); }); },
    lose: function () { [392, 330, 262, 196].forEach(function (f, i) { audio.tone(f, 0.3, 'sawtooth', 0.07, i * 0.22); }); },
  };
  ['click', 'keydown', 'touchstart'].forEach(function (ev) { window.addEventListener(ev, function () { audio.ensure(); }, { passive: true }); });
  function renderMute() { $('mute-lbl').textContent = audio.muted ? 'off' : 'on'; }
  renderMute();

  // ---------- socket ----------
  var socket = io('/among', { path: BASE + '/socket.io', transports: ['websocket', 'polling'] });
  var mode = null, code = null, S = null, closed = false, recvAt = 0;
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
      try { saved = sessionStorage.getItem('gdg_among_code'); secret = secret || sessionStorage.getItem('gdg_secret'); } catch (e) { /* ignore */ }
      if (!secret) return hold('dev');
      payload.secret = secret; if (saved) payload.code = saved;
    }
    socket.emit('among:create', payload, function (res) {
      if (!res || !res.ok) {
        if (res && res.code === 'STATION_CLOSED') { closed = true; return hold(res.variant === 'expired' ? 'expired' : 'closed'); }
        try { sessionStorage.removeItem('gdg_secret'); } catch (e) { /* ignore */ }
        return hold(mode === 'dev' ? 'dev' : 'locked', res && res.code !== 'STATION' ? res.error : '');
      }
      code = res.code;
      try { sessionStorage.setItem('gdg_among_code', res.code); if (secret) sessionStorage.setItem('gdg_secret', secret); } catch (e) { /* ignore */ }
      $('qr').src = res.qr; $('l-code').textContent = res.code; $('l-url').textContent = res.joinUrl.replace(/^https?:\/\//, '');
      apply(res.state);
    });
  }

  socket.on('hello', function (h) { mode = h && h.mode === 'dev' ? 'dev' : 'station'; create(); });
  socket.on('connect', function () { show('conn', false); });
  socket.on('disconnect', function () { show('conn', !closed); });
  socket.on('station-closed', function (d) { closed = true; hold(d && d.reason === 'expired' ? 'expired' : 'closed'); });
  socket.on('among:kicked', function () { if (!closed) hold('locked'); });
  socket.on('among:state', function (s) { apply(s); });
  socket.on('among:fx', function (f) { fixPop(f); });
  $('dev-form').addEventListener('submit', function (ev) { ev.preventDefault(); var v = $('dev-secret').value; if (v) create(v); });

  function byId(id) { if (!S) return null; for (var i = 0; i < S.players.length; i++) if (S.players[i].id === id) return S.players[i]; return null; }
  function apply(s) {
    if (!s) return;
    var p = S;
    S = s; recvAt = Date.now();
    if (p && p.code === s.code) {
      if (s.sabotage && !p.sabotage) audio.alarm();
      if (s.phase === 'meeting' && p.phase !== 'meeting') audio.meeting();
      if (s.phase === 'finished' && p.phase !== 'finished') { if (s.outcome && s.outcome.winner === 'crew') { audio.win(); confetti(); } else audio.lose(); }
    }
    render();
  }

  // ---------- render ----------
  function render() {
    var ph = code && S ? S.phase : null;
    show('s-hold', !ph);
    show('s-lobby', ph === 'lobby');
    show('s-map', ph === 'roles' || ph === 'play' || ph === 'meeting' || ph === 'verdict');
    show('s-meet', ph === 'meeting' || ph === 'verdict');
    show('s-end', ph === 'finished');
    show('dock', !!ph);
    if (!ph) return;
    renderDock();
    if (ph === 'lobby') renderLobby();
    else if (ph === 'finished') renderEnd();
    else { renderMap(); if (ph === 'meeting' || ph === 'verdict') renderMeeting(); }
    tick();
  }

  function renderDock() {
    var ph = S.phase, running = ph === 'roles' || ph === 'play' || ph === 'meeting' || ph === 'verdict';
    var vis = { start: ph === 'lobby', pause: running, end: running, again: ph === 'finished', mute: true, fullscreen: true };
    Array.prototype.forEach.call($('dock').querySelectorAll('[data-act]'), function (b) { b.classList.toggle('hidden', !vis[b.dataset.act]); });
    $('pause-lbl').textContent = S.paused ? 'Resume' : 'Pause';
  }

  function bean(p, extra) {
    var b = el('div', 'bean' + (extra ? ' ' + extra : '')); b.style.setProperty('--c', p.hex);
    b.appendChild(el('div', 'pack')); var body = el('div', 'body'); body.appendChild(el('span', 'visor')); b.appendChild(body);
    return b;
  }
  function crewNode(p) {
    var w = el('div', 'crew'); w.dataset.id = p.id;
    var bob = el('div', 'bob'); bob.appendChild(bean(p)); w.appendChild(bob);
    w.appendChild(el('span', 'nm', p.name));
    return w;
  }

  function renderLobby() {
    var n = S.players.length;
    $('l-count').textContent = n + ' / ' + S.max;
    $('l-bugrule').textContent = S.bugCount === 2 ? '2 secret Bugs' : '1 secret Bug';
    var box = $('l-beans'); box.innerHTML = '';
    S.players.forEach(function (p, i) { var c = crewNode(p); c.querySelector('.bob').style.animationDelay = (i * 0.13).toFixed(2) + 's'; if (!p.connected) c.classList.add('off'); box.appendChild(c); });
    for (var i = n; i < S.max; i++) { var w = el('div', 'crew'); w.appendChild(el('div', 'slot')); w.appendChild(el('span', 'nm', 'free')); w.style.opacity = '.45'; box.appendChild(w); }
    var ready = S.players.filter(function (p) { return p.connected; }).length;
    $('b-start').disabled = ready < S.min;
    $('l-hint').textContent = ready < S.min ? 'Need ' + (S.min - ready) + ' more player' + (S.min - ready === 1 ? '' : 's') + ' (5 to 10).' : 'Press Space when everyone is aboard.';
  }

  // ---------- map ----------
  var roomEls = {}, crewEls = {}, walkKeys = {};
  function roomCenter(id) { var g = GEO[id]; return { x: g[0] + g[2] / 2, y: g[1] + g[3] / 2 + 10 }; }
  function slots(id, n) {
    var g = GEO[id], s = 1, sp = 72, rh = 82;
    var per = Math.max(1, Math.floor((g[2] - 24) / sp));
    if (n > per) { s = 0.7; sp = 54; rh = 54; per = Math.max(1, Math.floor((g[2] - 20) / sp)); }
    var out = [];
    for (var i = 0; i < n; i++) {
      var row = Math.floor(i / per), inRow = Math.min(per, n - row * per), col = i % per;
      out.push({ x: g[0] + g[2] / 2 - (inRow - 1) * sp / 2 + col * sp, y: g[1] + (s === 1 ? 94 : 78) + row * rh, s: s });
    }
    return out;
  }
  function renderRooms() {
    var box = $('rooms');
    S.rooms.forEach(function (r) {
      var e = roomEls[r.id];
      if (!e) {
        var g = GEO[r.id];
        e = el('div', 'a-room'); e.style.left = g[0] + 'px'; e.style.top = g[1] + 'px'; e.style.width = g[2] + 'px'; e.style.height = g[3] + 'px';
        e.style.boxShadow = 'inset 0 0 0 8px ' + r.color + '55, 0 6px 0 #1b1340';
        var l = el('span', 'lbl', r.name); l.style.background = r.color === '#fbbc04' ? '#e3a600' : r.color; e.appendChild(l);
        e.appendChild(el('span', 'st'));
        box.appendChild(e); roomEls[r.id] = e;
      }
      e.classList.toggle('bad', r.sabotaged);
      var st = e.querySelector('.st');
      st.className = 'st' + (!r.sabotaged && r.fixes >= S.quota ? ' ok' : '');
      st.textContent = r.sabotaged ? 'CRASHING' : r.fixes >= S.quota ? 'Fixed ✓' : r.fixes + '/' + S.quota + ' fixed';
    });
  }
  function renderCrew() {
    var box = $('crew'), keep = {}, byRoom = {};
    var list = S.players.filter(function (p) { return !p.spectator; });
    list.forEach(function (p) { if (p.room && !p.walk) (byRoom[p.room] = byRoom[p.room] || []).push(p); });
    var pos = {};
    Object.keys(byRoom).forEach(function (id) { var sl = slots(id, byRoom[id].length); byRoom[id].forEach(function (p, i) { pos[p.id] = sl[i]; }); });
    list.forEach(function (p, i) {
      var e = crewEls[p.id];
      if (!e) { e = crewNode(p); e.querySelector('.bob').style.animationDuration = (1.2 + i * 0.13).toFixed(2) + 's'; box.appendChild(e); crewEls[p.id] = e; }
      keep[p.id] = 1;
      e.classList.toggle('ghost', p.ghost); e.querySelector('.bean').classList.toggle('ghost', p.ghost);
      e.classList.toggle('off', !p.connected);
      e.classList.toggle('walk', !!p.walk);
      var busy = e.querySelector('.busy');
      if (p.busy && !busy) { busy = el('span', 'busy', 'fixing'); busy.setAttribute('aria-label', 'fixing'); e.querySelector('.bob').appendChild(busy); }
      if (!p.busy && busy) busy.remove();
      if (p.walk) {
        var key = p.walk.from + '>' + p.walk.to;
        if (walkKeys[p.id] !== key) {
          walkKeys[p.id] = key;
          var a = roomCenter(p.walk.from || p.walk.to), b = roomCenter(p.walk.to), done = 1 - Math.max(0, Math.min(1, p.walk.ms / MOVE_MS));
          e.style.transition = 'none';
          e.style.left = (a.x + (b.x - a.x) * done).toFixed(0) + 'px'; e.style.top = (a.y + (b.y - a.y) * done).toFixed(0) + 'px';
          e.style.setProperty('transform', 'translate(-50%, -50%)');
          void e.offsetWidth;
          if (!RM) e.style.transition = 'left ' + (p.walk.ms / 1000).toFixed(2) + 's linear, top ' + (p.walk.ms / 1000).toFixed(2) + 's linear';
          e.style.left = b.x + 'px'; e.style.top = b.y + 'px';
        }
      } else if (pos[p.id]) {
        if (walkKeys[p.id]) { walkKeys[p.id] = null; e.style.transition = ''; }
        var q = pos[p.id];
        e.style.left = q.x.toFixed(0) + 'px'; e.style.top = q.y.toFixed(0) + 'px';
        e.style.transform = 'translate(-50%, -50%) scale(' + q.s + ')';
        e.classList.toggle('sm', q.s < 1);
      }
    });
    Object.keys(crewEls).forEach(function (id) { if (!keep[id]) { crewEls[id].remove(); delete crewEls[id]; } });
  }
  function renderMap() {
    renderRooms(); renderCrew();
    $('m-ship').style.width = S.ship + '%'; $('m-pct').textContent = S.ship + '%';
    $('m-shipm').setAttribute('aria-valuenow', S.ship);
    var crew = S.inGame - S.bugCount;
    $('m-count').textContent = crew + ' crew · ' + (S.bugCount === 2 ? '2 secret Bugs' : '1 secret Bug');
    show('m-alarm', !!S.sabotage && S.phase === 'play');
    var big = null, small = '';
    if (S.paused) { big = 'PAUSED'; small = 'The station holder paused the game'; }
    else if (S.phase === 'roles') { big = 'SHHH!'; small = 'Check your phone for your secret role · ' + crew + ' crew, ' + (S.bugCount === 2 ? '2 secret Bugs' : '1 secret Bug'); }
    show('m-banner', !!big && S.phase !== 'meeting' && S.phase !== 'verdict'); show('m-shade', !!big && S.phase !== 'meeting' && S.phase !== 'verdict');
    if (big) { $('m-banner-big').textContent = big; $('m-banner-small').textContent = small; }
  }

  function fixPop(f) {
    if (!S || !crewEls[f.id]) return;
    var e = crewEls[f.id], x = parseFloat(e.style.left) || 0, y = parseFloat(e.style.top) || 0;
    var p = el('div', 'fixpop', 'FIXED! ✓'); p.style.left = x + 'px'; p.style.top = (y - 56) + 'px';
    $('pops').appendChild(p); setTimeout(function () { p.remove(); }, 1700);
    audio.fix();
  }

  // ---------- meeting ----------
  function renderMeeting() {
    var m = S.meeting, v = S.verdict, caller = m ? byId(m.by) : null;
    $('v-by').textContent = caller ? 'Called by ' + caller.name + (m.reason ? ' · "' + m.reason + '"' : '') : 'The vote is in';
    var voted = {}; (m ? m.voted : []).forEach(function (id) { voted[id] = 1; });
    var tallies = {};
    if (v && v.votes) Object.keys(v.votes).forEach(function (t) { tallies[t] = v.votes[t]; });
    var cards = $('v-cards'); cards.innerHTML = '';
    var ej = {}; (S.ejected || []).forEach(function (x) { ej[x.id] = x; });
    S.players.filter(function (p) { return !p.spectator; }).forEach(function (p, i) {
      var out = p.ghost && !(v && v.id === p.id);
      var c = el('div', 'a-card' + (out ? ' out' : '') + (v && v.id === p.id ? ' top' : ''));
      c.style.animationDelay = (i * 0.04).toFixed(2) + 's';
      var bw = el('div'); bw.style.position = 'relative'; bw.style.width = '50px'; bw.style.height = '60px'; bw.style.flex = 'none';
      var b = bean(out ? { hex: '#9aa1b8' } : p); b.style.margin = '3px 0 0 4px'; bw.appendChild(b); c.appendChild(bw);
      var info = el('div', 'info'); info.appendChild(el('b', null, p.name));
      var sub, cls = '';
      if (out) { sub = 'Thrown off · ' + (ej[p.id] && ej[p.id].wasBug ? 'was the Bug' : 'was crew'); cls = 'x'; }
      else if (v) sub = tallies[p.id] ? tallies[p.id].length + ' vote' + (tallies[p.id].length === 1 ? '' : 's') : 'No votes';
      else if (m && m.by === p.id) { sub = voted[p.id] ? 'Called it · voted' : 'Called the meeting'; cls = voted[p.id] ? 'v' : ''; }
      else { sub = voted[p.id] ? 'Voted' : 'Thinking…'; cls = voted[p.id] ? 'v' : ''; }
      info.appendChild(el('span', cls, sub)); c.appendChild(info);
      var dots = el('div', 'dots');
      (tallies[p.id] || []).forEach(function (vid) { var vp = byId(vid); var d = el('i'); d.style.background = vp ? vp.hex : '#fff'; dots.appendChild(d); });
      c.appendChild(dots);
      cards.appendChild(c);
    });
    if (v && v.skip) {
      var sc = el('div', 'a-card skipc'); var info2 = el('div', 'info'); info2.appendChild(el('b', null, 'Skipped')); info2.appendChild(el('span', null, v.skip + ' vote' + (v.skip === 1 ? '' : 's')));
      sc.appendChild(info2); var d2 = el('div', 'dots'); (v.votes.skip || []).forEach(function (vid) { var vp = byId(vid); var d = el('i'); d.style.background = vp ? vp.hex : '#fff'; d2.appendChild(d); }); sc.appendChild(d2);
      cards.appendChild(sc);
    }
    $('v-count').textContent = v ? 'The votes are in!' : (m ? m.voted.length : 0) + ' of ' + (m ? m.voters : 0) + ' voted';
    show('v-verdict', !!v);
    if (v) {
      var big = $('v-big');
      if (v.id) { big.textContent = v.name.toUpperCase() + (v.wasBug ? ' WAS THE BUG!' : ' WAS NOT THE BUG'); big.className = 'big ol4' + (v.wasBug ? ' bug' : ''); $('v-small').textContent = v.wasBug ? 'Thrown off the ship. Nice catch, crew!' : 'Thrown off the ship… the Bug is still aboard.'; }
      else { big.textContent = 'NOBODY WAS THROWN OFF'; big.className = 'big ol4'; $('v-small').textContent = v.tie ? 'It was a tie.' : 'Most of the ship skipped the vote.'; }
    }
  }

  // ---------- finished ----------
  function renderEnd() {
    var o = S.outcome || {}, crewWon = o.winner === 'crew';
    var t = $('e-title');
    t.textContent = o.winner ? (crewWon ? 'CREW WIN!' : (S.bugs && S.bugs.length > 1 ? 'THE BUGS WIN!' : 'THE BUG WINS!')) : 'GAME OVER';
    t.classList.toggle('bugs', o.winner === 'bugs');
    $('e-sub').textContent = REASON_TXT[o.reason] || '';
    var bugs = {}; (S.bugs || []).forEach(function (id) { bugs[id] = 1; });
    var box = $('e-reveal'); box.innerHTML = '';
    var list = S.players.filter(function (p) { return !p.spectator; });
    box.style.gridTemplateColumns = 'repeat(' + Math.min(5, Math.max(1, list.length)) + ', 1fr)';
    list.forEach(function (p, i) {
      var r = el('div', 'r' + (bugs[p.id] ? ' bug' : '')); r.style.animationDelay = (i * 0.08).toFixed(2) + 's';
      r.appendChild(bean(p)); var tx = el('div', 'tx'); r.appendChild(tx);
      tx.appendChild(el('b', null, p.name));
      tx.appendChild(el('span', 'tag', bugs[p.id] ? 'THE BUG' : 'CREW'));
      var fx = S.fixes && S.fixes[p.id];
      tx.appendChild(el('small', null, bugs[p.id] ? (p.ghost ? 'caught!' : 'never caught') : (fx || 0) + ' real fix' + (fx === 1 ? '' : 'es') + (p.ghost ? ' · thrown off' : '')));
      box.appendChild(r);
    });
    var st = $('e-stats'); st.innerHTML = '';
    [['Ship fixed', S.ship + '%'], ['Meetings', String(S.meetings || 0)], ['Thrown off', String((S.ejected || []).length)]].forEach(function (x) { st.appendChild(el('span', null, x[0] + ': ' + x[1])); });
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

  // ---------- clocks ----------
  function tick() {
    if (!S) return;
    var dt = S.paused ? 0 : Date.now() - recvAt;
    if (S.phase === 'play' || S.phase === 'roles') $('m-timer').textContent = mmss(S.timeLeft - (S.phase === 'play' ? dt : 0));
    if (S.sabotage && S.phase === 'play') {
      var r = null; S.rooms.forEach(function (x) { if (x.id === S.sabotage.room) r = x; });
      $('m-alarm-t').textContent = 'SABOTAGE! The ' + (r ? r.name : 'ship') + ' is crashing · fix it in ' + mmss(S.sabotage.ms - dt) + (S.sabotage.fixed ? ' · ' + S.sabotage.fixed + '/' + S.sabotage.need + ' fixed' : '');
    }
    if (S.phase === 'meeting') $('v-timer').textContent = mmss(S.endsIn - dt);
    if (S.phase === 'verdict') $('v-timer').textContent = '0:00';
  }
  setInterval(tick, 250);

  // ---------- station controls ----------
  var armed = null;
  function emit(ev) { socket.emit(ev, {}, function (res) { if (res && !res.ok) { if (res.code === 'STATION_CLOSED') { closed = true; hold('closed'); } else toast(res.error || 'Not allowed right now', true); } }); }
  function act(a) {
    if (!S) return;
    if (a === 'start' && S.phase === 'lobby') emit('among:start');
    else if (a === 'pause') emit('among:pause');
    else if (a === 'end') {
      if (armed === 'end') { armed = null; emit('among:end'); }
      else { armed = 'end'; toast('Press End again to finish the game now'); setTimeout(function () { if (armed === 'end') armed = null; }, 3000); }
    }
    else if (a === 'again' && S.phase === 'finished') emit('among:again');
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
