/* GDG RACE - phone controller. No framework: join -> wait -> steer. */
(function () {
  'use strict';
  var EVT = GDG.EVT, STATUS = GDG.STATUS, CARS = GDG.CARS, fmtTime = GDG.fmtTime;
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function show(id, on) { $(id).classList.toggle('hidden', !on); }
  var BASE = location.pathname.replace(/\/race(\/.*)?$/, ''); // this page is <base>/race/play

  // ---------- brand ----------
  var brand = $('brand');
  brand.innerHTML = '<span class="dots"><i></i><i></i><i></i><i></i></span><span>GDG RACE</span>';
  var logo = new Image();
  logo.onload = function () { brand.innerHTML = ''; brand.appendChild(logo); };
  logo.alt = 'GDG Assiut'; logo.src = BASE + '/assets/logo.png';

  // ---------- state ----------
  var socket = io({ path: BASE + '/socket.io', transports: ['websocket', 'polling'] });
  var params = new URLSearchParams(location.search);
  var urlCode = (params.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  var session = readSession();
  var me = null, status = STATUS.LOBBY, cdValue = null, laps = 3, board = null, results = null;
  var online = false, hostOnline = true, replaced = false, selectedCar = null, joinTimer = null;

  function readSession() { try { return JSON.parse(sessionStorage.getItem('gdg_player') || 'null'); } catch (e) { return null; } }
  function writeSession(s) { try { if (s) sessionStorage.setItem('gdg_player', JSON.stringify(s)); else sessionStorage.removeItem('gdg_player'); } catch (e) { /* private mode */ } session = s; }
  if (session && urlCode && session.code !== urlCode) writeSession(null); // scanned a different room's QR

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
      b.setAttribute('aria-pressed', c.id === selectedCar ? 'true' : 'false'); b.setAttribute('aria-label', c.name + ' car' + (c.taken ? ', taken' : ''));
      var sw = el('div', 'sw', c.id); b.appendChild(sw); b.appendChild(el('div', null, c.taken ? 'Taken' : c.name));
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
  function carToy(color, n) {
    return '<span class="toy" style="--c:' + color + '"><i class="wf t"></i><i class="wf b"></i><b class="body"><em>' + n + '</em></b></span>';
  }

  function enterPlay(player, info) {
    me = player; replaced = false;
    show('view-join', false); show('view-play', true);
    $('car-art').innerHTML = carToy(player.color, Number(player.carId) || 1); $('car-art').style.setProperty('--c', player.color);
    $('me-name').textContent = player.name; $('me-name').dir = 'auto';
    $('me-car').textContent = 'Car #' + player.carId + ' · ' + player.carName;
    $('result').style.setProperty('--c', player.color);
    if (info) applyRoom(info);
    refreshConn(); requestWake();
    clearInterval(joinTimer);
  }

  function leavePlay(message) {
    me = null; releaseAll(); writeSession(null);
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
      if (mine && mine.carId !== me.carId) { me.carId = mine.carId; me.color = mine.color; me.carName = mine.carName; enterPlay(me, null); }
    }
    if (status === STATUS.FINISHED && info.results) results = info.results;
    if (status === STATUS.LOBBY) { results = null; board = null; }
    render();
  }

  function myRow() { if (!board || !me) return null; return board.rows.filter(function (r) { return r.id === me.id; })[0] || null; }

  function render() {
    if (!me) return;
    var s = $('status'), cnt = $('count'), st = $('stats'), res = $('result');
    s.className = 'status'; cnt.classList.add('hidden'); res.classList.add('hidden'); st.textContent = '';
    if (replaced) { s.textContent = 'Controller opened on another device'; s.classList.add('bad'); }
    else if (!hostOnline && status !== STATUS.LOBBY) { s.textContent = 'Host disconnected - race paused'; s.classList.add('warn'); }
    else if (status === STATUS.LOBBY) { s.textContent = "You're in! Waiting for the host to start…"; }
    else if (status === STATUS.COUNTDOWN) { s.textContent = 'Get ready!'; s.classList.add('warn'); cnt.classList.remove('hidden'); cnt.textContent = cdValue == null ? '' : cdValue; }
    else if (status === STATUS.RACING) {
      s.textContent = 'GO GO GO! Hold LEFT / RIGHT'; s.classList.add('go');
      var r = myRow();
      if (r) st.innerHTML = '<span class="st"><i>LAP</i><b>' + r.lap + '/' + laps + '</b></span><span class="st"><i>POSITION</i><b>' + r.pos + '/' + board.rows.length + '</b></span>';
    }
    else if (status === STATUS.PAUSED) { s.textContent = 'Race paused'; s.classList.add('warn'); }
    else if (status === STATUS.ABORTED) { s.textContent = 'Race aborted by the host'; s.classList.add('bad'); }
    else if (status === STATUS.FINISHED) { s.textContent = 'Race finished!'; renderResult(res); }
    updatePads();
  }

  function renderResult(box) {
    var mine = results && results.filter(function (r) { return r.playerId === me.id; })[0];
    if (!mine) return;
    box.classList.remove('hidden'); box.innerHTML = '';
    var big = el('div', 'place'); var b = el('b', null, mine.resultStatus === 'DNF' ? 'DNF' : 'P' + mine.finishPosition);
    if (mine.finishPosition === 1 && mine.resultStatus !== 'DNF') big.innerHTML = TROPHY;
    big.appendChild(b); box.appendChild(big);
    box.appendChild(el('div', 'tm', mine.resultStatus === 'DNF' ? 'Did not finish (' + mine.completedLaps + ' laps)' : fmtTime(mine.finishTime)));
    var top = results.filter(function (r) { return r.resultStatus === 'Finished'; }).slice(0, 3);
    top.forEach(function (r) { var line = el('div', 'line', r.finishPosition + '. ' + r.name + '  ' + fmtTime(r.finishTime)); line.dir = 'auto'; box.appendChild(line); });
    if (navigator.vibrate) navigator.vibrate(mine.finishPosition === 1 ? [80, 60, 80, 60, 200] : 120);
  }

  var TROPHY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10v5a5 5 0 0 1-10 0z" fill="#FBBC04" stroke="#1B1340" stroke-width="1.5" stroke-linejoin="round"/>' +
    '<path d="M7 5H4a3 3 0 0 0 3 4.5M17 5h3a3 3 0 0 1-3 4.5" fill="none" stroke="#1B1340" stroke-width="1.5"/><path d="M10 13h4l1 4H9z" fill="#FBBC04" stroke="#1B1340" stroke-width="1.5" stroke-linejoin="round"/>' +
    '<rect x="7.5" y="17" width="9" height="3.5" rx="1" fill="#EA4335" stroke="#1B1340" stroke-width="1.5"/></svg>';

  // ---------- steering (SRS 5.6, 7.3) ----------
  var pressL = false, pressR = false, dir = 0, repeat = null;
  var padLeft = $('btn-left'), padRight = $('btn-right'), pads = $('pads');

  function canSteer() { return !!me && online && !replaced && status === STATUS.RACING && hostOnline; }
  function updatePads() {
    pads.classList.toggle('disabled', !canSteer());
    padLeft.classList.toggle('on', pressL && canSteer()); padRight.classList.toggle('on', pressR && canSteer());
    var nd = canSteer() ? (pressL ? 1 : 0) + (pressR ? -1 : 0) : 0; // +1 = left, -1 = right
    if (nd === dir) return;
    dir = nd;
    if (online) socket.emit(EVT.STEER, { dir: dir });
    if (dir !== 0 && navigator.vibrate) navigator.vibrate(8);
    clearInterval(repeat); repeat = null;
    if (dir !== 0) repeat = setInterval(function () { if (online) socket.volatile.emit(EVT.STEER, { dir: dir }); }, 120); // keep-alive while held
  }
  function releaseAll() { pressL = false; pressR = false; updatePads(); }

  function bindPad(btn, setter) {
    btn.addEventListener('touchstart', function (e) { e.preventDefault(); setter(true); updatePads(); }, { passive: false });
    var end = function (e) { e.preventDefault(); setter(e.targetTouches.length > 0); updatePads(); };
    btn.addEventListener('touchend', end, { passive: false });
    btn.addEventListener('touchcancel', end, { passive: false });
    // mouse / pen (desktop testing)
    btn.addEventListener('pointerdown', function (e) { if (e.pointerType === 'touch') return; btn.setPointerCapture(e.pointerId); setter(true); updatePads(); });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (n) {
      btn.addEventListener(n, function (e) { if (e.pointerType === 'touch') return; setter(false); updatePads(); });
    });
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }
  bindPad(padLeft, function (v) { pressL = v; });
  bindPad(padRight, function (v) { pressR = v; });

  // keyboard for testing on a laptop
  window.addEventListener('keydown', function (e) {
    if (!me || e.repeat) return;
    if (e.key === 'ArrowLeft' || e.key === 'a') { pressL = true; updatePads(); }
    if (e.key === 'ArrowRight' || e.key === 'd') { pressR = true; updatePads(); }
  });
  window.addEventListener('keyup', function (e) {
    if (e.key === 'ArrowLeft' || e.key === 'a') { pressL = false; updatePads(); }
    if (e.key === 'ArrowRight' || e.key === 'd') { pressR = false; updatePads(); }
  });
  // no scrolling / zooming while steering (SRS FR-064)
  document.addEventListener('touchmove', function (e) { if (me) e.preventDefault(); }, { passive: false });
  ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (n) { document.addEventListener(n, function (e) { e.preventDefault(); }); });
  window.addEventListener('blur', releaseAll);

  // keep the screen awake while racing
  var wake = null;
  function requestWake() { try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { wake = l; }, function () {}); } catch (e) { /* unsupported */ } }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && me) requestWake(); else releaseAll(); });

  // ---------- socket wiring ----------
  socket.on('connect', function () {
    online = true; refreshConn();
    if (session && !replaced) {
      socket.emit(EVT.RECONNECT_PLAYER, { code: session.code, key: session.key }, function (res) {
        if (res && res.ok) enterPlay(res.player, res.room);
        else { writeSession(null); leavePlay(res && res.error ? res.error : ''); }
      });
    } else if (!me) {
      loadRoomInfo();
      clearInterval(joinTimer); joinTimer = setInterval(loadRoomInfo, 3000);
    }
    updateJoinButton();
  });
  socket.on('disconnect', function () { online = false; releaseAll(); dir = 0; refreshConn(); updateJoinButton(); });

  socket.on(EVT.ROOM_UPDATE, function (info) { applyRoom(info); });
  socket.on(EVT.COUNTDOWN_UPDATE, function (c) { cdValue = c.value; if (navigator.vibrate && c.value <= 3) navigator.vibrate(30); render(); });
  socket.on(EVT.RACE_STARTED, function (r) { laps = r.totalLaps; cdValue = null; if (navigator.vibrate) navigator.vibrate(200); render(); });
  socket.on(EVT.LEADERBOARD_UPDATE, function (b) { board = b; if (status === STATUS.RACING || status === STATUS.PAUSED) render(); });
  socket.on(EVT.RACE_FINISHED, function (r) { results = r.results; status = STATUS.FINISHED; releaseAll(); render(); });
  socket.on(EVT.CONNECTION_STATUS, function (s) { if (typeof s.hostConnected === 'boolean') { hostOnline = s.hostConnected; refreshConn(); render(); } });
  socket.on(EVT.REPLACED, function () { replaced = true; releaseAll(); render(); });
  socket.on(EVT.KICKED, function (k) {
    if (!me) return;
    leavePlay(k && k.reason === 'removed' ? 'The host removed you from the room.' : k && k.reason === 'timeout' ? 'You were disconnected for too long.' : 'The room was closed.');
  });

  renderCars();
  updatePads();
})();
