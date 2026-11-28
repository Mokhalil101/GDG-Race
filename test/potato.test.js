'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PotatoManager, POTATO, PHASE, EV, loadPotatoBank } = require('../server/potato');
const { signToken } = require('../server/station');
const { KEY, startServer, get, sio } = require('./helpers');

const bank = loadPotatoBank();
function mk(config) {
  let seed = 11;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const m = new PotatoManager({ bank, random });
  const room = m.createRoom({ config });
  const out = [];
  room.on('out', (o) => out.push(o));
  return { room, out, m };
}
function join(room, name) { const r = room.addPlayer({ name, socketId: 's-' + name }); assert.ok(r.ok, r.error); return r.player; }
function four(room) { return ['Salma', 'Ziad', 'Nada', 'Omar'].map((n) => join(room, n)); }
function toLive(room) { assert.ok(room.start().ok); room.tick(POTATO.INTRO_SEC + 0.01); assert.equal(room.phase, PHASE.LIVE); }
const holder = (room) => room.players.get(room.holderId);
const right = (room) => room.q.answer;
const wrongOf = (room) => 1 - room.q.answer;
function land(room) { room.tick(POTATO.FLIGHT_SEC + 0.01); assert.equal(room.flight, null); }

test('potato: question bank is valid (true/false + 2-choice)', () => {
  assert.ok(bank.length >= 40);
  const kinds = new Set(bank.map((q) => q.kind));
  assert.ok(kinds.has('tf') && kinds.has('pick'));
  for (const q of bank) {
    assert.ok(q.prompt.length <= 90, 'short prompt: ' + q.prompt);
    if (q.kind === 'pick') assert.notEqual(q.options[0], q.options[1]);
  }
});

test('potato: needs 4..12 players; 13th is refused; names must be unique', () => {
  const { room } = mk();
  join(room, 'A'); join(room, 'B'); join(room, 'C');
  assert.equal(room.start().code, 'NO_PLAYERS');
  assert.equal(room.addPlayer({ name: 'a', socketId: 'x' }).code, 'NAME_TAKEN');
  for (let i = 0; i < 9; i++) join(room, 'P' + i);
  assert.equal(room.players.size, 12);
  assert.equal(room.addPlayer({ name: 'Late', socketId: 'y' }).code, 'ROOM_FULL');
  assert.ok(room.start().ok);
  assert.equal(room.phase, PHASE.INTRO);
});

