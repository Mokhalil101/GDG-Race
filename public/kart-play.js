/* CODE KART BATTLE - phone controller: join -> steer + use your item -> answer item-box questions (5 s). */
(function () {
  'use strict';
  var EVT = GDG.EVT, STATUS = GDG.STATUS, fmtTime = GDG.fmtTime;
  var CARS = KART.CARS, ITEMS = KART.ITEMS, KEV = KART.EV, RULES = KART.RULES;
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function show(id, on) { $(id).classList.toggle('hidden', !on); }
  var BASE = location.pathname.replace(/\/kart(\/.*)?$/, ''); // this page is <base>/kart/play

  // ---------- item icons (inline SVG, ink outlines) ----------
  var ICON = {
    bomb: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="13" r="8" fill="#1b1340" stroke="#fff6e0" stroke-width="2"/><path d="M16 7l3-3" stroke="#fbbc04" stroke-width="2.5" stroke-linecap="round"/><circle cx="20" cy="3.5" r="2" fill="#ea4335"/><circle cx="8.5" cy="10.5" r="2" fill="#fff" opacity=".55"/></svg>',
    turbo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 1.5 4 13.5h6.5L9 22.5l10-12.5h-6.5z" fill="#fbbc04" stroke="#1b1340" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z" fill="#4285f4" stroke="#1b1340" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 5.2 7 7v4.2c0 3.2 2 6 5 7.4" fill="none" stroke="#c7ddff" stroke-width="1.8" stroke-linecap="round"/></svg>',
    firewall: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 9c0-3 2-4 2-6 2 1 3 3 3 5 1-1 1-2 1-3 2 1.5 4 3.5 4 6" fill="#fbbc04" stroke="#1b1340" stroke-width="1.6" stroke-linejoin="round"/><rect x="2" y="10" width="20" height="11" rx="2" fill="#ea4335" stroke="#1b1340" stroke-width="1.8"/><path d="M2.8 15.5h18.4M8 10.5v5M15 10.5v5M5 15.5v5M11.5 15.5v5M18 15.5v5" stroke="#ffd1c9" stroke-width="1.2"/></svg>',
  };
  var USE_TXT = { bomb: 'Hits the kart ahead · TAP TO THROW', turbo: 'Speed burst · TAP TO BOOST', shield: 'Blocks the next hit · TAP TO RAISE', firewall: 'Blocks the lane behind · TAP TO DROP' };

  // ---------- brand ----------
  var brand = $('brand');
  brand.innerHTML = '<span class="dots"><i></i><i></i><i></i><i></i></span><span>CODE KART</span>';
  var logo = new Image();
  logo.onload = function () { brand.innerHTML = ''; brand.appendChild(logo); };
  logo.alt = 'GDG Assiut'; logo.src = BASE + '/assets/logo.png';

  // ---------- state ----------
  var socket = io('/kart', { path: BASE + '/socket.io', transports: ['websocket', 'polling'] });
  var params = new URLSearchParams(location.search);
  var urlCode = (params.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  var SKEY = 'gdg_kart_player';
  var session = readSession();
  var me = null, status = STATUS.LOBBY, cdValue = null, laps = 3, board = null, results = null;
  var online = false, hostOnline = true, replaced = false, selectedCar = null, joinTimer = null;
  var you = { item: null, streak: 0, spin: false, shield: false, boost: false, question: null, lastResult: null };
  var q = null, qDeadline = 0, qAnswered = false, verdictTimer = null, rafId = null;

  function readSession() { try { return JSON.parse(sessionStorage.getItem(SKEY) || 'null'); } catch (e) { return null; } }
  function writeSession(s) { try { if (s) sessionStorage.setItem(SKEY, JSON.stringify(s)); else sessionStorage.removeItem(SKEY); } catch (e) { /* private mode */ } session = s; }
  if (session && urlCode && session.code !== urlCode) writeSession(null);

  // ---------- connection indicator ----------
  function setConn(kind, text) { var c = $('conn'); c.className = 'conn ' + kind; c.lastChild.textContent = text; }
  function refreshConn() {
    if (!online) return setConn('bad', 'Reconnecting…');
    if (me && !hostOnline) return setConn('bad', 'Host offline');
    setConn('ok', 'Connected');
  }

  // ---------- join view ----------
  $('code').value = urlCode || (session && session.code) || '';
  $('name').value = (function () { try { return localStorage.getItem('gdg_name') || ''; } catch (e) { return ''; } })();
  var lastInfo = null;
  function msg(text, info) { var m = $('join-msg'); m.textContent = text || ''; m.className = 'msg' + (info ? ' info' : ''); }

  function loadRoomInfo() {
    var code = $('code').value.trim().toUpperCase();
    if (code.length !== 4 || !online) { lastInfo = null; renderCars(); return; }
    socket.emit(EVT.ROOM_INFO, { code: code }, function (res) {
      if (code !== $('code').value.trim().toUpperCase()) return;
      lastInfo = res && res.ok ? res : null;
      if (!res || !res.ok) msg(res && res.error ? res.error : 'Room not found.');
      else if (!res.joinable) msg(res.reason);
      else if ($('join-msg').textContent && !$('join-msg').classList.contains('info')) msg('');
      renderCars();
    });
  }

  function renderCars() {
    var box = $('cars'); box.innerHTML = '';
    var cars = lastInfo ? lastInfo.cars : CARS.map(function (c) { return { id: c.id, name: c.name, color: c.color, taken: false }; });
    if (lastInfo) {
      var cur = cars.filter(function (c) { return c.id === selectedCar; })[0];
      if (!cur || cur.taken) { var free = cars.filter(function (c) { return !c.taken; })[0]; selectedCar = free ? free.id : null; }
    }
    cars.forEach(function (c) {
      var b = el('button', 'carbtn' + (c.id === selectedCar ? ' sel' : '')); b.type = 'button';
      b.style.setProperty('--c', c.color); b.disabled = c.taken || (lastInfo && !lastInfo.joinable);
      b.setAttribute('aria-pressed', c.id === selectedCar ? 'true' : 'false'); b.setAttribute('aria-label', c.name + ' kart' + (c.taken ? ', taken' : ''));
      b.appendChild(el('div', 'sw', c.id)); b.appendChild(el('div', null, c.taken ? 'Taken' : c.name));
      b.addEventListener('click', function () { selectedCar = c.id; renderCars(); });
      box.appendChild(b);
    });
    var pick = cars.filter(function (c) { return c.id === selectedCar; })[0] || cars[0];
    if (pick) { $('hero-car').style.setProperty('--c', pick.color); $('hero-num').textContent = pick.id; }
    updateJoinButton();
  }
  function updateJoinButton() {
    $('join').disabled = !(online && lastInfo && lastInfo.joinable && selectedCar && $('name').value.trim().length > 0);
  }
  $('code').addEventListener('input', function () { this.value = this.value.toUpperCase().replace(/[^A-Z]/g, ''); msg(''); loadRoomInfo(); });
  $('name').addEventListener('input', updateJoinButton);

  $('join').addEventListener('click', function () {
    var name = $('name').value.trim(), code = $('code').value.trim().toUpperCase();
    $('join').disabled = true; msg('Joining…', true);
    socket.emit(EVT.JOIN_ROOM, { code: code, name: name, carId: selectedCar }, function (res) {
      if (!res || !res.ok) {
        msg((res && res.error) || 'Could not join.');
        if (res && (res.code === 'CAR_TAKEN' || res.code === 'RACE_STARTED' || res.code === 'ROOM_FULL')) loadRoomInfo();
        return updateJoinButton();
      }
      try { localStorage.setItem('gdg_name', name); } catch (e) { /* ignore */ }
      writeSession({ code: code, key: res.key, id: res.player.id });
      enterPlay(res.player, res.room);
    });
  });

  // ---------- play view ----------
  function enterPlay(player, info) {
    me = player; replaced = false;
    show('view-join', false); show('view-play', true);
    $('car-art').innerHTML = '<span class="toy" style="--c:' + player.color + '"><i class="wf t"></i><i class="wf b"></i><b class="body"><em>' + (Number(player.carId) || 1) + '</em></b></span>';
    ['me', 'q'].forEach(function (k) {
      $(k + '-sw').style.background = player.color;
      $(k + '-name').textContent = player.name; $(k + '-name').dir = 'auto';
    });
    $('result').style.setProperty('--c', player.color);
    if (info) applyRoom(info);
    refreshConn(); requestWake();
    clearInterval(joinTimer);
  }

  function leavePlay(message) {
    me = null; releaseAll(); writeSession(null); closeQuestion();
    show('view-play', false); show('view-join', true);
    msg(message || '', !!message); selectedCar = null; loadRoomInfo();
    clearInterval(joinTimer); joinTimer = setInterval(loadRoomInfo, 3000);
    refreshConn();
  }

  function applyRoom(info) {
    status = info.status; laps = info.settings.laps; hostOnline = info.hostConnected;
    if (me) {
      var mine = info.players.filter(function (p) { return p.id === me.id; })[0];
      if (!mine && !replaced) return leavePlay('You are no longer in this room.');
    }
    if (status === STATUS.FINISHED && info.results) results = info.results;
    if (status === STATUS.LOBBY) { results = null; board = null; }
    if (status !== STATUS.RACING) closeQuestion();
    render();
  }

  function myRow() { if (!board || !me) return null; return board.rows.filter(function (r) { return r.id === me.id; })[0] || null; }

  function posText() {
    var r = myRow();
    if (r && (status === STATUS.RACING || status === STATUS.PAUSED)) return 'P' + r.pos + ' · Lap ' + r.lap + '/' + laps;
    return laps + ' laps';
  }

  function render() {
    if (!me) return;
    var s = $('status'), cnt = $('count'), res = $('result');
    s.className = 'status'; cnt.classList.add('hidden'); res.classList.add('hidden');
    $('me-pos').textContent = posText(); $('q-pos').textContent = posText();
    var racing = status === STATUS.RACING;
    if (replaced) { s.textContent = 'Controller opened on another device'; s.classList.add('bad'); }
    else if (!hostOnline && status !== STATUS.LOBBY) { s.textContent = 'Host disconnected - race paused'; s.classList.add('warn'); }
    else if (status === STATUS.LOBBY) { s.textContent = "You're in! Waiting for the host to start…"; }
    else if (status === STATUS.COUNTDOWN) { s.textContent = 'Get ready!'; s.classList.add('warn'); cnt.classList.remove('hidden'); cnt.textContent = cdValue == null ? '' : cdValue; }
    else if (racing && you.spin) { s.textContent = 'SPIN OUT! Hold on…'; s.classList.add('bad'); }
    else if (racing && you.boost) { s.textContent = 'TURBO! Zoom zoom!'; s.classList.add('warn'); }
    else if (racing) { s.textContent = 'Steer into the ? boxes!'; s.classList.add('go'); }
    else if (status === STATUS.PAUSED) { s.textContent = 'Race paused'; s.classList.add('warn'); }
    else if (status === STATUS.ABORTED) { s.textContent = 'Race aborted by the host'; s.classList.add('bad'); }
    else if (status === STATUS.FINISHED) { s.textContent = 'Race finished!'; renderResult(res); }
    renderItem();
    updatePads();
  }

  function renderItem() {
    var b = $('item'), it = you.item, fin = status === STATUS.FINISHED || status === STATUS.ABORTED;
    show('item', !fin); show('streak', !fin);
    b.className = 'k-itembtn' + (it ? ' has ' + it : '') + (you.shield ? ' shielded' : '');
    b.disabled = !(it && status === STATUS.RACING && !you.spin && online && hostOnline);
    $('item-icon').innerHTML = it ? ICON[it] : '<span class="qbox">?</span>';
    $('item-name').textContent = it ? 'USE ' + ITEMS[it].name.toUpperCase() + '!' : you.shield ? 'Shield is up!' : 'No item yet';
    $('item-hint').textContent = it ? USE_TXT[it] : you.shield ? 'It blocks the next Bug Bomb or Firewall' : 'Drive over a ? box to win one';
    if (it) b.style.setProperty('--ic', ITEMS[it].color); else b.style.removeProperty('--ic');
    var dots = $('streak').querySelectorAll('i');
    for (var i = 0; i < dots.length; i++) dots[i].classList.toggle('on', i < you.streak);
  }

  function renderResult(box) {
    var mine = results && results.filter(function (r) { return r.playerId === me.id; })[0];
    if (!mine) return;
    box.classList.remove('hidden'); box.innerHTML = '';
    var big = el('div', 'place'); var b = el('b', null, mine.resultStatus === 'DNF' ? 'DNF' : 'P' + mine.finishPosition);
    if (mine.finishPosition === 1 && mine.resultStatus !== 'DNF') big.innerHTML = TROPHY;
    big.appendChild(b); box.appendChild(big);
    box.appendChild(el('div', 'tm', mine.resultStatus === 'DNF' ? 'Did not finish (' + mine.completedLaps + ' laps)' : fmtTime(mine.finishTime)));
    box.appendChild(el('div', 'k-mystats', (mine.right || 0) + ' right answers · ' + (mine.hits || 0) + (mine.hits === 1 ? ' hit' : ' hits')));
    results.filter(function (r) { return r.resultStatus === 'Finished'; }).slice(0, 3).forEach(function (r) {
      var line = el('div', 'line', r.finishPosition + '. ' + r.name + '  ' + fmtTime(r.finishTime)); line.dir = 'auto'; box.appendChild(line);
    });
  }

  var TROPHY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10v5a5 5 0 0 1-10 0z" fill="#FBBC04" stroke="#1B1340" stroke-width="1.5" stroke-linejoin="round"/>' +
    '<path d="M7 5H4a3 3 0 0 0 3 4.5M17 5h3a3 3 0 0 1-3 4.5" fill="none" stroke="#1B1340" stroke-width="1.5"/><path d="M10 13h4l1 4H9z" fill="#FBBC04" stroke="#1B1340" stroke-width="1.5" stroke-linejoin="round"/>' +
    '<rect x="7.5" y="17" width="9" height="3.5" rx="1" fill="#EA4335" stroke="#1B1340" stroke-width="1.5"/></svg>';

  // ---------- use item ----------
  function useItem() {
    if (!you.item || $('item').disabled) return;
    var it = you.item;
    $('item').disabled = true;
    socket.emit(KEV.USE, {}, function (res) {
      if (res && res.ok) { if (navigator.vibrate) navigator.vibrate(it === 'bomb' ? [40, 30, 90] : 60); }
      render();
    });
  }
  $('item').addEventListener('click', useItem);

  // ---------- item-box question ----------
  var TILE = ['#1A73E8', '#D93025', '#1E8E3E', '#A142F4'];
  function openQuestion(nq) {
    if (!nq || (q && q.id === nq.id)) return;
    q = nq; qAnswered = false; qDeadline = Date.now() + nq.endsIn;
    clearTimeout(verdictTimer); show('q-verdict', false);
    releaseAll();
    $('q-prompt').textContent = nq.prompt;
    $('q-code').textContent = nq.code; show('q-code', !!nq.code);
    $('q-win').textContent = 'Right answer: ' + ITEMS[nq.item].name;
    $('q-icon').innerHTML = ICON[nq.item];
    var box = $('q-answers'); box.innerHTML = '';
    nq.options.forEach(function (opt, i) {
      var b = el('button', 'kq-ans', opt); b.type = 'button'; b.style.setProperty('--c', TILE[i]); b.dataset.i = i; b.dir = 'ltr';
      b.addEventListener('click', function () { answer(i); });
      box.appendChild(b);
    });
    show('view-q', true); show('view-play', false);
    if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
    tickTimer();
  }
  function tickTimer() {
    cancelAnimationFrame(rafId);
    if (!q) return;
    var left = Math.max(0, qDeadline - Date.now()), dur = q.duration || RULES.QUESTION_SEC * 1000;
    $('q-bar').style.width = (100 * left / dur) + '%';
    $('q-secs').textContent = Math.ceil(left / 1000) + ' s';
    $('q-bar').classList.toggle('low', left < 2000);
    if (left > 0 && !qAnswered) rafId = requestAnimationFrame(tickTimer);
  }
  function answer(i) {
    if (!q || qAnswered) return;
    qAnswered = true;
    var tiles = $('q-answers').children;
    for (var k = 0; k < tiles.length; k++) { tiles[k].disabled = true; tiles[k].classList.toggle('picked', k === i); }
    socket.emit(KEV.ANSWER, { id: q.id, choice: i }, function (res) {
      if (!res || !res.ok) { verdict({ kind: 'timeout', answer: null }); return; }
      verdict(res, i);
    });
  }
  function verdict(r, picked) {
    if (!q) return;
    var tiles = $('q-answers').children;
    for (var k = 0; k < tiles.length; k++) {
      tiles[k].disabled = true;
      tiles[k].classList.toggle('right', r.answer === k);
      tiles[k].classList.toggle('wrong', picked === k && r.answer !== k);
    }
    var v = $('q-verdict');
    v.className = 'kq-verdict ' + r.kind;
    if (r.kind === 'right') v.innerHTML = '<b>RIGHT!</b><span>' + (r.streakTurbo ? '3 in a row · TURBO! + ' : 'You got a ') + ITEMS[r.item].name + '</span>';
    else if (r.kind === 'wrong') v.innerHTML = '<b>WRONG!</b><span>Spin out for 2 s</span>';
    else v.innerHTML = '<b>TOO SLOW!</b><span>No item this time</span>';
    if (navigator.vibrate) navigator.vibrate(r.kind === 'right' ? [60, 40, 120] : 300);
    qAnswered = true; cancelAnimationFrame(rafId);
    clearTimeout(verdictTimer);
    verdictTimer = setTimeout(closeQuestion, 1300);
  }
  function closeQuestion() {
    clearTimeout(verdictTimer); cancelAnimationFrame(rafId);
    q = null; qAnswered = false;
    show('view-q', false); show('q-verdict', false);
    if (me) show('view-play', true);
    render();
  }

  function applyYou(y) {
    if (!y) return;
    you = y;
    if (y.question) openQuestion(y.question);
    else if (q && !qAnswered) {
      // the server closed it (time ran out, race over…): show how it went
      if (y.lastResult && y.lastResult.qid === q.id) verdict(y.lastResult, null); else closeQuestion();
    }
    render();
  }

  // ---------- steering ----------
  var pressL = false, pressR = false, dir = 0, repeat = null;
  var padLeft = $('btn-left'), padRight = $('btn-right'), pads = $('pads');

  function canSteer() { return !!me && online && !replaced && status === STATUS.RACING && hostOnline && !q && !you.spin; }
  function updatePads() {
    pads.classList.toggle('disabled', !canSteer());
    padLeft.classList.toggle('on', pressL && canSteer()); padRight.classList.toggle('on', pressR && canSteer());
    var nd = canSteer() ? (pressL ? 1 : 0) + (pressR ? -1 : 0) : 0; // +1 = left, -1 = right
    if (nd === dir) return;
    dir = nd;
    if (online) socket.emit(EVT.STEER, { dir: dir });
    if (dir !== 0 && navigator.vibrate) navigator.vibrate(8);
    clearInterval(repeat); repeat = null;
    if (dir !== 0) repeat = setInterval(function () { if (online) socket.volatile.emit(EVT.STEER, { dir: dir }); }, 120);
  }
  function releaseAll() { pressL = false; pressR = false; updatePads(); }

  function bindPad(btn, setter) {
    btn.addEventListener('touchstart', function (e) { e.preventDefault(); setter(true); updatePads(); }, { passive: false });
    var end = function (e) { e.preventDefault(); setter(e.targetTouches.length > 0); updatePads(); };
    btn.addEventListener('touchend', end, { passive: false });
    btn.addEventListener('touchcancel', end, { passive: false });
    btn.addEventListener('pointerdown', function (e) { if (e.pointerType === 'touch') return; btn.setPointerCapture(e.pointerId); setter(true); updatePads(); });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (n) {
      btn.addEventListener(n, function (e) { if (e.pointerType === 'touch') return; setter(false); updatePads(); });
    });
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }
  bindPad(padLeft, function (v) { pressL = v; });
  bindPad(padRight, function (v) { pressR = v; });

  // keyboard for testing on a laptop: arrows steer, space uses the item, 1-4 answer
  window.addEventListener('keydown', function (e) {
    if (!me || e.repeat) return;
    if (q && /^[1-4]$/.test(e.key)) { answer(Number(e.key) - 1); return; }
    if (e.key === ' ') { e.preventDefault(); useItem(); return; }
    if (e.key === 'ArrowLeft' || e.key === 'a') { pressL = true; updatePads(); }
    if (e.key === 'ArrowRight' || e.key === 'd') { pressR = true; updatePads(); }
  });
  window.addEventListener('keyup', function (e) {
    if (e.key === 'ArrowLeft' || e.key === 'a') { pressL = false; updatePads(); }
    if (e.key === 'ArrowRight' || e.key === 'd') { pressR = false; updatePads(); }
  });
  document.addEventListener('touchmove', function (e) { if (me) e.preventDefault(); }, { passive: false });
  ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (n) { document.addEventListener(n, function (e) { e.preventDefault(); }); });
  window.addEventListener('blur', releaseAll);

  var wake = null;
  function requestWake() { try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { wake = l; }, function () {}); } catch (e) { /* unsupported */ } }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && me) requestWake(); else releaseAll(); });

  // ---------- socket wiring ----------
  socket.on('connect', function () {
    online = true; refreshConn();
    if (session && !replaced) {
      socket.emit(EVT.RECONNECT_PLAYER, { code: session.code, key: session.key }, function (res) {
        if (res && res.ok) { enterPlay(res.player, res.room); applyYou(res.you); }
        else { writeSession(null); leavePlay(res && res.error ? res.error : ''); }
      });
    } else if (!me) {
      loadRoomInfo();
      clearInterval(joinTimer); joinTimer = setInterval(loadRoomInfo, 3000);
    }
    updateJoinButton();
  });
  socket.on('disconnect', function () { online = false; releaseAll(); dir = 0; refreshConn(); updateJoinButton(); render(); });

  socket.on(EVT.ROOM_UPDATE, function (info) { applyRoom(info); });
  socket.on(EVT.COUNTDOWN_UPDATE, function (c) { cdValue = c.value; if (navigator.vibrate && c.value <= 3) navigator.vibrate(30); render(); });
  socket.on(EVT.RACE_STARTED, function (r) { laps = r.totalLaps; cdValue = null; status = STATUS.RACING; if (navigator.vibrate) navigator.vibrate(200); render(); });
  socket.on(EVT.LEADERBOARD_UPDATE, function (b) {
    board = b;
    if (status === STATUS.RACING || status === STATUS.PAUSED) { $('me-pos').textContent = posText(); $('q-pos').textContent = posText(); }
  });
  socket.on(EVT.RACE_FINISHED, function (r) { results = r.results; status = STATUS.FINISHED; releaseAll(); closeQuestion(); render(); });
  socket.on(EVT.CONNECTION_STATUS, function (s) { if (typeof s.hostConnected === 'boolean') { hostOnline = s.hostConnected; refreshConn(); render(); } });
  socket.on(EVT.REPLACED, function () { replaced = true; releaseAll(); closeQuestion(); render(); });
  socket.on(EVT.KICKED, function (k) {
    if (!me) return;
    leavePlay(k && k.reason === 'removed' ? 'The host removed you from the room.' : k && k.reason === 'timeout' ? 'You were disconnected for too long.' : 'The room was closed.');
  });
  socket.on(KEV.QUESTION, function (nq) { if (me) openQuestion(nq); });
  socket.on(KEV.YOU, function (y) { if (me) applyYou(y); });

  renderCars();
  updatePads();
})();
