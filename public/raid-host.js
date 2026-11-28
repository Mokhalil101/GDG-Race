/* BOSS RAID - big screen. Plain DOM on a fixed 1280x800 stage scaled to the window (projector friendly). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function show(id, on) { $(id).classList.toggle('hidden', !on); }
  function fmt(n) { return Math.round(n || 0).toLocaleString('en-US'); }
  var BASE = location.pathname.replace(/\/raid(\/.*)?$/, ''); // this page is <base>/raid/
  var TEAMS = [{ name: 'Blue', color: '#4285F4' }, { name: 'Red', color: '#EA4335' }, { name: 'Yellow', color: '#FBBC04' }, { name: 'Green', color: '#34A853' }];
  var RM = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ---------- stage ----------
  var stage = $('rstage');
  function fit() { var s = Math.min(window.innerWidth / 1280, window.innerHeight / 800); stage.style.transform = 'translate(-50%, -50%) scale(' + s + ')'; }
  window.addEventListener('resize', fit); fit();
  (function stars() {
    var box = $('stars'), rnd = function (i, m) { return (((Math.sin(i * 33.7) * 43758.5453) % 1) + 1) % 1 * m; };
    for (var i = 0; i < 40; i++) {
      var s = el('span', 'star');
      s.style.left = rnd(i, 1280).toFixed(0) + 'px'; s.style.top = rnd(i + 1, 800).toFixed(0) + 'px';
      s.style.animationDuration = (1.3 + rnd(i + 4, 2)).toFixed(1) + 's';
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

  // ---------- sound (tiny WebAudio synth) ----------
  var audio = {
    ctx: null, muted: (function () { try { return localStorage.getItem('gdg_muted') === '1'; } catch (e) { return false; } })(), lastHit: 0,
    ensure: function () { if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* none */ } } if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
    tone: function (f, d, type, vol, delay) {
      if (this.muted || !this.ctx) return;
      var t = this.ctx.currentTime + (delay || 0), o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = type || 'square'; o.frequency.value = f; g.gain.setValueAtTime(vol || 0.08, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g); g.connect(this.ctx.destination); o.start(t); o.stop(t + d + 0.02);
    },
    hit: function () { var n = Date.now(); if (n - this.lastHit < 90) return; this.lastHit = n; this.tone(180 + Math.random() * 120, 0.09, 'square', 0.07); },
    round: function () { this.tone(660, 0.12, 'triangle', 0.1); this.tone(990, 0.18, 'triangle', 0.1, 0.12); },
    win: function () { [523, 659, 784, 1046, 784, 1046, 1318].forEach(function (f, i) { audio.tone(f, 0.22, 'triangle', 0.12, i * 0.14); }); },
    lose: function () { [392, 330, 262, 196].forEach(function (f, i) { audio.tone(f, 0.3, 'sawtooth', 0.07, i * 0.22); }); },
  };
  ['click', 'keydown', 'touchstart'].forEach(function (ev) { window.addEventListener(ev, function () { audio.ensure(); }, { passive: true }); });
  function renderMute() { $('mute-lbl').textContent = audio.muted ? 'off' : 'on'; }
  renderMute();

  // ---------- state ----------
  var socket = io('/raid', { path: BASE + '/socket.io', transports: ['websocket', 'polling'] });
  var mode = null, code = null, S = null, P = null, endsAt = 0, closed = false, prevPhase = null, prevRound = 0;

  function toast(text, bad) {
    var t = el('div', bad ? 'bad' : '', text); $('toasts').appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }

  var HOLD = {
    locked: ['Hold on!', 'Games start at the game stations.', 'Find someone from the <b>Registration Team</b> (green badge) and they\'ll open a game for you.'],
    closed: ['Station closed', 'This station was closed by the Registration Team.', 'Thanks for raiding! The room has ended. Ask the <b>Registration Team</b> to open the station again for another raid.'],
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
    code = null; S = null; P = null; render();
  }
  hold('connecting');

  function create(secret) {
    if (closed) return;
    var payload = { origin: location.origin };
    if (mode === 'dev') {
      var saved = null;
      try { saved = sessionStorage.getItem('gdg_raid_code'); secret = secret || sessionStorage.getItem('gdg_secret'); } catch (e) { /* ignore */ }
      if (!secret) return hold('dev');
      payload.secret = secret; if (saved) payload.code = saved;
    }
    socket.emit('raid:create', payload, function (res) {
      if (!res || !res.ok) {
        if (res && res.code === 'STATION_CLOSED') { closed = true; return hold(res.variant === 'expired' ? 'expired' : 'closed'); }
        try { sessionStorage.removeItem('gdg_secret'); } catch (e) { /* ignore */ }
        return hold(mode === 'dev' ? 'dev' : 'locked', res && res.code !== 'STATION' ? res.error : '');
      }
      code = res.code;
      try { sessionStorage.setItem('gdg_raid_code', res.code); if (secret) sessionStorage.setItem('gdg_secret', secret); } catch (e) { /* ignore */ }
      $('qr').src = res.qr; $('l-code').textContent = res.code; $('l-url').textContent = res.joinUrl.replace(/^https?:\/\//, '');
      applyState(res.state); applyPhase(res.state);
    });
  }

  socket.on('hello', function (h) { mode = h && h.mode === 'dev' ? 'dev' : 'station'; create(); });
  socket.on('connect', function () { show('conn', false); });
  socket.on('disconnect', function () { show('conn', !closed); });
  socket.on('station-closed', function (d) { closed = true; hold(d && d.reason === 'expired' ? 'expired' : 'closed'); });
  socket.on('raid:kicked', function () { if (!closed) hold('locked'); });
  socket.on('raid:state', function (s) { applyState(s); });
  socket.on('raid:phase', function (p) { applyPhase(p); });
  socket.on('raid:hits', function (list) { hitFx(list); });
  socket.on('raid:joined', function (j) { addJoined(j); });
  $('dev-form').addEventListener('submit', function (ev) { ev.preventDefault(); var v = $('dev-secret').value; if (v) create(v); });

  // ---------- apply ----------
  function applyState(s) {
    if (!s) return;
    S = s;
    if (P == null || s.phase !== P.phase || s.round !== P.round || s.paused !== P.paused) applyPhase(s);
    render();
  }
  function applyPhase(p) {
    P = { phase: p.phase, paused: p.paused, round: p.round, rounds: p.rounds, question: p.question || (P && P.round === p.round ? P.question : null),
      correct: p.correct, duration: p.duration, endsIn: p.endsIn, outcome: p.outcome, finalHit: p.finalHit, topTeam: p.topTeam };
    endsAt = Date.now() + (p.endsIn || 0);
    if (S) { S.phase = p.phase; S.round = p.round; S.paused = p.paused; if (p.outcome) { S.outcome = p.outcome; S.finalHit = p.finalHit; S.topTeam = p.topTeam; } }
    if (p.phase === 'question' && (prevPhase !== 'question' || prevRound !== p.round)) audio.round();
    if (p.phase === 'finished' && prevPhase !== 'finished') { if (p.outcome === 'victory') { audio.win(); confetti(); } else audio.lose(); }
    if (p.phase === 'lobby' && prevPhase && prevPhase !== 'lobby') $('l-joined').innerHTML = '';
    prevPhase = p.phase; prevRound = p.round;
    render();
  }

  // ---------- render ----------
  function render() {
    var ph = code && S ? S.phase : null;
    show('s-hold', !ph);
    show('s-lobby', ph === 'lobby');
    show('s-fight', ph === 'intro' || ph === 'question' || ph === 'reveal');
    show('s-end', ph === 'finished');
    show('dock', !!ph);
    if (!ph) return;
    renderDock();
    if (ph === 'lobby') renderLobby();
    else if (ph === 'finished') renderEnd();
    else renderFight();
  }

  function renderDock() {
    var ph = S.phase, running = ph === 'intro' || ph === 'question' || ph === 'reveal';
    var vis = { start: ph === 'lobby', next: running, pause: running, end: running, mute: true, fullscreen: true };
    Array.prototype.forEach.call($('dock').querySelectorAll('[data-act]'), function (b) { b.classList.toggle('hidden', !vis[b.dataset.act]); });
    $('pause-lbl').textContent = S.paused ? 'Resume' : 'Pause';
  }

  function renderLobby() {
    $('l-count').textContent = fmt(S.players);
    var box = $('l-teams'); box.innerHTML = '';
    TEAMS.forEach(function (t, i) {
      var c = el('div', 'tchip t' + i); c.style.background = t.color;
      c.appendChild(el('b', null, String(S.teamCounts ? S.teamCounts[i] : 0))); c.appendChild(el('span', null, 'Team ' + t.name));
      box.appendChild(c);
    });
    $('b-start').disabled = !S.players;
    $('l-hint').textContent = S.players ? 'Press Space or START when the hall is in.' : 'Waiting for players…';
  }
  function addJoined(j) {
    var box = $('l-joined');
    var s = el('span'); var dot = el('i'); dot.style.background = TEAMS[j.team].color; s.appendChild(dot); s.appendChild(document.createTextNode(j.name));
    box.insertBefore(s, box.firstChild);
    while (box.children.length > 60) box.removeChild(box.lastChild);
  }

  function renderFight() {
    var ph = S.phase;
    $('f-round').textContent = 'Boss Raid · round ' + Math.max(1, S.round) + ' of ' + S.rounds;
    $('f-count').textContent = fmt(S.players);
    var pct = S.maxHp ? Math.max(0, S.hp / S.maxHp) : 1;
    $('f-hp').style.width = (pct * 100).toFixed(1) + '%';
    $('f-hp').classList.toggle('low', pct < 0.25);
    $('f-hptxt').textContent = fmt(S.hp) + ' / ' + fmt(S.maxHp) + ' HP';
    $('f-hpbar').setAttribute('aria-valuemax', S.maxHp); $('f-hpbar').setAttribute('aria-valuenow', S.hp);
    renderTeams(); renderMvps();
    // question bar
    var q = P && P.question, qb = $('qbar');
    qb.classList.toggle('reveal', ph === 'reveal');
    if (ph === 'intro' || !q) {
      $('q-prompt').textContent = 'Phones out! Round 1 is coming up…';
      $('q-code').textContent = 'while (hall.isReady()) attack();'; $('q-keys').innerHTML = '';
    } else {
      $('q-prompt').textContent = 'Hit the boss! ' + q.prompt;
      $('q-code').textContent = q.code || '';
      show('q-code', !!q.code);
      var keys = $('q-keys');
      if (keys.dataset.round !== String(S.round)) {
        keys.innerHTML = ''; keys.dataset.round = String(S.round);
        q.options.forEach(function (o, i) { keys.appendChild(el('span', 'key k' + i, o)); });
      }
      Array.prototype.forEach.call(keys.children, function (k, i) { k.classList.toggle('right', ph === 'reveal' && P.correct === i); });
    }
    $('q-clock').classList.toggle('calm', ph !== 'question');
    // banners
    var big = null, small = '';
    if (S.paused) { big = 'PAUSED'; small = 'The station holder paused the raid'; }
    else if (ph === 'intro') { big = 'GET READY'; small = 'Round 1 starts in a moment'; }
    show('f-banner', !!big);
    if (big) { $('f-banner-big').textContent = big; $('f-banner-small').textContent = small; }
    show('f-rbanner', ph === 'reveal' && !S.paused);
    if (ph === 'reveal') $('f-rbanner').textContent = 'Round ' + S.round + ' · ' + fmt(S.correctThisRound) + ' hits · ' + fmt(S.roundDamage) + ' damage';
    show('f-answered', ph === 'question');
    $('f-answered').textContent = fmt(S.answered) + ' / ' + fmt(S.players) + ' answered';
    tickClock();
  }
  function renderTeams() {
    var box = $('f-teams'); box.innerHTML = '';
    var max = 1, lead = -1;
    S.teams.forEach(function (t, i) { if (t.damage > max) { max = t.damage; lead = i; } });
    S.teams.forEach(function (t, i) {
      var row = el('div', 'team' + (i === lead ? ' lead' : '')), tt = el('div', 'tt');
      tt.appendChild(el('span', null, 'Team ' + TEAMS[i].name)); tt.appendChild(el('span', null, fmt(t.damage)));
      var tb = el('span', 'tb'), fill = el('i'); fill.style.background = TEAMS[i].color; fill.style.width = (t.damage / max * 96).toFixed(1) + '%';
      tb.appendChild(fill); row.appendChild(tt); row.appendChild(tb); box.appendChild(row);
    });
  }
  function renderMvps() {
    var box = $('f-mvps'); box.innerHTML = '';
    if (!S.top || !S.top.length) { box.appendChild(el('div', 'empty', 'First hits land here')); return; }
    S.top.forEach(function (m) {
      var r = el('div', 'mvp'), d = el('span', 'dot'); d.style.background = TEAMS[m.team].color;
      r.appendChild(d); r.appendChild(el('span', 'nm', m.name)); r.appendChild(el('b', null, 'x' + m.combo)); box.appendChild(r);
    });
  }
  function tickClock() {
    if (!S || !(S.phase === 'intro' || S.phase === 'question' || S.phase === 'reveal')) return;
    var left = S.paused ? Math.ceil((P.endsIn || 0) / 1000) : Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    $('q-clock').textContent = String(left);
  }
  setInterval(tickClock, 200);

  // ---------- hit effects ----------
  var fxCount = 0, bossTimer = null;
  function hitFx(list) {
    if (!list || !list.length || !S || S.phase === 'lobby') return;
    var box = $('hits'), boss = $('boss');
    list.forEach(function (h, n) {
      if (fxCount > 40) return;
      var a = Math.random() * Math.PI * 2, k = 0.85 + Math.random() * 0.3;
      var x = 640 + Math.cos(a) * 300 * k - 50, y = 390 + Math.sin(a) * 215 * k - 18;
      var text = h.crit ? 'CRIT -' + fmt(h.damage) : '-' + fmt(h.damage) + (h.combo >= 3 ? ' x' + h.combo + '!' : h.combo === 2 ? ' COMBO!' : '');
      var s = el('span', 'hitfx ol3' + (h.crit || h.combo >= 3 ? ' big' : ''), text);
      s.style.left = x.toFixed(0) + 'px'; s.style.top = y.toFixed(0) + 'px'; s.style.color = TEAMS[h.team].color;
      s.style.setProperty('--r', (n % 2 ? 6 : -6) + 'deg'); s.style.animationDelay = (n * 0.04).toFixed(2) + 's';
      box.appendChild(s); fxCount++;
      setTimeout(function () { s.remove(); fxCount--; }, 1500 + n * 40);
    });
    audio.hit();
    if (!RM) { boss.classList.remove('hit'); void boss.offsetWidth; boss.classList.add('hit'); clearTimeout(bossTimer); bossTimer = setTimeout(function () { boss.classList.remove('hit'); }, 200); }
  }

  // ---------- results ----------
  function renderEnd() {
    var win = S.outcome === 'victory';
    $('e-title').textContent = win ? 'BOSS DEFEATED!' : 'THE LOOP SURVIVES…';
    $('e-title').classList.toggle('defeat', !win);
    $('end-boss').classList.toggle('dead', win); $('e-stamp').textContent = win ? 'K.O.' : 'STILL UP';
    var total = S.teams.reduce(function (a, t) { return a + t.damage; }, 0);
    $('e-sub').textContent = fmt(S.players) + ' players · ' + Math.max(S.round, 1) + ' of ' + S.rounds + ' rounds · ' + fmt(total) + ' damage';
    var fh = S.finalHit;
    if (win && fh) {
      $('e-final').textContent = fh.name; setTeamChip($('e-final-team'), fh.team); $('e-final-meta').textContent = 'landed the last blow on The Infinite Loop';
      $('e-final').parentNode.firstChild.textContent = 'FINAL HIT';
    } else {
      $('e-final').parentNode.firstChild.textContent = 'BOSS HP LEFT';
      $('e-final').textContent = fmt(S.hp); $('e-final-team').innerHTML = '';
      $('e-final-meta').textContent = 'of ' + fmt(S.maxHp) + ' HP. So close - raid again!';
    }
    var tt = S.topTeam;
    if (tt == null) { $('e-team').textContent = '—'; $('e-team-meta').textContent = 'No hits this time'; }
    else { setTeamChip($('e-team'), tt); $('e-team-meta').textContent = fmt(S.teams[tt].damage) + ' damage · ' + (S.teamCounts ? S.teamCounts[tt] : '') + ' players'; }
    var bars = $('e-team-bars'); bars.innerHTML = '';
    var max = 1; S.teams.forEach(function (t) { max = Math.max(max, t.damage); });
    S.teams.forEach(function (t, i) {
      var row = el('div', 'team'), x = el('div', 'tt'); x.appendChild(el('span', null, 'Team ' + TEAMS[i].name)); x.appendChild(el('span', null, fmt(t.damage)));
      var tb = el('span', 'tb'), f = el('i'); f.style.background = TEAMS[i].color; f.style.width = (t.damage / max * 96).toFixed(1) + '%'; tb.appendChild(f);
      row.appendChild(x); row.appendChild(tb); bars.appendChild(row);
    });
    var ol = $('e-mvps'); ol.innerHTML = '';
    (S.top || []).forEach(function (m, i) {
      var li = el('li'), d = el('span', 'dot'); d.style.background = TEAMS[m.team].color;
      li.appendChild(el('b', null, (i + 1) + '.')); li.appendChild(d); li.appendChild(el('span', 'nm', m.name)); li.appendChild(el('b', null, fmt(m.damage)));
      ol.appendChild(li);
    });
    if (!S.top || !S.top.length) ol.appendChild(el('li', null, 'No hits this time'));
    var st = $('e-stats'); st.innerHTML = '';
    var best = (S.top || []).reduce(function (a, m) { return Math.max(a, m.combo); }, 0);
    [['Best combo', best ? 'x' + best : '—'], ['Boss HP', fmt(S.maxHp)], ['Damage dealt', fmt(total)]].forEach(function (p) { st.appendChild(el('span', 'pill', p[0] + ': ' + p[1])); });
  }
  function setTeamChip(node, team) {
    node.innerHTML = ''; var i = el('i'); i.style.background = TEAMS[team].color; node.appendChild(i); node.appendChild(document.createTextNode('Team ' + TEAMS[team].name));
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

  // ---------- station controls ----------
  var armed = null;
  function emit(ev) { socket.emit(ev, {}, function (res) { if (res && !res.ok) { if (res.code === 'STATION_CLOSED') { closed = true; hold('closed'); } else toast(res.error || 'Not allowed right now', true); } }); }
  function act(a) {
    if (!S) return;
    if (a === 'start' && S.phase === 'lobby') emit('raid:start');
    else if (a === 'next') emit('raid:next');
    else if (a === 'pause') emit('raid:pause');
    else if (a === 'end') {
      if (armed === 'end') { armed = null; emit('raid:end'); }
      else { armed = 'end'; toast('Press End again to finish the raid now'); setTimeout(function () { if (armed === 'end') armed = null; }, 3000); }
    }
    else if (a === 'again' && S.phase === 'finished') emit('raid:again');
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
    else if (k === 'n') act('next');
    else if (k === 'p') act('pause');
    else if (k === 'e') act('end');
    else if (k === 'm') act('mute');
    else if (k === 'f') act('fullscreen');
  });

  render();
})();