test('potato: fuse is hidden-random 6..15 s; only the holder phone gets the seconds and the question', () => {
  const { room, out } = mk();
  four(room);
  toLive(room);
  assert.ok(room.fuseMax >= POTATO.FUSE_MIN && room.fuseMax <= POTATO.FUSE_MAX);
  const h = holder(room);
  const pub = out.filter((o) => o.event === EV.STATE);
  assert.ok(pub.length > 0 && pub.every((o) => o.target === 'all'));
  for (const o of pub) {
    const s = JSON.stringify(o.data);
    assert.equal(/fuse(Left|Max)?"/.test(s), false, 'no fuse seconds in public state');
    assert.equal(s.includes('"answer"'), false, 'no answers in public state');
    assert.ok(o.data.stage >= 0 && o.data.stage <= 3);
  }
  const yous = out.filter((o) => o.event === EV.YOU);
  for (const y of yous) {
    if (y.target.socket === h.socketId && y.data.holding) {
      assert.ok(y.data.question); assert.equal(y.data.question.options.length, 2);
      assert.equal(y.data.question.answer, undefined, 'answer stays on the server');
      assert.ok(y.data.fuseLeft > 0);
    } else {
      assert.equal(y.data.question, null);
      assert.equal(y.data.fuseLeft, null);
    }
  }
  // fuse many different values across rounds
  const seen = new Set();
  for (let i = 0; i < 30; i++) { const r = new PotatoManager({ bank }).createRoom(); four(r); r.start(); assert.ok(r.fuseMax >= 6 && r.fuseMax <= 15); seen.add(r.fuseMax); }
  assert.ok(seen.size > 5, 'the fuse length varies');
});

test('potato: right answer throws the bomb to a random OTHER living player; fuse paused in flight', () => {
  const { room } = mk({ FUSE_MIN: 15, FUSE_MAX: 15 });
  const ps = four(room);
  toLive(room);
  const h = holder(room);
  const qid = room.q.id;
  room.tick(1);
  const res = room.answer(h.id, { id: qid, choice: right(room) });
  assert.equal(res.ok, true); assert.equal(res.correct, true);
  assert.ok(room.flight);
  assert.notEqual(room.flight.to, h.id);
  assert.ok(ps.some((p) => p.id === room.flight.to));
  const fuse = room.fuse;
  room.tick(POTATO.FLIGHT_SEC / 2);
  assert.equal(room.fuse, fuse, 'fuse does not burn while the bomb flies');
  land(room);
  assert.notEqual(room.holderId, h.id);
  assert.ok(room.q, 'the new holder gets a question');
  assert.equal(room.feed[0].type, 'pass');
  assert.equal(room.feed[0].name, h.name);
  assert.equal(room.feed[0].sec, 1);
  assert.equal(h.passes, 1);
  // the old holder can no longer answer
  assert.equal(room.answer(h.id, { id: room.q.id, choice: 0 }).code, 'NOT_HOLDER');
});

test('potato: wrong answer burns 2 s and gives a new question to the same holder', () => {
  const { room } = mk({ FUSE_MIN: 10, FUSE_MAX: 10 });
  four(room);
  toLive(room);
  const h = holder(room);
  const q1 = room.q.id;
  const before = room.fuse;
  const res = room.answer(h.id, { id: q1, choice: wrongOf(room) });
  assert.equal(res.ok, true); assert.equal(res.correct, false);
  assert.ok(Math.abs(room.fuse - (before - POTATO.WRONG_BURN_SEC)) < 1e-9);
  assert.equal(room.holderId, h.id);
  assert.ok(room.q && room.q.id !== q1, 'new question');
  assert.equal(room.feed[0].type, 'wrong');
});

test('potato: duplicate / stale / bad answers and non-holders are rejected', () => {
  const { room } = mk({ FUSE_MIN: 15, FUSE_MAX: 15 });
  const ps = four(room);
  assert.equal(room.answer(ps[0].id, { id: 1, choice: 0 }).code, 'NOT_OPEN');
  toLive(room);
  const h = holder(room);
  const other = ps.find((p) => p.id !== h.id);
  const qid = room.q.id;
  assert.equal(room.answer(other.id, { id: qid, choice: right(room) }).code, 'NOT_HOLDER', 'only the holder can answer');
  assert.equal(room.answer(h.id, { id: qid + 5, choice: 0 }).code, 'LATE');
  assert.equal(room.answer(h.id, { id: qid, choice: 2 }).code, 'BAD_CHOICE');
  assert.equal(room.answer(h.id, { id: qid, choice: '0; drop' }).code, 'BAD_CHOICE');
  assert.equal(room.answer('nobody', { id: qid, choice: 0 }).code, 'NO_PLAYER');
  const fuse = room.fuse;
  assert.equal(room.answer(h.id, { id: qid, choice: wrongOf(room) }).ok, true);
  assert.equal(room.answer(h.id, { id: qid, choice: right(room) }).code, 'LATE', 'a second answer to the same question is stale');
  assert.ok(Math.abs(room.fuse - (fuse - 2)) < 1e-9, 'burned once');
  room.pause();
  assert.equal(room.answer(h.id, { id: room.q.id, choice: 0 }).code, 'PAUSED');
  const f2 = room.fuse;
  room.tick(30);
  assert.equal(room.fuse, f2, 'pause freezes the fuse');
  room.pause();
});

test('potato: when the fuse runs out the holder is out; wrong answer at the end blows it at once', () => {
  const { room } = mk({ FUSE_MIN: 6, FUSE_MAX: 6 });
  four(room);
  toLive(room);
  const h = holder(room);
  room.tick(5.95);
  assert.equal(room.phase, PHASE.LIVE);
  room.tick(0.1);
  assert.equal(room.phase, PHASE.BOOM);
  assert.equal(h.out, true); assert.equal(h.outRound, 1);
  assert.equal(room.feed[0].type, 'boom');
  assert.equal(room.publicView().alive, 3);
  room.tick(POTATO.BOOM_SEC + 0.01);
  assert.equal(room.phase, PHASE.INTRO); assert.equal(room.round, 2);
  assert.notEqual(room.holderId, h.id, 'out players never get the bomb');
  room.tick(POTATO.INTRO_SEC + 0.01);
  const h2 = holder(room);
  room.tick(4.5); // 1.5 s left
  const r = room.answer(h2.id, { id: room.q.id, choice: wrongOf(room) });
  assert.equal(r.boom, true);
  assert.equal(h2.out, true);
  assert.equal(room.phase, PHASE.BOOM);
});

test('potato: last one standing wins; ranking and per-phone finals; play again resets', () => {
  const { room, out } = mk({ FUSE_MIN: 6, FUSE_MAX: 6 });
  const ps = four(room);
  room.start();
  for (let r = 0; r < 3; r++) {
    room.tick(POTATO.INTRO_SEC + 0.01);
    room.tick(6.1);
    assert.equal(room.phase, PHASE.BOOM);
    room.tick(POTATO.BOOM_SEC + 0.01);
  }
  assert.equal(room.phase, PHASE.FINISHED);
  const alive = ps.filter((p) => !p.out);
  assert.equal(alive.length, 1);
  const v = room.publicView();
  assert.equal(v.winner, alive[0].id);
  assert.equal(v.outcome, 'winner');
  assert.equal(v.ranking[0], alive[0].id);
  assert.equal(v.ranking.length, 4);
  const finals = out.filter((o) => o.event === EV.FINAL);
  assert.equal(finals.length, 4);
  assert.equal(finals.find((f) => f.target.socket === alive[0].socketId).data.winner, true);
  assert.equal(finals.find((f) => f.target.socket === alive[0].socketId).data.place, 1);
  assert.ok(room.again().ok);
  assert.equal(room.phase, PHASE.LOBBY);
  assert.ok(ps.every((p) => !p.out));
});

test('potato: late joiners watch until the next game; end early; host leaving pauses', () => {
  const { room } = mk();
  four(room);
  toLive(room);
  const late = join(room, 'Late');
  assert.equal(late.spectator, true);
  assert.equal(room.publicView().inGame, 4);
  for (let i = 0; i < 30; i++) { if (room.phase === PHASE.LIVE && !room.flight) assert.notEqual(room.holderId, late.id); room.tick(0.5); }
  room.setHostConnected(false);
  if (room.phase !== PHASE.FINISHED) assert.equal(room.paused, true);
  room.setHostConnected(true);
  if (room.phase !== PHASE.FINISHED) assert.ok(room.end().ok);
  assert.equal(room.phase, PHASE.FINISHED);
  assert.ok(room.again().ok);
  assert.equal(late.spectator, false, 'joins the next game');
});

test('potato: reconnect with the key keeps the seat; public state is throttled', () => {
  const { room, out } = mk({ FUSE_MIN: 15, FUSE_MAX: 15 });
  const ps = four(room);
  room.markDisconnected(ps[0].id, 's-Salma');
  assert.equal(ps[0].connected, false);
  const r = room.reconnectPlayer(ps[0].key, 's-Salma2');
  assert.ok(r.ok); assert.equal(r.previousSocketId, 's-Salma');
  assert.equal(room.reconnectPlayer('nope', 'x').code, 'NO_SESSION');
  toLive(room);
  out.length = 0;
  for (let i = 0; i < 40; i++) room.tick(0.1); // 4 s of fuse burning, no answers
  const states = out.filter((o) => o.event === EV.STATE);
  assert.ok(states.length <= 4, 'only stage changes are sent, got ' + states.length);
});

test('potato sockets: potato station hosts /potato; phones join, only the holder can answer', async (t) => {
  const s = await startServer({ server: { random: (() => { let x = 5; return () => { x = (x * 16807) % 2147483647; return x / 2147483647; }; })() } });
  t.after(s.close);
  const SUB = '11111111-2222-4333-8444-888888888888';
  s.platform.set(SUB, true);
  const ck = (game) => 'gdg_station=' + signToken({ sub: SUB, game, evt: 'e', day: 1, label: 'Booth 5', by: 'Mona' }, KEY);

  const anon = sio(s.port, { ns: '/potato' }); await anon.ready;
  assert.equal((await anon.emit('potato:create', {})).code, 'STATION');
  assert.equal((await anon.emit('potato:join', { code: 'ZZZZ', name: 'Ali' })).code, 'NO_ROOM', 'phones can only join existing rooms');
  const race = sio(s.port, { ns: '/potato', cookie: ck('race') }); await race.ready;
  assert.equal((await race.emit('potato:create', {})).ok, false, 'a race station cannot host Hot Potato');
  const host = sio(s.port, { ns: '/potato', cookie: ck('potato') }); await host.ready;
  const room = await host.emit('potato:create', { origin: 'http://x' });
  assert.equal(room.ok, true);
  assert.match(room.joinUrl, /\/games\/potato\/play\?room=[A-Z]{4}$/);
  assert.match(room.qr, /^data:image\/png;base64,/);

  const phones = [];
  for (const n of ['Salma', 'Ziad', 'Nada', 'Omar']) {
    const p = sio(s.port, { ns: '/potato' }); await p.ready;
    const j = await p.emit('potato:join', { code: room.code, name: n });
    assert.equal(j.ok, true); assert.equal(typeof j.key, 'string');
    phones.push({ c: p, id: j.player.id, name: n });
  }
  assert.equal((await phones[0].c.emit('potato:start')).ok, false, 'phones cannot start');
  assert.equal((await host.emit('potato:start')).ok, true);
  const pr = s.g.potatoes.get(room.code);
  pr.tick(POTATO.INTRO_SEC + 0.01);
  const hid = pr.holderId;
  const hp = phones.find((p) => p.id === hid);
  const others = phones.filter((p) => p.id !== hid);
  await new Promise((r) => setTimeout(r, 60));
  const qmsg = hp.c.received.filter((m) => m.ev === 'potato:you' && m.data.question).at(-1);
  assert.ok(qmsg, 'holder phone got its question');
  assert.equal(qmsg.data.question.answer, undefined);
  for (const o of others) assert.equal(o.c.received.some((m) => m.ev === 'potato:you' && m.data.question), false, 'others never see the question');
  assert.equal(host.received.some((m) => JSON.stringify(m.data).includes('fuseLeft":1') || /"fuse"/.test(JSON.stringify(m.data))), false);
  assert.equal((await others[0].c.emit('potato:answer', { id: qmsg.data.question.id, choice: 0 })).code, 'NOT_HOLDER');
  const ans = await hp.c.emit('potato:answer', { id: qmsg.data.question.id, choice: pr.q.answer });
  assert.equal(ans.correct, true);
  assert.equal((await hp.c.emit('potato:answer', { id: qmsg.data.question.id, choice: 0 })).ok, false, 'duplicate ignored');

  // the platform closes the station -> big screen told, phones kicked, room gone
  s.g.status.cache.clear();
  s.platform.set(SUB, false);
  await s.g.sweepStations();
  assert.equal((await host.waitFor('station-closed')).reason, 'closed');
  await phones[0].c.waitFor('potato:kicked');
  assert.equal(s.g.potatoes.rooms.size, 0);
  [anon, race, host, ...phones.map((p) => p.c)].forEach((c) => c.close());
});

test('potato pages: big screen needs a potato station; phone page and assets are open', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const SUB = '11111111-2222-4333-8444-999999999999';
  s.platform.set(SUB, true);
  const ck = (game) => 'gdg_station=' + signToken({ sub: SUB, game, evt: 'e', day: 1, label: 'Booth 6', by: 'Mona' }, KEY);
  const none = await get(s.base, '/games/potato/');
  assert.equal(none.status, 403); assert.match(await none.text(), /Hold on!/);
  assert.equal((await get(s.base, '/games/potato/', ck('kart'))).status, 403, 'a kart station cannot open Hot Potato');
  const ok = await get(s.base, '/games/potato/', ck('potato'));
  assert.equal(ok.status, 200); assert.match(await ok.text(), /HOT POTATO/);
  const phone = await get(s.base, '/games/potato/play?room=ABCD');
  assert.equal(phone.status, 200); assert.match(await phone.text(), /YOU HAVE<br>THE BOMB!/);
  for (const p of ['/games/potato.css', '/games/potato-host.js', '/games/potato-play.js']) assert.equal((await get(s.base, p)).status, 200, p);
  assert.equal((await get(s.base, '/games/potato-host.html')).status, 404, 'pages only through their routes');
  assert.equal((await get(s.base, '/games/potato')).headers.get('location'), '/games/potato/');
  assert.equal((await get(s.base, '/games/', ck('potato'))).headers.get('location'), '/games/potato/');
});
