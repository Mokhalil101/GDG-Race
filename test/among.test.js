'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AmongManager, AMONG, PHASE, EV, ROOMS, loadAmongBank } = require('../server/among');
const { signToken } = require('../server/station');
const { KEY, startServer, get, sio } = require('./helpers');

const bank = loadAmongBank();
const NAMES = ['Salma', 'Ziad', 'Nada', 'Omar', 'Mariam', 'Youssef', 'Hassan', 'Laila', 'Karim', 'Hana'];
function seeded(seed) { return () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }; }
function mk(n = 5, config, seed = 3) {
  const m = new AmongManager({ bank, random: seeded(seed) });
  const room = m.createRoom({ config });
  const out = [];
  room.on('out', (o) => out.push(o));
  const ps = NAMES.slice(0, n).map((name) => { const r = room.addPlayer({ name, socketId: 's-' + name }); assert.ok(r.ok, r.error); return r.player; });
  return { room, out, ps };
}
function play(room) { assert.ok(room.start().ok); room.tick(AMONG.ROLE_SEC + 0.01); assert.equal(room.phase, PHASE.PLAY); }
const bugOf = (room) => [...room.players.values()].find((p) => p.role === 'bug');
const crewOf = (room) => [...room.players.values()].filter((p) => p.role === 'crew');
function solve(room, p) { const r = room.answer(p.id, { id: p.task.id, choice: p.task.answer }); assert.ok(r.ok, r.error); return r; }
function miss(room, p) { return room.answer(p.id, { id: p.task.id, choice: (p.task.answer + 1) % p.task.options.length }); }
const publicMsgs = (out) => out.filter((o) => typeof o.target === 'string');

test('among: task bank is valid (multiple choice + fix the line)', () => {
  assert.ok(bank.length >= 30);
  const kinds = new Set(bank.map((q) => q.kind));
  assert.ok(kinds.has('mc') && kinds.has('fix'));
  for (const q of bank) assert.equal(new Set(q.options).size, q.options.length, 'distinct options: ' + q.prompt);
});

test('among: 5..10 players, 1 secret Bug (2 from 9 players)', () => {
  const small = mk(4).room;
  assert.equal(small.start().code, 'NO_PLAYERS');
  for (const n of [5, 8, 9, 10]) {
    const { room } = mk(n, null, n * 7);
    assert.ok(room.start().ok);
    const bugs = [...room.players.values()].filter((p) => p.role === 'bug').length;
    assert.equal(bugs, n >= 9 ? 2 : 1, n + ' players');
    assert.equal(room.target, AMONG.FIXES_PER_CREW * (n - bugs));
  }
  const { room } = mk(10);
  assert.equal(room.addPlayer({ name: 'Eleven', socketId: 'x' }).code, 'ROOM_FULL');
  // different seeds pick different Bugs
  const picked = new Set();
  for (let s = 1; s < 30; s++) { const r = mk(6, null, s * 13).room; r.start(); picked.add(bugOf(r).name); }
  assert.ok(picked.size >= 3, 'the Bug is random');
});

test('among: roles are secret - only each player\'s own socket learns its role; big screen never sees roles', () => {
  const { room, out } = mk(9, null, 5);
  play(room);
  const bugs = [...room.players.values()].filter((p) => p.role === 'bug');
  assert.equal(bugs.length, 2);
  // everything public (to 'all' / 'host' / 'players') is role-free and answer-free while the game runs
  for (const o of publicMsgs(out)) {
    const s = JSON.stringify(o.data);
    assert.equal(/"role"|"allies"|"bugs"|"answer"|"wasBug":true/.test(s), false, o.event + ' leaks: ' + s.slice(0, 200));
  }
  // private views: each socket only ever gets its own role
  const bySocket = new Map([...room.players.values()].map((p) => [p.socketId, p]));
  let seen = 0;
  for (const o of out.filter((x) => x.target && x.target.socket)) {
    const p = bySocket.get(o.target.socket);
    assert.ok(p, 'private message to a player socket');
    if (o.event !== EV.YOU) continue;
    assert.equal(o.data.player.id, p.id, 'a phone only gets its own view');
    assert.equal(o.data.role, p.role);
    if (p.role === 'crew') { assert.equal(o.data.allies, undefined); assert.equal(o.data.swapCd, undefined); }
    else assert.deepEqual(o.data.allies, bugs.filter((b) => b.id !== p.id).map((b) => b.id), 'Bugs know each other');
    seen++;
  }
  assert.ok(seen >= 18);
  assert.equal(room.publicView().bugs, undefined);
});

