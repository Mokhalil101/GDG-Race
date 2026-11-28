/* AMONG BUGS - phone. Join -> secret role -> walk between rooms, fix code (crew) or fake / swap / sabotage (Bug),
   meetings and votes. The phone only sends its own actions; the server checks every one of them. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function show(id, on) { $(id).classList.toggle('hidden', !on); }
  function mmss(ms) { var s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  var BASE = location.pathname.replace(/\/among(\/.*)?$/, ''); // this page is <base>/among/play
  var ROOMS = [['bridge', 'Bridge', '#4285f4'], ['lab', 'Lab', '#34a853'], ['server', 'Server Room', '#ea4335'], ['cafe', 'Cafeteria', '#fbbc04'], ['engine', 'Engine', '#a142f4']];
  var RNAME = {}; ROOMS.forEach(function (r) { RNAME[r[0]] = r[1]; });

  var socket = io('/among', { path: BASE + '/socket.io', transports: ['websocket', 'polling'] });
  var params = new URLSearchParams(location.search);
  var urlCode = (params.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  var KEY = 'gdg_among_player';
  function readSession() { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function writeSession(s) { try { if (s) sessionStorage.setItem(KEY, JSON.stringify(s)); else sessionStorage.removeItem(KEY); } catch (e) { /* private mode */ } session = s; }
  var session = readSession();
  if (session && urlCode && session.code !== urlCode) writeSession(null);

  var Y = null, S = null, final = null, gone = null, online = false, yAt = 0, sAt = 0, note = '', noteBad = false, sabTarget = null, askReason = false, busy = false, lastKey = '';
  $('r-code').value = urlCode || (session && session.code) || '';
  try { $('r-name').value = localStorage.getItem('gdg_name') || ''; } catch (e) { /* ignore */ }

  // ---------- join ----------
  function msg(t) { $('join-msg').textContent = t || ''; }
  $('join-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var code = $('r-code').value.trim().toUpperCase(), name = $('r-name').value.trim();
    if (code.length !== 4) return msg('Enter the 4-letter room code from the big screen.');
    if (!name) return msg('Pick a crewmate name.');
    if (!online) return msg('Connecting… try again in a second.');
    $('join-btn').disabled = true;
    socket.emit('among:join', { code: code, name: name }, function (res) {
      $('join-btn').disabled = false;
      if (!res || !res.ok) return msg((res && res.error) || 'Could not join.');
      try { localStorage.setItem('gdg_name', name); } catch (e) { /* ignore */ }
      writeSession({ code: res.code, key: res.key });
      applyYou(res);
    });
  });

  function applyYou(y) {
    var hadRole = Y && Y.role;
    Y = y; gone = null; yAt = Date.now();
    if (y.state) { S = y.state; sAt = yAt; }
    if (S && S.phase !== 'finished') final = null;
    if (y.role && !hadRole && navigator.vibrate) navigator.vibrate(120);
    render();
  }
  socket.on('connect', function () {
    online = true; show('p-conn', false);
    if (session && session.key) {
      socket.emit('among:reconnect', { code: session.code, key: session.key }, function (res) {
        if (res && res.ok) applyYou(res);
        else { writeSession(null); Y = null; render(); if (res && res.code === 'NO_ROOM') msg('That game has ended. Scan the QR on the big screen.'); }
      });
    } else render();
  });
  socket.on('disconnect', function () { online = false; show('p-conn', !!Y); });
  socket.on('among:state', function (s) {
    if (S && s.phase !== S.phase) { askReason = false; if (s.phase === 'meeting' && navigator.vibrate) navigator.vibrate([100, 60, 100]); }
    if (s.sabotage && !(S && S.sabotage) && navigator.vibrate) navigator.vibrate([200, 80, 200]);
    S = s; sAt = Date.now(); if (Y) Y.state = s; if (s.phase !== 'finished') final = null; render();
  });
  socket.on('among:you', function (y) { applyYou(y); });
  socket.on('among:final', function (f) { final = f; render(); });
  socket.on('among:kicked', function () { gone = 'The game has ended. Thanks for playing!'; writeSession(null); render(); });
  socket.on('among:replaced', function () { gone = 'You opened the game on another tab or device.'; render(); });

  function send(ev, data, after) {
    if (busy) return;
    busy = true;
    socket.emit(ev, data || {}, function (res) {
      busy = false;
      if (!res || !res.ok) { setNote((res && res.error) || 'Not right now.', true); }
      if (after) after(res || {});
      render(true);
    });
  }
  function setNote(t, bad) { note = t || ''; noteBad = !!bad; lastKey = ''; }

  // ---------- render ----------
  function byId(id) { if (!S) return null; for (var i = 0; i < S.players.length; i++) if (S.players[i].id === id) return S.players[i]; return null; }
  function bean(hex, extra) {
    var b = el('div', 'bean' + (extra ? ' ' + extra : '')); b.style.setProperty('--c', hex);
    b.appendChild(el('div', 'pack')); var body = el('div', 'body'); body.appendChild(el('span', 'visor')); b.appendChild(body); return b;
  }
  function card(cls, h, p) { var c = el('div', 'ap-card' + (cls ? ' ' + cls : '')); if (h) c.appendChild(el('h2', null, h)); if (p) c.appendChild(el('p', null, p)); return c; }
  function tips(list) { var t = el('div', 'ap-tips'); list.forEach(function (x) { var d = el('div'); d.innerHTML = x; t.appendChild(d); }); return t; }
  function btn(cls, html, on, disabled) { var b = el('button', 'ap-btn ' + cls); b.type = 'button'; b.innerHTML = html; b.disabled = !!disabled; if (on) b.addEventListener('click', on); return b; }
  function cd(endAt, fmt) { var s = el('span', 'cd'); s.dataset.end = String(endAt); s.dataset.fmt = fmt || ''; return s; }
  function bugArt(sm) {
    var a = el('div', 'bugart' + (sm ? ' sm' : '')); a.setAttribute('aria-hidden', 'true');
    a.innerHTML = '<div class="b"><span class="ant l"></span><span class="ant r"></span><span class="knob l"></span><span class="knob r"></span><div class="shell"><span class="seam"></span><span class="eye l"></span><span class="eye r"></span><span class="grin"></span></div></div>';
    return a;
  }
  function roleBlock(role, sm) {
    var r = el('div', 'ap-role' + (role === 'crew' ? ' crew' : '') + (sm ? ' sm' : ''));
    r.appendChild(el('span', null, 'YOUR SECRET ROLE'));
    var h = el('h1', 'ol5'); h.innerHTML = role === 'bug' ? 'YOU ARE<br>THE BUG' : 'YOU ARE<br>CREW'; r.appendChild(h);
    return r;
  }

  /** Re-render only when something visible changed (timers tick separately), so taps never land on a rebuilt button. */
  function viewKey() {
    if (!Y || !S) return 'none';
    var me = byId(Y.player.id) || {};
    return JSON.stringify([S.phase, S.paused, Y.role, Y.ghost, Y.spectator, Y.room, Y.walk && Y.walk.to, Y.task && [Y.task.id, Y.task.step], Y.lock > 0, Y.byRoom,
      Y.meetingsLeft, Y.vote, !!Y.fake, Y.swapCd > 0, Y.sabCd > 0, S.sabotage && [S.sabotage.room, S.sabotage.fixed], S.meeting && S.meeting.voted.length, S.verdict && S.verdict.id,
      S.aboard, S.players.map(function (p) { return p.id + (p.ghost ? 'g' : ''); }).join(), final && final.winner, note, sabTarget, askReason, S.ship, me.room]);
  }

  function render(force) { draw(force); tick(); }
  function draw(force) {
    var inGame = !!Y && !gone;
    show('v-join', !inGame); show('v-game', inGame);
    if (gone) msg(gone);
    if (!inGame || !S) return;
    var key = viewKey();
    if (!force && key === lastKey) return;
    lastKey = key;
    var me = Y.player, ph = S.phase;
    $('g-name').textContent = me.name + ' · ' + me.color; $('g-dot').style.background = me.hex;
    var right = $('g-right'); right.className = 'right'; right.textContent = '';
    var v = $('v-game'), body = $('g-body'); body.innerHTML = '';
    var bugPlay = Y.role === 'bug' && !Y.ghost && (ph === 'roles' || ph === 'play');
    v.className = 'ap' + (bugPlay ? ' bug' : '') + (ph === 'meeting' || ph === 'verdict' ? ' meet' : '') + (Y.ghost && ph === 'play' ? ' ghost' : '') + (Y.role === 'crew' ? ' crewv' : '');
    if (Y.role === 'bug' && (ph === 'roles' || ph === 'play')) { right.textContent = 'Hide your screen!'; right.className = 'right warn'; }
    else if (ph === 'play') { var s = el('span', 'ship', 'SHIP ' + S.ship + '%'); right.appendChild(s); }

    if (final || ph === 'finished') return renderFinal(body);
    if (Y.spectator) { body.appendChild(card(null, 'Game in progress', 'You\'re in the next game. Watch the ship on the big screen!')); return; }
    if (ph === 'lobby') return renderLobby(body);
    if (S.paused) { body.appendChild(card(null, 'Paused', 'The station holder paused the game.')); return; }
    if (ph === 'roles') return renderRole(body);
    if (ph === 'meeting') return renderVote(body);
    if (ph === 'verdict') return renderVerdict(body);
    if (Y.role === 'bug') return renderBug(body);
    if (Y.task) return renderTask(body);
    return renderCrew(body);
  }

  function renderLobby(body) {
    var h = el('div', 'ap-hero'); h.appendChild(bean(Y.player.hex, 'big')); h.appendChild(el('h2', 'ol4', 'You\'re aboard!')); body.appendChild(h);
    body.appendChild(card(null, 'Wait for launch', 'When the station holder starts, your phone shows your SECRET role. Don\'t let anyone see it!'));
    body.appendChild(tips(['<b>Crew:</b> walk to rooms and fix the code there.', '<b>The Bug:</b> fake fixes, swap lines, sabotage rooms.', '<b>Meetings:</b> talk, then vote someone off the ship.']));
  }

  function renderRole(body) {
    body.appendChild(roleBlock(Y.role));
    if (Y.role === 'bug') {
      body.appendChild(bugArt(false));
      body.appendChild(el('p', 'ap-lead', 'Break the ship without getting caught. Pretend to fix code like everyone else.'));
      if (Y.allies && Y.allies.length) { var a = byId(Y.allies[0]); if (a) body.appendChild(el('p', 'ap-lead', 'The other Bug is ' + a.name + '. Keep it secret!')); }
      body.appendChild(tips(['<b>Fake a fix:</b> looks real on the big screen, adds nothing.', '<b>Swap a line:</b> the next task in your room gets an extra step.', '<b>Sabotage a room:</b> if the crew miss the timer, you win.']));
    } else {
      var h = el('div', 'ap-hero'); h.appendChild(bean(Y.player.hex, 'big')); body.appendChild(h);
      body.appendChild(el('p', 'ap-lead', 'Walk to rooms and fix the code there. Watch who fixes what: ' + (S.bugCount === 2 ? 'two Bugs are' : 'one Bug is') + ' faking it!'));
      body.appendChild(tips(['<b>Pick a room</b> on your phone, walk there, then fix the code.', '<b>Sabotage alarm?</b> Two of you must fix it in that room, fast!', '<b>Suspicious?</b> Call a meeting and vote them off.']));
    }
    var c = el('p', 'ap-note'); c.appendChild(document.createTextNode('The ship launches in ')); c.appendChild(cd(sAt + S.endsIn, 's')); body.appendChild(c);
  }

  function whereCard() {
    var w = el('div', 'ap-where');
    if (Y.walk) {
      w.appendChild(el('span', 'k', 'WALKING TO'));
      w.appendChild(el('b', null, RNAME[Y.walk.to]));
      var bar = el('div', 'walkbar'), i = el('i'); i.dataset.end = String(yAt + Y.walk.ms); i.dataset.dur = '3000'; bar.appendChild(i); w.appendChild(bar);
    } else {
      w.appendChild(el('span', 'k', Y.ghost ? 'YOUR GHOST IS IN' : 'YOU\'RE IN'));
      w.appendChild(el('b', null, RNAME[Y.room] || '—'));
    }
    return w;
  }
  function roomsGrid(sub) {
    var g = el('div', 'ap-rooms');
    ROOMS.forEach(function (r) {
      var b = el('button', 'ap-room'); b.type = 'button'; b.style.setProperty('--rc', r[2]);
      var here = !Y.walk && Y.room === r[0], going = Y.walk && Y.walk.to === r[0];
      var sab = S.sabotage && S.sabotage.room === r[0];
      b.classList.toggle('here', here || going); b.classList.toggle('sab', !!sab);
      b.appendChild(document.createTextNode(r[1]));
      b.appendChild(el('small', null, sab ? 'CRASHING! Go fix it' : here ? 'You are here' : going ? 'Walking…' : sub(r[0])));
      b.disabled = here || !!Y.walk;
      b.addEventListener('click', function () { setNote(''); send('among:move', { room: r[0] }); });
      g.appendChild(b);
    });
    return g;
  }
  function alarm() {
    if (!S.sabotage) return null;
    var a = el('div', 'ap-alarm');
    a.appendChild(document.createTextNode('SABOTAGE! ' + RNAME[S.sabotage.room] + ' crashing · '));
    a.appendChild(cd(sAt + S.sabotage.ms));
    a.appendChild(document.createTextNode(' · ' + S.sabotage.fixed + '/' + S.sabotage.need + ' fixed'));
    return a;
  }
  function meetingButton() {
    if (Y.ghost) return null;
    var wrap = el('div');
    if (askReason) {
      var chips = el('div', 'ap-chips');
      chips.appendChild(el('span', 'lbl', 'Why?'));
      (Y.reasons || []).forEach(function (r) { var b = el('button', null, r); b.type = 'button'; b.addEventListener('click', function () { askReason = false; send('among:meeting', { reason: r }); }); chips.appendChild(b); });
      var x = el('button', null, 'Cancel'); x.type = 'button'; x.addEventListener('click', function () { askReason = false; render(true); }); chips.appendChild(x);
      wrap.appendChild(chips);
      return wrap;
    }
    var left = Y.meetingsLeft;
    var b = btn('ghostb', left > 0 ? 'Call a meeting' + (left > 1 ? ' (' + left + ' left)' : '') : 'Meeting used', function () { askReason = true; setNote(''); render(true); }, left <= 0 || !!S.sabotage);
    wrap.appendChild(b);
    return wrap;
  }
  function noteEl() { return el('p', 'ap-note' + (noteBad ? ' bad' : ''), note); }

  function renderCrew(body) {
    if (Y.ghost) body.appendChild(el('div', 'ap-alarm', 'You were thrown off… keep fixing code as a ghost!')).style.animation = 'none';
    var a = alarm(); if (a) body.appendChild(a);
    body.appendChild(whereCard());
    var acts = el('div', 'ap-acts top');
    var inSab = S.sabotage && !Y.walk && Y.room === S.sabotage.room;
    var done = !inSab && Y.byRoom && (Y.byRoom[Y.room] || 0) >= Y.cap;
    var label = inSab ? 'FIX THE SABOTAGE!' : Y.walk ? 'Walking…' : done ? 'Room done: try another' : 'FIX CODE HERE';
    if (Y.lock > 0) { label = 'Ouch! Wait '; }
    var fb = btn(inSab ? 'red' : 'green', label, function () { setNote(''); send('among:task', {}); }, !!Y.walk || done || Y.lock > 0);
    if (Y.lock > 0) fb.appendChild(cd(yAt + Y.lock, 's'));
    acts.appendChild(fb);
    acts.appendChild(noteEl());
    body.appendChild(acts);
    body.appendChild(el('p', 'ap-note', 'WALK TO ANOTHER ROOM'));
    body.appendChild(roomsGrid(function (id) { var n = (Y.byRoom && Y.byRoom[id]) || 0; return n >= Y.cap ? 'You fixed it all' : 'You fixed ' + n + '/' + Y.cap; }));
    var m = meetingButton(); if (m) { m.className = 'ap-foot'; body.appendChild(m); }
  }

  function renderTask(body) {
    var t = Y.task;
    var a = alarm(); if (a) body.appendChild(a);
    var tc = el('div', 'ap-task');
    var k = el('div', 'k' + (t.steps > 1 ? ' swap' : ''));
    k.appendChild(el('span', null, (t.sab ? 'SABOTAGE FIX · ' : 'TASK · ') + RNAME[t.room]));
    k.appendChild(el('span', null, t.steps > 1 ? 'Step ' + t.step + ' of ' + t.steps + ' · a line was swapped!' : (t.kind === 'fix' ? 'Fix the line' : 'Quick check')));
    tc.appendChild(k);
    tc.appendChild(el('b', null, t.prompt));
    if (t.code) { var pre = el('pre', null, t.code); pre.dir = 'ltr'; tc.appendChild(pre); }
    body.appendChild(tc);
    var tb = el('div', 'ap-timer'), ti = el('i'); ti.dataset.end = String(yAt + t.endsIn); ti.dataset.dur = String(t.duration); tb.appendChild(ti); body.appendChild(tb);
    var opts = el('div', 'ap-opts'); opts.setAttribute('role', 'group'); opts.setAttribute('aria-label', 'Answers');
    t.options.forEach(function (o, i) {
      var b = el('button', 'ap-opt', o); b.type = 'button'; b.dir = 'ltr';
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(opts.children, function (x) { x.disabled = true; });
        send('among:answer', { id: t.id, choice: i }, function (res) {
          if (res.ok && res.correct && res.next) setNote('Step done! One more…');
          else if (res.ok && res.correct) setNote(t.sab ? 'Sabotage part fixed!' : 'Fixed! Nice work.');
          else if (res.ok) setNote('Wrong fix… try again in a moment.', true);
        });
      });
      opts.appendChild(b);
    });
    body.appendChild(opts);
    body.appendChild(el('p', 'ap-note', 'Moving to another room cancels this task.'));
  }

  function renderBug(body) {
    if (Y.ghost) { body.appendChild(roleBlock('bug', true)); body.appendChild(card('bad', 'You were caught!', 'You were thrown off the ship. Watch the big screen.')); return; }
    body.appendChild(roleBlock('bug', true));
    body.appendChild(bugArt(true));
    var a = alarm(); if (a) body.appendChild(a);
    var lead = el('p', 'ap-lead', Y.walk ? 'Sneaking to the ' + RNAME[Y.walk.to] + '…' : 'You\'re in the ' + RNAME[Y.room] + '. Act natural.');
    body.appendChild(lead);
    var walk = el('div', 'ap-chips'); walk.appendChild(el('span', 'lbl', 'Walk to'));
    ROOMS.forEach(function (r) {
      var b = el('button', (!Y.walk && Y.room === r[0]) || (Y.walk && Y.walk.to === r[0]) ? 'here' : '', r[1]); b.type = 'button';
      b.disabled = !!Y.walk || Y.room === r[0];
      b.addEventListener('click', function () { setNote(''); send('among:move', { room: r[0] }); });
      walk.appendChild(b);
    });
    body.appendChild(walk);
    var acts = el('div', 'ap-acts');
    if (!sabTarget) sabTarget = 'server';
    var sabRow = el('div', 'ap-sabrow');
    var sabLbl = '<svg width="26" height="26" viewBox="0 0 24 24" fill="#fff" stroke="#1b1340" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>';
    var sb;
    if (S.sabotage) sb = btn('red', sabLbl + 'Sabotage running…', null, true);
    else if (Y.sabCd > 0) { sb = btn('red', sabLbl + 'Sabotage in ', null, true); sb.appendChild(cd(yAt + Y.sabCd)); }
    else sb = btn('red', sabLbl + 'Sabotage the ' + RNAME[sabTarget], function () { setNote(''); send('among:sabotage', { room: sabTarget }, function (r) { if (r.ok) setNote('Alarm! Now blend in…'); }); });
    sabRow.appendChild(sb);
    var sw = el('button', 'swap', 'Change room'); sw.type = 'button'; sw.setAttribute('aria-label', 'Change the room to sabotage');
    sw.addEventListener('click', function () { var i = ROOMS.findIndex(function (r) { return r[0] === sabTarget; }); sabTarget = ROOMS[(i + 1) % ROOMS.length][0]; render(true); });
    sabRow.appendChild(sw);
    acts.appendChild(sabRow);
    var row = el('div', 'ap-row2');
    var fake;
    if (Y.fake) { fake = btn('cream', 'Faking…<small></small>', null, true); fake.querySelector('small').appendChild(cd(yAt + Y.fake.ms)); }
    else fake = btn('cream', 'Fake a fix<small>looks real</small>', function () { setNote(''); send('among:fake', {}); }, !!Y.walk);
    var swap;
    if (Y.swapCd > 0) { swap = btn('cream', 'Swap a line<small>ready in </small>', null, true); swap.querySelector('small').appendChild(cd(yAt + Y.swapCd)); }
    else swap = btn('cream', 'Swap a line<small>next task here: harder</small>', function () { setNote(''); send('among:swap', {}, function (r) { if (r.ok) setNote('Line swapped in the ' + RNAME[r.room] + '. Sneaky!'); }); }, !!Y.walk);
    row.appendChild(fake); row.appendChild(swap); acts.appendChild(row);
    acts.appendChild(noteEl());
    var m = meetingButton(); if (m) acts.appendChild(m);
    body.appendChild(acts);
  }

  function renderVote(body) {
    var m = S.meeting, caller = m && byId(m.by);
    body.appendChild(el('h1', 'ap-meet-h ol5', 'EMERGENCY MEETING!'));
    var sub = el('div', 'ap-meet-sub'); sub.appendChild(el('span', null, caller ? 'Called by ' + caller.name : 'Meeting')); var b = el('b'); b.appendChild(cd(sAt + S.endsIn)); sub.appendChild(b); body.appendChild(sub);
    if (m && m.reason) body.appendChild(el('p', 'ap-lead', '"' + m.reason + '"')).style.color = '#fff6e0';
    if (Y.ghost) { body.appendChild(card(null, 'You can\'t vote', 'You were thrown off the ship. Watch the big screen!')); return; }
    var grid = el('div', 'ap-votes');
    S.players.filter(function (p) { return !p.spectator && !p.ghost; }).forEach(function (p) {
      var x = el('button', 'ap-vote' + (p.id === Y.player.id ? ' me' : '') + (Y.vote === p.id ? ' picked' : '')); x.type = 'button';
      x.appendChild(bean(p.hex)); x.appendChild(el('span', null, p.id === Y.player.id ? p.name + ' (you)' : p.name));
      x.disabled = !!Y.vote;
      x.addEventListener('click', function () { send('among:vote', { target: p.id }); });
      grid.appendChild(x);
    });
    var sk = el('button', 'ap-vote ap-skip' + (Y.vote === 'skip' ? ' picked' : ''), 'Skip vote'); sk.type = 'button'; sk.disabled = !!Y.vote;
    sk.addEventListener('click', function () { send('among:vote', { target: 'skip' }); });
    grid.appendChild(sk);
    body.appendChild(grid);
    var votedFor = Y.vote ? (Y.vote === 'skip' ? 'You skipped.' : 'You voted for ' + ((byId(Y.vote) || {}).name || '?') + '.') : 'Talk it out, then tap who you think is the Bug.';
    body.appendChild(el('p', 'ap-note', votedFor + ' ' + (m ? m.voted.length + ' of ' + m.voters + ' voted' : '')));
  }

  function renderVerdict(body) {
    var v = S.verdict || {};
    body.appendChild(el('h1', 'ap-meet-h ol5', 'THE VOTES ARE IN'));
    var p = v.id && byId(v.id);
    if (p) {
      var h = el('div', 'ap-hero'); h.appendChild(bean(p.hex, 'big')); body.appendChild(h);
      body.appendChild(card(v.wasBug ? 'good' : 'bad', p.id === Y.player.id ? 'You were thrown off!' : p.name + ' was thrown off', v.wasBug ? (p.id === Y.player.id ? 'They caught you, Bug!' : p.name + ' WAS the Bug! Nice catch.') : (p.id === Y.player.id ? 'But you were crew… keep fixing code as a ghost.' : p.name + ' was NOT the Bug…')));
    } else body.appendChild(card(null, 'Nobody was thrown off', v.tie ? 'It was a tie.' : 'Most of the ship skipped.'));
  }

  function renderFinal(body) {
    var f = final || {}, o = (S && S.outcome) || {};
    var winner = f.winner || o.winner;
    var bugs = (S && S.bugs) || [];
    var won = f.role ? f.won : null;
    var h = el('div', 'ap-hero'); h.appendChild(f.role === 'bug' ? bugArt(true) : bean(Y.player.hex, 'big'));
    h.appendChild(el('h2', 'ol4', winner ? (winner === 'crew' ? 'CREW WIN!' : 'THE BUGS WIN!') : 'GAME OVER')); body.appendChild(h);
    var who = bugs.map(function (id) { var p = byId(id); return p ? p.name : '?'; }).join(' and ');
    body.appendChild(card(won ? 'good' : won === false ? 'bad' : '', won ? 'You won!' : won === false ? 'You lost' : 'Thanks for playing', (f.role === 'bug' ? 'You were the Bug.' : 'You were crew.') + (who ? ' The Bug: ' + who + '.' : '')));
    if (f.role === 'crew') body.appendChild(tips(['You made <b>' + (f.fixes || 0) + '</b> real fix' + (f.fixes === 1 ? '' : 'es') + ' on the ship.']));
  }

  // ---------- timers ----------
  function tick() {
    var now = Date.now(), frozen = S && S.paused, recvAt = sAt;
    Array.prototype.forEach.call(document.querySelectorAll('.cd'), function (c) {
      var left = frozen ? Number(c.dataset.end) - recvAt : Number(c.dataset.end) - now;
      c.textContent = c.dataset.fmt === 's' ? Math.max(0, Math.ceil(left / 1000)) + ' s' : mmss(left);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-dur]'), function (b) {
      var left = Math.max(0, Number(b.dataset.end) - (frozen ? recvAt : now)), dur = Number(b.dataset.dur) || 1;
      var pct = b.parentNode.classList.contains('walkbar') ? (1 - left / dur) * 100 : left / dur * 100;
      b.style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + '%';
    });
    if (Y && !busy && !frozen) {
      var again = false;
      ['lock', 'swapCd', 'sabCd'].forEach(function (k) { if (Y[k] > 0 && now - yAt > Y[k]) { Y[k] = 0; again = true; } });
      if (again) { lastKey = ''; draw(); }
    }
  }
  setInterval(tick, 200);

  render();
})();
