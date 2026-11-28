/* BOSS RAID - phone. Join -> wait -> answer each round -> see the result. The phone only ever sends an answer index. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function show(id, on) { $(id).classList.toggle('hidden', !on); }
  function fmt(n) { return Math.round(n || 0).toLocaleString('en-US'); }
  var BASE = location.pathname.replace(/\/raid(\/.*)?$/, ''); // this page is <base>/raid/play
  var TEAMS = [{ name: 'Blue', color: '#4285F4' }, { name: 'Red', color: '#EA4335' }, { name: 'Yellow', color: '#FBBC04' }, { name: 'Green', color: '#34A853' }];

  var socket = io('/raid', { path: BASE + '/socket.io', transports: ['websocket', 'polling'] });
  var params = new URLSearchParams(location.search);
  var urlCode = (params.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  var KEY = 'gdg_raid_player';
  function readSession() { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function writeSession(s) { try { if (s) sessionStorage.setItem(KEY, JSON.stringify(s)); else sessionStorage.removeItem(KEY); } catch (e) { /* private mode */ } session = s; }
  var session = readSession();
  if (session && urlCode && session.code !== urlCode) writeSession(null);

  var me = null, P = null, endsAt = 0, picked = null, pickedRound = 0, answeredThis = false, result = null, final = null, stats = { hits: 0, damage: 0, combo: 0 };
  var online = false, gone = null;

  $('r-code').value = urlCode || (session && session.code) || '';
  try { $('r-name').value = localStorage.getItem('gdg_name') || ''; } catch (e) { /* ignore */ }

  // ---------- join ----------
  function msg(t) { $('join-msg').textContent = t || ''; }
  $('join-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var code = $('r-code').value.trim().toUpperCase(), name = $('r-name').value.trim();
    if (code.length !== 4) return msg('Enter the 4-letter room code from the big screen.');
    if (!name) return msg('Pick a raider name.');
    if (!online) return msg('Connecting… try again in a second.');
    $('join-btn').disabled = true;
    socket.emit('raid:join', { code: code, name: name }, function (res) {
      $('join-btn').disabled = false;
      if (!res || !res.ok) return msg((res && res.error) || 'Could not join.');
      try { localStorage.setItem('gdg_name', name); } catch (e) { /* ignore */ }
      writeSession({ code: res.code, key: res.key });
      applyYou(res);
    });
  });

  function applyYou(res) {
    me = res.player; gone = null; final = null;
    stats = { hits: res.hits, damage: res.damage, combo: res.combo };
    answeredThis = !!res.answeredThis; result = res.lastResult && res.phase && res.lastResult.round === res.phase.round ? res.lastResult : null;
    if (!answeredThis) picked = null;
    applyPhase(res.phase);
  }

  socket.on('connect', function () {
    online = true; show('p-conn', false);
    if (session && session.key) {
      socket.emit('raid:reconnect', { code: session.code, key: session.key }, function (res) {
        if (res && res.ok) applyYou(res);
        else { writeSession(null); me = null; render(); if (res && res.code === 'NO_ROOM') msg('That raid has ended. Scan the QR on the big screen.'); }
      });
    } else render();
  });
  socket.on('disconnect', function () { online = false; show('p-conn', !!me); });
  socket.on('raid:phase', function (p) { applyPhase(p); });
  socket.on('raid:you', function (y) { applyYou(y); });
  socket.on('raid:result', function (r) {
    result = r.result; stats = { hits: r.hits, damage: r.damage, combo: r.combo };
    if (result && result.correct && navigator.vibrate) navigator.vibrate(60);
    render();
  });
  socket.on('raid:final', function (f) { final = f; stats.hits = f.hits; stats.damage = f.damage; render(); });
  socket.on('raid:kicked', function () { gone = 'The raid has ended. Thanks for playing!'; writeSession(null); render(); });
  socket.on('raid:replaced', function () { gone = 'You opened the raid on another tab or device.'; render(); });

  function applyPhase(p) {
    if (!p) return;
    var newRound = !P || p.round !== P.round || (p.phase === 'question' && P.phase !== 'question');
    if (p.phase === 'question' && newRound) { picked = null; answeredThis = false; result = null; if (navigator.vibrate) navigator.vibrate(30); }
    if (p.phase === 'lobby') { final = null; result = null; picked = null; answeredThis = false; if (P && P.phase !== 'lobby') stats = { hits: 0, damage: 0, combo: 0 }; }
    P = p; endsAt = Date.now() + (p.endsIn || 0);
    render();
  }

  // ---------- answer ----------
  function answer(i) {
    if (!P || P.phase !== 'question' || P.paused || answeredThis) return;
    answeredThis = true; picked = i; pickedRound = P.round;
    render();
    socket.emit('raid:answer', { round: P.round, choice: i }, function (res) {
      if (res && !res.ok && res.code !== 'DUPLICATE') { answeredThis = false; picked = null; render(); }
    });
  }
  $('g-ans').addEventListener('click', function (ev) { var b = ev.target.closest('button[data-i]'); if (b) answer(Number(b.dataset.i)); });

  // ---------- render ----------
  function render() {
    var inGame = !!me && !gone;
    show('v-join', !inGame); show('v-game', inGame);
    if (gone) { show('v-join', true); show('v-game', false); msg(gone); }
    if (!inGame) return;
    var t = TEAMS[me.team];
    $('v-game').style.setProperty('--tc', t.color);
    $('g-team').textContent = 'TEAM ' + t.name.toUpperCase();
    $('g-name').textContent = me.name;
    $('g-combo').classList.toggle('off', !stats.combo);
    $('g-combo-n').textContent = 'x' + (stats.combo || 0);
    $('g-hits').textContent = fmt(stats.hits); $('g-dmg').textContent = fmt(stats.damage);

    var ph = P ? P.phase : 'lobby', q = P && P.question;
    var showQ = (ph === 'question' || ph === 'reveal') && q && !final;
    show('g-main', showQ); show('g-wait', !showQ); show('g-timer', ph === 'question' || ph === 'reveal' || ph === 'intro');
    $('g-left').textContent = P && P.round ? String(P.round) : '1';
    $('g-tip').textContent = ph === 'question' ? 'Fast answers hit harder' : ph === 'reveal' ? 'Next round soon' : 'Watch the big screen';
    if (showQ) renderQuestion(ph, q); else renderWait(ph);
    tick();
  }

  function renderQuestion(ph, q) {
    var card = $('g-q');
    card.className = 'p-q';
    if (ph === 'reveal') {
      var r = result;
      var good = r && r.correct, bad = r && r.correct === false;
      card.className = 'p-q p-card ' + (good ? 'good' : bad ? 'bad' : '');
      $('g-prompt').textContent = good ? (r.crit ? 'CRITICAL HIT!' : 'HIT!') : bad ? 'Missed! Combo lost' : 'Too slow! Combo lost';
      $('g-code').textContent = good ? '-' + fmt(r.damage) + ' HP' + (r.combo > 1 ? '  ·  combo x' + r.combo : '') : 'The right answer is lit up below';
    } else {
      $('g-prompt').textContent = q.prompt;
      $('g-code').textContent = q.code || '';
      show('g-code', !!q.code);
    }
    if (ph === 'reveal') show('g-code', true);
    var box = $('g-ans');
    if (box.dataset.round !== String(P.round)) {
      box.innerHTML = ''; box.dataset.round = String(P.round);
      q.options.forEach(function (o, i) {
        var b = el('button', 'ans k' + i + (o.length > 4 ? ' long' : ''), o);
        b.type = 'button'; b.dataset.i = String(i); b.setAttribute('aria-label', 'Answer ' + (i + 1) + ': ' + o);
        box.appendChild(b);
      });
    }
    var locked = ph === 'question' && answeredThis;
    box.classList.toggle('locked', locked); box.classList.toggle('reveal', ph === 'reveal');
    Array.prototype.forEach.call(box.children, function (b, i) {
      b.disabled = ph !== 'question' || answeredThis || P.paused;
      b.classList.toggle('picked', picked === i && pickedRound === P.round);
      b.classList.toggle('right', ph === 'reveal' && P.correct === i);
    });
    if (locked) $('g-tip').textContent = 'Locked in! Waiting for the others…';
    if (P.paused) $('g-tip').textContent = 'Paused by the station';
  }

  function miniBoss() {
    var w = el('div', 'p-mini-boss'); w.setAttribute('aria-hidden', 'true');
    w.innerHTML = '<div class="boss"><span class="horn l"></span><span class="horn r"></span><div class="bod"><div class="eye"><svg viewBox="0 0 100 100"><path d="M50 50 m0 -6 a6 6 0 1 1 -6 6 a12 12 0 1 1 12 12 a20 20 0 1 1 -20 -20 a28 28 0 1 1 28 28 a36 36 0 0 1 -36 -36" fill="none" stroke="#1b1340" stroke-width="9" stroke-linecap="round"/></svg></div><div class="mouth"><i></i><i></i><i></i><i></i></div></div></div>';
    return w;
  }
  function renderWait(ph) {
    var box = $('g-wait'); box.innerHTML = '';
    var card = el('div', 'p-card');
    if (final) {
      var win = final.outcome === 'victory';
      card.className = 'p-card ' + (win ? 'good' : 'bad');
      card.appendChild(el('h2', null, win ? 'BOSS DEFEATED!' : 'The loop survives…'));
      if (final.finalHit) card.appendChild(el('p', null, 'You landed the FINAL HIT!'));
      card.appendChild(el('div', 'num', '#' + final.rank));
      card.appendChild(el('p', null, 'of ' + fmt(final.total) + ' raiders' + (final.topTeam === me.team ? ' · your team dealt the most damage!' : '')));
      var st = el('div', 'p-stats');
      [['HITS', fmt(final.hits)], ['DAMAGE', fmt(final.damage)], ['BEST', 'x' + (final.bestCombo || 0)]].forEach(function (s) { var d = el('div'); d.appendChild(el('b', null, s[1])); d.appendChild(el('span', null, s[0])); st.appendChild(d); });
      card.appendChild(st);
      box.appendChild(miniBoss()); box.appendChild(card);
      $('g-tip').textContent = 'Thanks for raiding!';
      return;
    }
    box.appendChild(miniBoss());
    if (P && P.paused) { card.appendChild(el('h2', null, 'Paused')); card.appendChild(el('p', null, 'The station holder paused the raid. Hang tight!')); }
    else if (ph === 'intro') { card.appendChild(el('h2', null, 'Get ready!')); card.appendChild(el('p', null, 'Round 1 is coming. Answer on this phone, fast and right!')); }
    else if (ph === 'finished') { card.appendChild(el('h2', null, 'Raid over')); card.appendChild(el('p', null, 'Look at the big screen for the results.')); }
    else {
      card.appendChild(el('h2', null, 'You\'re on Team ' + TEAMS[me.team].name + '!'));
      card.appendChild(el('p', null, 'Watch the big screen. The raid starts soon. Right answers hit the boss, fast answers hit harder, and streaks build a combo.'));
    }
    box.appendChild(card);
  }

  function tick() {
    if (!P || !me) return;
    var dur = P.duration || 1, left = P.paused ? (P.endsIn || 0) : Math.max(0, endsAt - Date.now());
    var running = P.phase === 'question' || P.phase === 'intro' || P.phase === 'reveal';
    $('g-bar').style.width = running ? Math.max(0, Math.min(100, left / dur * 100)).toFixed(1) + '%' : '0%';
    $('g-bar').style.background = P.phase === 'question' ? '' : '#d9d0ff';
  }
  setInterval(tick, 150);

  render();
})();