test('among: walking takes a few seconds; crew fix code in the room; wrong answers lock briefly; per-room cap', () => {
  const { room, out } = mk(5);
  play(room);
  const c = crewOf(room)[0];
  const to = ROOMS.map((r) => r.id).find((id) => id !== c.room);
  assert.ok(room.move(c.id, { room: to }).ok);
  assert.equal(room.openTask(c.id).code, 'WALKING');
  room.tick(AMONG.MOVE_SEC - 0.2);
  assert.equal(c.room, null);
  room.tick(0.3);
  assert.equal(c.room, to);
  const t = room.openTask(c.id);
  assert.ok(t.ok); assert.equal(t.task.answer, undefined, 'answer stays on the server');
  assert.ok(t.task.options.length === 3 || t.task.options.length === 4);
  out.length = 0;
  const w = miss(room, c);
  assert.equal(w.correct, false);
  assert.equal(room.realFixes, 0);
  assert.equal(out.some((o) => o.event === EV.FX), false, 'a wrong answer shows no fix');
  assert.equal(room.openTask(c.id).code, 'LOCKED');
  room.tick(AMONG.WRONG_LOCK_SEC + 0.1);
  room.openTask(c.id); solve(room, c);
  assert.equal(room.realFixes, 1);
  assert.equal(room.rooms[to].apparent, 1);
  const fx = out.filter((o) => o.event === EV.FX);
  assert.equal(fx.length, 1); assert.equal(fx[0].target, 'all');
  room.openTask(c.id); solve(room, c);
  assert.equal(room.openTask(c.id).code, 'ROOM_DONE', 'cap per room per player');
  assert.equal(room.openTask(bugOf(room).id).code, 'NOT_CREW');
  // stale / duplicate / bad answers
  const c2 = crewOf(room)[1];
  room.openTask(c2.id);
  const id = c2.task.id;
  assert.equal(room.answer(c2.id, { id: id + 9, choice: 0 }).code, 'LATE');
  assert.equal(room.answer(c2.id, { id, choice: 7 }).code, 'BAD_CHOICE');
  solve(room, c2);
  assert.equal(room.answer(c2.id, { id, choice: 0 }).code, 'LATE', 'duplicate');
  assert.equal(room.realFixes, 3);
});

test('among: a faked fix looks exactly like a real one on the big screen and adds nothing', () => {
  const { room, out } = mk(6, { SYNC_SEC: 8 });
  play(room);
  const bug = bugOf(room), c = crewOf(room)[0];
  c.room = 'lab'; bug.room = 'lab';
  out.length = 0;
  room.openTask(c.id);
  const busyCrew = room.publicView().players.find((p) => p.id === c.id).busy;
  assert.ok(room.fakeFix(bug.id).ok);
  const busyBug = room.publicView().players.find((p) => p.id === bug.id).busy;
  assert.equal(busyCrew, true); assert.equal(busyBug, true, 'both look busy');
  solve(room, c);
  for (let i = 0; i < 110 && bug.fake; i++) room.tick(0.1);
  assert.equal(bug.fake, null);
  const fx = out.filter((o) => o.event === EV.FX);
  assert.equal(fx.length, 2);
  const real = fx.find((f) => f.data.id === c.id), fake = fx.find((f) => f.data.id === bug.id);
  assert.deepEqual(Object.keys(real.data).sort(), Object.keys(fake.data).sort(), 'same fields');
  assert.equal(real.target, fake.target);
  assert.deepEqual(Object.assign({}, real.data, { id: 'x' }), Object.assign({}, fake.data, { id: 'x' }), 'same event');
  assert.equal(room.realFixes, 1, 'fake adds nothing');
  assert.equal(room.rooms.lab.apparent, 2, 'but the room counter counts both');
  assert.equal(room.crewAboard(), 5);
  assert.equal(room.fakeFix(c.id).code, 'NOT_BUG');
});

