/* HOT POTATO CODE - phone. Join -> wait -> when you hold the bomb, answer fast. The phone only ever sends
   { id, choice } for its own open question; the server decides everything else. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function show(id, on) { $(id).classList.toggle('hidden', !on); }
  var BASE = location.pathname.replace(/\/potato(\/.*)?$/, ''); // this page is <base>/potato/play
  var DARK_TEXT = { yellow: 1, pink: 1, cyan: 1, lime: 1, white: 1 };
  var STAGE_TXT = ['The fuse is lit', 'It\'s sparking…', 'It\'s hissing!', 'About to blow!'];

  var socket = io('/potato', { path: BASE + '/socket.io', transports: ['websocket', 'polling'] });
  var params = new URLSearchParams(location.search);
  var urlCode = (params.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  var KEY = 'gdg_potato_player';
  function readSession() { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function writeSession(s) { try { if (s) sessionStorage.setItem(KEY, JSON.stringify(s)); else sessionStorage.removeItem(KEY); } catch (e) { /* private mode */ } session = s; }
  var session = readSession();
  if (session && urlCode && session.code !== urlCode) writeSession(null);

  var Y = null, S = null, final = null, gone = null, online = false, recvAt = 0, lockedQ = 0, unlockAt = 0;
  $('r-code').value = urlCode || (session && session.code) || '';
  try { $('r-name').value = localStorage.getItem('gdg_name') || ''; } catch (e) { /* ignore */ }

  // ---------- join ----------
  function msg(t) { $('join-msg').textContent = t || ''; }
  $('join-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var code = $('r-code').value.trim().toUpperCase(), name = $('r-name').value.trim();
    if (code.length !== 4) return msg('Enter the 4-letter room code from the big screen.');
    if (!name) return msg('Pick a name.');
    if (!online) return msg('Connecting… try again in a second.');
    $('join-btn').disabled = true;
    socket.emit('potato:join', { code: code, name: name }, function (res) {
      $('join-btn').disabled = false;
      if (!res || !res.ok) return msg((res && res.error) || 'Could not join.');
      try { localStorage.setItem('gdg_name', name); } catch (e) { /* ignore */ }
      writeSession({ code: res.code, key: res.key });
      applyYou(res);
    });
  });

  function applyYou(y) {
    var newQ = y.question && (!Y || !Y.question || Y.question.id !== y.question.id);
    Y = y; gone = null; recvAt = Date.now();
    if (y.state) S = y.state;
    if (S && S.phase !== 'finished') final = null;
    if (newQ) { unlockAt = Date.now() + 350; if (navigator.vibrate) navigator.vibrate([60, 40, 60]); setTimeout(render, 360); }
    render();
  }

  socket.on('connect', function () {
    online = true; show('p-conn', false);
    if (session && session.key) {
      socket.emit('potato:reconnect', { code: session.code, key: session.key }, function (res) {
        if (res && res.ok) applyYou(res);
        else { writeSession(null); Y = null; render(); if (res && res.code === 'NO_ROOM') msg('That game has ended. Scan the QR on the big screen.'); }
      });
    } else render();
  });
  socket.on('disconnect', function () { online = false; show('p-conn', !!Y); });
  socket.on('potato:state', function (s) { S = s; if (Y) Y.state = s; if (s.phase !== 'finished') final = null; render(); });
  socket.on('potato:you', function (y) { applyYou(y); });
  socket.on('potato:final', function (f) { final = f; render(); });
  socket.on('potato:kicked', function () { gone = 'The game has ended. Thanks for playing!'; writeSession(null); render(); });
  socket.on('potato:replaced', function () { gone = 'You opened the game on another tab or device.'; render(); });

  // ---------- answer ----------
  function answer(i) {
    if (!Y || !Y.question || !S || S.phase !== 'live' || S.paused) return;
    if (lockedQ === Y.question.id || Date.now() < unlockAt) return;
    var qid = Y.question.id;
    lockedQ = qid; render();
    socket.emit('potato:answer', { id: qid, choice: i }, function (res) {
      if (!res || !res.ok) { if (lockedQ === qid) lockedQ = 0; render(); return; }
      if (res.correct) flash('THROWN!', false);
      else { flash(res.boom ? 'BOOM!' : '−2 s!', true); var f = $('g-fuse'); f.classList.remove('burn'); void f.offsetWidth; f.classList.add('burn'); if (navigator.vibrate) navigator.vibrate(200); }
    });
  }
  $('g-ans').addEventListener('click', function (ev) { var b = ev.target.closest('button[data-i]'); if (b) answer(Number(b.dataset.i)); });
  function flash(t, bad) { var f = el('div', 'pp-flash ol4' + (bad ? ' bad' : ''), t); document.body.appendChild(f); setTimeout(function () { f.remove(); }, 900); }

  // ---------- render ----------
  function byId(id) { if (!S) return null; for (var i = 0; i < S.players.length; i++) if (S.players[i].id === id) return S.players[i]; return null; }
  function faceEl(p, me) {
    var f = el('div', 'pp-face' + (DARK_TEXT[p.color] ? ' dark' : '') + (me ? ' me' : ''), p.name.slice(0, 2).toUpperCase());
    f.style.background = p.hex; return f;
  }
  function card(cls, h, p) { var c = el('div', 'pp-card' + (cls ? ' ' + cls : '')); if (h) c.appendChild(el('h2', null, h)); if (p) c.appendChild(el('p', null, p)); return c; }

  function render() {
    var inGame = !!Y && !gone;
    show('v-join', !inGame); show('v-game', inGame);
    if (gone) msg(gone);
    if (!inGame || !S) return;
    var me = Y.player, ph = S.phase;
    $('g-me').textContent = me.name + (S.round ? ' · round ' + S.round : '');
    $('g-alive').textContent = ph === 'lobby' ? S.players.length + ' / ' + S.max + ' players' : S.alive + ' still in';
    var hot = !!(Y.holding && Y.question && ph === 'live');
    var v = $('v-game');
    v.className = 'pp' + (hot && !S.paused ? ' hot' : '') + ((Y.out || Y.spectator) && ph !== 'lobby' && ph !== 'finished' ? ' out' : '');
    show('g-hot', hot); show('g-wait', !hot);
    if (hot) renderHot(); else renderWait();
    tick();
  }

  function renderHot() {
    var q = Y.question;
    $('g-kind').textContent = q.kind === 'tf' ? 'TRUE OR FALSE · quick!' : 'PICK ONE · quick!';
    $('g-prompt').textContent = q.prompt;
    $('g-code').textContent = q.code || ''; show('g-code', !!q.code);
    var btns = $('g-ans').querySelectorAll('button');
    var locked = lockedQ === q.id || Date.now() < unlockAt || S.paused;
    Array.prototype.forEach.call(btns, function (b, i) {
      var t = q.options[i];
      b.textContent = t; b.setAttribute('aria-label', 'Answer: ' + t);
      b.classList.toggle('long', t.length > 7);
      b.classList.toggle('mono', q.kind === 'pick' && /[<>()[\]#.:]|^\d/.test(t));
      b.disabled = locked;
    });
    if (S.paused) $('g-kind').textContent = 'PAUSED · the fuse is frozen';
  }

  function renderWait() {
    var box = $('g-wait'); box.innerHTML = '';
    var me = Y.player, ph = S.phase, h = byId(S.holder);
    if (final || ph === 'finished') {
      var f = final || {};
      if (f.winner) {
        box.appendChild(wrapHolder(faceEl(me, true), 'LAST ONE STANDING', 'YOU WIN!'));
        box.appendChild(card('good', 'Champion!', 'You never got caught with the bomb. Look at the big screen!'));
      } else {
        box.appendChild(card(f.outcome === 'ended' ? '' : 'bad', f.outcome === 'ended' ? 'Game over' : 'Nice try!', f.winnerName ? f.winnerName + ' was the last one standing.' : 'The station holder ended the game.'));
        if (f.place) { var c = card(null, null, null); c.appendChild(el('div', 'num', '#' + f.place)); c.appendChild(el('p', null, 'of ' + f.total + ' players · you threw the bomb ' + (f.passes || 0) + ' time' + (f.passes === 1 ? '' : 's'))); box.appendChild(c); }
      }
      box.appendChild(tips(['Stay close! The station can start another game.']));
      return;
    }
    if (ph === 'lobby') {
      box.appendChild(wrapHolder(faceEl(me, true), 'YOU\'RE IN THE CIRCLE', me.name));
      box.appendChild(card(null, 'Get ready!', 'Watch the big screen. The game starts when the station holder lights the fuse (4 to 12 players).'));
      box.appendChild(tips(['<b>Got the bomb?</b> Your phone flashes red with a quick question.', '<b>Right</b> throws it to a random player. <b>Wrong</b> burns 2 s.', 'Nobody knows how long the fuse is. <b>Last one standing wins!</b>']));
      return;
    }
    if (Y.spectator) {
      box.appendChild(card(null, 'Game in progress', 'You\'re in the next game. Watch the circle on the big screen!'));
      return;
    }
    if (Y.out) {
      var o = card('bad', 'BOOM! You\'re out', 'The bomb went off in your hands. Watch who survives on the big screen!');
      box.appendChild(wrapHolder(faceEl(me, true), 'OUT OF THE CIRCLE', me.name));
      box.appendChild(o);
      return;
    }
    if (S.paused) { box.appendChild(card(null, 'Paused', 'The station holder paused the game. The fuse is frozen.')); return; }
    if (Y.incoming) {
      box.appendChild(wrapHolder(bombEl(), 'INCOMING!', 'IT\'S COMING TO YOU!'));
      box.appendChild(card('bad', 'Get ready!', 'Read the question fast and tap the answer.'));
      return;
    }
    if (ph === 'boom') {
      var b = S.feed[0];
      box.appendChild(card('bad', 'BOOM!', (b && b.type === 'boom' ? b.name : 'Someone') + ' is out. You survived this round!'));
      box.appendChild(tips(['Next round starts in a moment with a <b>new secret fuse</b>.']));
      return;
    }
    if (h) {
      var mine = h.id === me.id;
      box.appendChild(wrapHolder(faceEl(h), ph === 'intro' ? 'ROUND ' + S.round + ' · IT STARTS WITH' : 'THE BOMB IS WITH', mine ? 'YOU!' : h.name + '!', true));
      var stage = el('div', 'pp-stage'); for (var i = 0; i < 4; i++) stage.appendChild(el('i', i <= S.stage && ph === 'live' ? 'on' : ''));
      var c2 = card(null, ph === 'intro' ? 'Get ready…' : STAGE_TXT[S.stage] || 'The fuse is lit', ph === 'intro' ? 'The fuse is secret: 6 to 15 seconds.' : 'Get ready, it could be thrown to you next!');
      c2.appendChild(stage);
      box.appendChild(c2);
      box.appendChild(tips(mine ? ['Read your question fast!'] : ['<b>If it lands on you</b> your phone turns red with a quick question.', '<b>Right</b> throws it on to a random player. <b>Wrong</b> burns 2 s.']));
    }
  }
  function wrapHolder(node, k, name, withBomb) {
    var w = el('div', 'pp-holder');
    w.appendChild(el('span', 'k', k));
    var row = el('div', 'row'); row.appendChild(node); if (withBomb) row.appendChild(bombEl()); w.appendChild(row);
    w.appendChild(el('h2', 'ol4', name));
    return w;
  }
  function bombEl() { var b = el('div', 'mini-bomb'); b.setAttribute('aria-hidden', 'true'); b.innerHTML = '<div class="ball"></div><span class="cap"></span><span class="spark"></span>'; return b; }
  function tips(list) { var t = el('div', 'pp-tips'); list.forEach(function (x) { var d = el('div'); d.innerHTML = x; t.appendChild(d); }); return t; }

  function tick() {
    if (!Y || !Y.holding || Y.fuseLeft == null || !S) return;
    var left = S.paused ? Y.fuseLeft : Math.max(0, Y.fuseLeft - (Date.now() - recvAt));
    $('g-secs').textContent = String(Math.ceil(left / 1000));
    $('g-fuse-bar').style.width = Math.max(0, Math.min(100, left / (Y.fuseCap || 15000) * 100)).toFixed(1) + '%';
    if (Date.now() >= unlockAt && lockedQ !== (Y.question && Y.question.id)) {
      Array.prototype.forEach.call($('g-ans').querySelectorAll('button'), function (b) { b.disabled = !!S.paused; });
    }
  }
  setInterval(tick, 100);

  render();
})();