test('among: SHIP FIXED only syncs every few seconds, so one fix cannot be traced', () => {
  const { room } = mk(5, { SYNC_SEC: 8 });
  play(room);
  const c = crewOf(room)[0];
  room.tick(4);
  room.openTask(c.id); solve(room, c);
  assert.equal(room.publicView().ship, 0, 'not yet');
  room.tick(4.1);
  assert.ok(room.publicView().ship > 0, 'synced');
});

test('among: swapped line makes the next task in that room take an extra step (once)', () => {
  const { room } = mk(5);
  play(room);
  const bug = bugOf(room), c = crewOf(room)[0];
  bug.room = 'engine'; c.room = 'engine';
  assert.equal(room.swapLine(bug.id).code, 'COOLDOWN');
  room.tick(AMONG.SWAP_FIRST + 0.1);
  assert.ok(room.swapLine(bug.id).ok);
  assert.equal(room.swapLine(bug.id).code, 'COOLDOWN');
  assert.equal(JSON.stringify(room.publicView()).includes('swap'), false, 'not on the big screen');
  room.openTask(c.id);
  assert.equal(c.task.steps, 2);
  const r1 = solve(room, c);
  assert.equal(r1.next, true);
  assert.equal(room.realFixes, 0, 'not fixed after step 1');
  assert.equal(c.task.step, 2);
  solve(room, c);
  assert.equal(room.realFixes, 1);
  room.openTask(c.id);
  assert.equal(c.task.steps, 1, 'only the next task');
  assert.equal(room.swapLine(c.id).code, 'NOT_BUG');
});

test('among: sabotage runs out -> the Bug wins', () => {
  const { room, out } = mk(5);
  play(room);
  const bug = bugOf(room);
  assert.equal(room.sabotage(bug.id, { room: 'server' }).code, 'COOLDOWN');
  room.tick(AMONG.SAB_FIRST + 0.1);
  assert.equal(room.sabotage(crewOf(room)[0].id, { room: 'server' }).code, 'NOT_BUG');
  assert.ok(room.sabotage(bug.id, { room: 'server' }).ok);
  const v = room.publicView();
  assert.equal(v.sabotage.room, 'server');
  assert.equal(v.rooms.find((r) => r.id === 'server').sabotaged, true);
  assert.equal(room.callMeeting(crewOf(room)[0].id, {}).code, 'SABOTAGE', 'no meetings during a sabotage');
  room.tick(AMONG.SAB_SEC + 0.1);
  assert.equal(room.phase, PHASE.FINISHED);
  assert.deepEqual(room.outcome, { winner: 'bugs', reason: 'sabotage' });
  const fin = out.filter((o) => o.event === EV.FINAL);
  assert.equal(fin.find((f) => f.target.socket === bug.socketId).data.won, true);
  assert.equal(room.publicView().bugs[0], bug.id, 'revealed at the end');
});

test('among: sabotage is fixed when two crew solve it together; a Bug faking it does not count', () => {
  const { room } = mk(6);
  play(room);
  const bug = bugOf(room), [a, b] = crewOf(room);
  room.tick(AMONG.SAB_FIRST + 0.1);
  room.sabotage(bug.id, { room: 'cafe' });
  a.room = 'cafe'; b.room = 'cafe'; bug.room = 'cafe';
  room.fakeFix(bug.id);
  room.tick(AMONG.FAKE_MAX + 0.1);
  assert.equal(room.sab.fixers.size, 0, 'fake does not help');
  assert.ok(room.sab, 'still burning');
  room.openTask(a.id); solve(room, a);
  assert.equal(room.sab.fixers.size, 1);
  assert.equal(room.openTask(a.id).code, 'DONE', 'needs a second person');
  room.openTask(b.id); solve(room, b);
  assert.equal(room.sab, null);
  assert.equal(room.phase, PHASE.PLAY);
  assert.equal(room.realFixes, 0, 'sabotage fixes do not fill the ship');
});

test('among: meetings - limited per player, vote on phones, most votes thrown off, reveal', () => {
  const { room } = mk(6);
  play(room);
  const bug = bugOf(room), crew = crewOf(room);
  const caller = crew[0];
  assert.ok(room.callMeeting(caller.id, { reason: 'I saw something sus' }).ok);
  assert.equal(room.phase, PHASE.MEETING);
  assert.equal(room.publicView().meeting.reason, 'I saw something sus');
  assert.equal(room.vote(caller.id, { target: 'nobody' }).code, 'BAD_TARGET');
  // 4 vote the Bug, 1 skip, the Bug votes a crewmate
  crew.slice(0, 4).forEach((p) => assert.ok(room.vote(p.id, { target: bug.id }).ok));
  assert.equal(room.vote(crew[0].id, { target: bug.id }).code, 'DUPLICATE');
  room.vote(crew[4].id, { target: 'skip' });
  assert.equal(room.publicView().meeting.voted.length, 5);
  room.vote(bug.id, { target: crew[0].id });
  assert.equal(room.phase, PHASE.VERDICT, 'everyone voted -> verdict');
  const v = room.publicView().verdict;
  assert.equal(v.id, bug.id); assert.equal(v.wasBug, true);
  assert.equal(bug.ghost, true);
  room.tick(AMONG.VERDICT_SEC + 0.1);
  assert.equal(room.phase, PHASE.FINISHED);
  assert.deepEqual(room.outcome, { winner: 'crew', reason: 'voted' });
});

test('among: vote ties / skip mean nobody goes; meeting limit; thrown-off crew can still fix but not vote', () => {
  const { room } = mk(6, { MEETING_SEC: 60 });
  play(room);
  const bug = bugOf(room), crew = crewOf(room);
  // tie: 2 vs 2 (+ 2 skip)
  room.callMeeting(crew[0].id, {});
  assert.equal(room.callMeeting(crew[1].id, {}).code, 'BAD_STATE');
  room.vote(crew[0].id, { target: crew[1].id }); room.vote(crew[1].id, { target: crew[1].id });
  room.vote(crew[2].id, { target: crew[2].id }); room.vote(crew[3].id, { target: crew[2].id });
  room.vote(crew[4].id, { target: 'skip' }); room.vote(bug.id, { target: 'skip' });
  assert.equal(room.phase, PHASE.VERDICT);
  assert.equal(room.publicView().verdict.id, null);
  assert.equal(room.publicView().verdict.tie, true);
  room.tick(AMONG.VERDICT_SEC + 0.1);
  assert.equal(room.phase, PHASE.PLAY);
  assert.equal(room.callMeeting(crew[0].id, {}).code, 'NO_MEETINGS', 'one meeting each');
  // timer runs out with not everyone voting; skip beats a single vote
  room.callMeeting(crew[1].id, {});
  room.vote(crew[1].id, { target: crew[2].id }); room.vote(crew[2].id, { target: 'skip' }); room.vote(crew[3].id, { target: 'skip' });
  room.tick(60.1);
  assert.equal(room.phase, PHASE.VERDICT);
  assert.equal(room.publicView().verdict.id, null);
  room.tick(AMONG.VERDICT_SEC + 0.1);
  // a crewmate thrown off: shown as crew, becomes a ghost who can still fix code
  room.callMeeting(crew[2].id, {});
  [crew[2], crew[3], crew[4], bug].forEach((p) => room.vote(p.id, { target: crew[0].id }));
  room.vote(crew[0].id, { target: bug.id }); room.vote(crew[1].id, { target: 'skip' });
  const v = room.publicView().verdict;
  assert.equal(v.id, crew[0].id); assert.equal(v.wasBug, false);
  room.tick(AMONG.VERDICT_SEC + 0.1);
  assert.equal(room.phase, PHASE.PLAY);
  assert.equal(crew[0].ghost, true);
  assert.equal(room.callMeeting(crew[0].id, {}).code, 'GHOST');
  crew[0].room = 'bridge';
  assert.ok(room.openTask(crew[0].id).ok, 'ghost crew still fix code');
  solve(room, crew[0]);
  assert.equal(room.realFixes, 1);
  assert.equal(room.publicView().aboard, 5);
});

test('among: Bugs win when crew <= bugs; crew win at 100%; time running out -> Bugs', () => {
  // outnumbered: 5 players, throw off 3 crew -> 1 crew vs 1 bug
  const { room } = mk(5, { MEETINGS_EACH: 5 });
  play(room);
  const bug = bugOf(room);
  for (let k = 0; k < 3; k++) {
    const crew = crewOf(room).filter((p) => !p.ghost);
    room.callMeeting(bug.id, {});
    const victim = crew[0];
    for (const p of room.aboard()) room.vote(p.id, { target: p.id === victim.id ? bug.id : victim.id });
    assert.equal(room.verdict.id, victim.id);
    room.tick(AMONG.VERDICT_SEC + 0.1);
  }
  assert.equal(room.phase, PHASE.FINISHED);
  assert.deepEqual(room.outcome, { winner: 'bugs', reason: 'outnumbered' });

  // ship 100%
  const r2 = mk(5, { FIXES_PER_CREW: 1 }).room;
  play(r2);
  const cs = crewOf(r2);
  for (const c of cs) { r2.openTask(c.id); solve(r2, c); }
  assert.equal(r2.phase, PHASE.FINISHED);
  assert.deepEqual(r2.outcome, { winner: 'crew', reason: 'ship' });
  assert.equal(r2.publicView().ship, 100);

  // time
  const r3 = mk(5, { GAME_SEC: 20 }).room;
  play(r3);
  r3.callMeeting(crewOf(r3)[0].id, {});
  r3.tick(AMONG.MEETING_SEC + 0.1); // meetings stop the game clock
  assert.equal(r3.phase, PHASE.VERDICT);
  r3.tick(AMONG.VERDICT_SEC + 0.1);
  r3.tick(20.1);
  assert.deepEqual(r3.outcome, { winner: 'bugs', reason: 'time' });
  assert.ok(r3.again().ok);
  assert.equal(r3.phase, PHASE.LOBBY);
  assert.ok([...r3.players.values()].every((p) => p.role === null && !p.ghost));
});

test('among: pause freezes everything; host leaving pauses; late joiners wait; reconnect keeps the role', () => {
  const { room } = mk(5);
  play(room);
  const c = crewOf(room)[0];
  room.move(c.id, { room: ROOMS.map((r) => r.id).find((id) => id !== c.room) });
  room.pause();
  const t = room.timeLeft;
  room.tick(10);
  assert.equal(room.timeLeft, t); assert.ok(c.walk);
  assert.equal(room.openTask(c.id).code, 'PAUSED');
  room.pause();
  room.setHostConnected(false);
  assert.equal(room.paused, true);
  room.setHostConnected(true); room.pause();
  const late = room.addPlayer({ name: 'Late', socketId: 's-late' }).player;
  assert.equal(late.spectator, true);
  assert.equal(late.role, null);
  assert.equal(room.move(late.id, { room: 'lab' }).code, 'SPECTATOR');
  room.markDisconnected(c.id, c.socketId);
  const r = room.reconnectPlayer(c.key, 's-new');
  assert.ok(r.ok);
  assert.equal(room.youView(c).role, 'crew');
});

test('among sockets: an among station hosts /among; phones only ever receive their own role', async (t) => {
  const s = await startServer({ server: { random: seeded(77) } });
  t.after(s.close);
  const SUB = '11111111-2222-4333-8444-aaaaaaaaaaaa';
  s.platform.set(SUB, true);
  const ck = (game) => 'gdg_station=' + signToken({ sub: SUB, game, evt: 'e', day: 1, label: 'Booth 7', by: 'Mona' }, KEY);
  const anon = sio(s.port, { ns: '/among' }); await anon.ready;
  assert.equal((await anon.emit('among:create', {})).code, 'STATION');
  assert.equal((await anon.emit('among:join', { code: 'ZZZZ', name: 'Ali' })).code, 'NO_ROOM');
  const wrong = sio(s.port, { ns: '/among', cookie: ck('potato') }); await wrong.ready;
  assert.equal((await wrong.emit('among:create', {})).ok, false, 'a potato station cannot host Among Bugs');
  const host = sio(s.port, { ns: '/among', cookie: ck('among') }); await host.ready;
  const room = await host.emit('among:create', { origin: 'http://x' });
  assert.equal(room.ok, true);
  assert.match(room.joinUrl, /\/games\/among\/play\?room=[A-Z]{4}$/);

  const phones = [];
  for (const n of NAMES.slice(0, 6)) {
    const p = sio(s.port, { ns: '/among' }); await p.ready;
    const j = await p.emit('among:join', { code: room.code, name: n });
    assert.equal(j.ok, true);
    assert.equal(j.role, null, 'no role in the lobby');
    phones.push({ c: p, id: j.player.id });
  }
  assert.equal((await phones[0].c.emit('among:start')).ok, false, 'phones cannot start');
  assert.equal((await host.emit('among:start')).ok, true);
  await new Promise((r) => setTimeout(r, 80));
  const ar = s.g.amongs.get(room.code);
  const bugId = [...ar.players.values()].find((p) => p.role === 'bug').id;
  for (const ph of phones) {
    const roles = ph.c.received.filter((m) => m.ev === 'among:you' && m.data.role).map((m) => m.data);
    assert.ok(roles.length >= 1, 'each phone got its own role');
    for (const y of roles) assert.equal(y.player.id, ph.id);
    const mine = roles[0].role;
    assert.equal(mine, ph.id === bugId ? 'bug' : 'crew');
    // nothing a phone receives names the Bug, unless it IS the Bug
    for (const m of ph.c.received) {
      const sJ = JSON.stringify(m.data);
      if (ph.id !== bugId) assert.equal(/"role":"bug"|"allies"/.test(sJ), false, m.ev);
    }
  }
  for (const m of host.received) assert.equal(/"role"|"allies"|"bugs"/.test(JSON.stringify(m.data)), false, 'big screen never sees roles: ' + m.ev);
  // crew cannot use Bug actions; a phone cannot act for another
  const crewPhone = phones.find((p) => p.id !== bugId);
  ar.tick(AMONG.ROLE_SEC + 0.1);
  ar.tick(AMONG.SAB_FIRST + 0.1);
  assert.equal((await crewPhone.c.emit('among:sabotage', { room: 'lab' })).code, 'NOT_BUG');
  assert.equal((await crewPhone.c.emit('among:fake', {})).code, 'NOT_BUG');
  const bugPhone = phones.find((p) => p.id === bugId);
  assert.equal((await bugPhone.c.emit('among:task', {})).code, 'NOT_CREW');
  assert.equal((await bugPhone.c.emit('among:sabotage', { room: 'lab' })).ok, true);
  await host.waitFor('among:state');
  // station closed -> room ends
  s.g.status.cache.clear();
  s.platform.set(SUB, false);
  await s.g.sweepStations();
  assert.equal((await host.waitFor('station-closed')).reason, 'closed');
  await phones[0].c.waitFor('among:kicked');
  assert.equal(s.g.amongs.rooms.size, 0);
  [anon, wrong, host, ...phones.map((p) => p.c)].forEach((c) => c.close());
});

test('among pages: big screen needs an among station; phone page and assets are open', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const SUB = '11111111-2222-4333-8444-bbbbbbbbbbbb';
  s.platform.set(SUB, true);
  const ck = (game) => 'gdg_station=' + signToken({ sub: SUB, game, evt: 'e', day: 1, label: 'Booth 8', by: 'Mona' }, KEY);
  const none = await get(s.base, '/games/among/');
  assert.equal(none.status, 403); assert.match(await none.text(), /Hold on!/);
  assert.equal((await get(s.base, '/games/among/', ck('raid'))).status, 403, 'a raid station cannot open Among Bugs');
  const ok = await get(s.base, '/games/among/', ck('among'));
  assert.equal(ok.status, 200); assert.match(await ok.text(), /AMONG BUGS/);
  const phone = await get(s.base, '/games/among/play?room=ABCD');
  assert.equal(phone.status, 200); assert.match(await phone.text(), /YOUR SECRET ROLE/);
  for (const p of ['/games/among.css', '/games/among-host.js', '/games/among-play.js']) assert.equal((await get(s.base, p)).status, 200, p);
  assert.equal((await get(s.base, '/games/among-host.html')).status, 404, 'pages only through their routes');
  assert.equal((await get(s.base, '/games/', ck('among'))).headers.get('location'), '/games/among/');
});
