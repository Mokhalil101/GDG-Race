'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../shared/game');
const K = require('../shared/kart');
const sim = require('../server/sim');
const { KartManager, loadKartBank } = require('../server/kart');
const { signToken } = require('../server/station');
const { KEY, startServer, sio } = require('./helpers');

const { STATUS, CONFIG, TRACK } = G;
const { RULES, EV } = K;
const DT = 1 / CONFIG.SIM_HZ;

const BANK = [
  { prompt: 'What will this code print?', code: 'print(1 + 1)', options: ['2', '11', '1', 'Error'], answer: 0 },
  { prompt: 'What will this code print?', code: 'print(2 * 3)', options: ['5', '6', '23', 'Error'], answer: 1 },
  { prompt: 'What will this code print?', code: 'print(len("ab"))', options: ['1', '3', '2', 'ab'], answer: 2 },
  { prompt: 'What will this code print?', code: 'print(9 % 4)', options: ['2', '0', '4', '1'], answer: 3 },
];
function lcg(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function mk(seed = 7) {
  const m = new KartManager({ bank: BANK, random: lcg(seed) });
  const room = m.createRoom();
  const out = [];
  room.on('out', (o) => out.push(o));
  return { m, room, out };
}
function join(room, name, carId) {
  const r = room.addPlayer({ name, carId, socketId: 's-' + name });
  assert.ok(r.ok, r.error);
  return r.player;
}
function run(room, sec) { for (let i = 0; i < Math.round(sec / DT); i++) room.tick(DT); }
function race(room) {
  assert.ok(room.startCountdown().ok);
  run(room, CONFIG.COUNTDOWN_SECONDS + 0.1);
  assert.equal(room.status, STATUS.RACING);
}
/** Put a kart somewhere on lap 1 (s = centre-line distance) at full speed. */
function place(p, s, d) { p.car.totalS = s; p.car.d = d; p.car.speed = CONFIG.PHYS.MAX_SPEED; p.car.latVel = 0; sim.updatePose(p.car); }
/** Park everybody else far away so only `p` is near the boxes. */
function park(room, except, s = TRACK.P * 0.3) {
  let i = 0;
  for (const o of room.players.values()) if (o !== except) place(o, s - 120 * i++, -60);
}
/** Drive `p` into the middle box of the first row and return its question. */
function pickup(room, p) {
  const box = K.BOXES[1];
  place(p, box.s - 40, box.d);
  for (let i = 0; i < 30 && !p.q; i++) room.tick(DT);
  assert.ok(p.q, 'kart should have picked up a box');
  return p.q;
}
const sent = (out, socket, event) => out.filter((o) => o.target && o.target.socket === socket && o.event === event);

test('kart: 8 karts, two-row grid, race rules unchanged', () => {
  const { room } = mk();
  assert.equal(room.maxPlayers, 8);
  assert.equal(room.settings.obstacles, false);
  const ps = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((n) => join(room, n));
  assert.equal(room.addPlayer({ name: 'I' }).code, 'ROOM_FULL');
  assert.deepEqual(ps.map((p) => p.carId), [1, 2, 3, 4, 5, 6, 7, 8]);
  // no two karts overlap on the grid
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    const a = ps[i].car, b = ps[j].car;
    assert.ok(Math.abs(a.d - b.d) >= CONFIG.CAR.WIDTH || Math.abs(a.totalS - b.totalS) >= CONFIG.CAR.LENGTH, ps[i].name + '/' + ps[j].name);
    assert.ok(Math.abs(a.d) <= TRACK.usable);
  }
  // GDG Race rooms keep 6 cars
  const { RoomManager } = require('../server/rooms');
  assert.equal(new RoomManager().createRoom().maxPlayers, 6);
});

test('kart: driving over a box asks only that phone, kart drives straight, box respawns', () => {
  const { room, out } = mk();
  const a = join(room, 'Salma'), b = join(room, 'Omar');
  race(room); park(room, a);
  const q = pickup(room, a);
  assert.equal(room.boxes[1].on, false);
  const msgs = sent(out, 's-Salma', EV.QUESTION);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].data.id, q.id);
  assert.equal(msgs[0].data.options.length, 4);
  assert.equal(msgs[0].data.answer, undefined, 'the right answer never leaves the server');
  assert.ok(K.ITEM_IDS.includes(msgs[0].data.item));
  assert.equal(sent(out, 's-Omar', EV.QUESTION).length, 0);
  // steering is ignored while answering
  assert.equal(room.steer(a.id, 1), false);
  assert.equal(a.steer, 0);
  const d0 = a.car.d; run(room, 0.5); assert.ok(Math.abs(a.car.d - d0) < 0.01);
  // host sees the pickup and the empty box
  run(room, 0.1);
  const states = out.filter((o) => o.event === G.EVT.GAME_STATE).map((o) => o.data);
  assert.ok(states.some((s) => s.events.some((e) => e.type === 'pickup' && e.id === a.id)));
  assert.equal(states.at(-1).boxes[1], 0);
  assert.equal(states.at(-1).cars.find((c) => c.id === a.id).ask, true);
  // respawn
  room.answer(a.id, { id: q.id, choice: q.answer });
  run(room, RULES.BOX_RESPAWN_SEC);
  assert.equal(room.boxes[1].on, true);
});

test('kart: right answer gives the rolled item; holding an item you pass through boxes', () => {
  const { room, out } = mk();
  const a = join(room, 'Salma'); join(room, 'Omar');
  race(room); park(room, a);
  const q = pickup(room, a);
  const r = room.answer(a.id, { id: q.id, choice: q.answer });
  assert.equal(r.ok, true); assert.equal(r.kind, 'right'); assert.equal(r.item, q.item);
  assert.equal(a.item, q.item); assert.equal(a.streak, 1); assert.equal(a.q, null);
  const you = sent(out, 's-Salma', EV.YOU).at(-1).data;
  assert.equal(you.item, q.item); assert.equal(you.question, null); assert.equal(you.lastResult.kind, 'right');
  // the next row of boxes: hands are full -> no question, the box stays
  const box = K.BOXES[4];
  place(a, box.s - 40, box.d);
  run(room, 0.5);
  assert.equal(a.q, null); assert.equal(room.boxes[4].on, true);
  const lb = room.leaderboard().rows.find((x) => x.id === a.id);
  assert.equal(lb.item, q.item);
});

test('kart: wrong answer spins out for 2 s (slow, no steering), then recovers', () => {
  const { room } = mk();
  const a = join(room, 'Salma'); join(room, 'Omar');
  race(room); park(room, a);
  const q = pickup(room, a);
  const r = room.answer(a.id, { id: q.id, choice: (q.answer + 1) % 4 });
  assert.equal(r.kind, 'wrong'); assert.equal(r.correct, false);
  assert.equal(a.item, null); assert.equal(a.streak, 0); assert.equal(a.stats.wrong, 1);
  assert.ok(a.car.spinT > 1.9);
  run(room, 0.6);
  assert.ok(a.car.speed <= CONFIG.PHYS.MAX_SPEED * RULES.SPIN_FACTOR + 1, 'slowed: ' + a.car.speed);
  assert.equal(room.steer(a.id, -1), false);
  assert.equal(room.snapshot().cars.find((c) => c.id === a.id).spin, true);
  run(room, RULES.SPIN_SEC);
  assert.equal(a.car.spinT, 0);
  assert.equal(room.steer(a.id, -1), true);
  run(room, 1.5);
  assert.ok(a.car.speed > CONFIG.PHYS.MAX_SPEED * 0.9);
});

test('kart: no answer within 5 s = no item, no spin, streak lost', () => {
  const { room, out } = mk();
  const a = join(room, 'Salma'); join(room, 'Omar');
  race(room); park(room, a);
  a.streak = 2;
  const q = pickup(room, a);
  run(room, RULES.QUESTION_SEC - 0.3);
  assert.ok(a.q, 'still open just before the 5 s');
  run(room, 0.5);
  assert.equal(a.q, null);
  assert.equal(a.item, null); assert.equal(a.car.spinT, 0); assert.equal(a.streak, 0);
  assert.equal(a.lastResult.kind, 'timeout');
  assert.equal(sent(out, 's-Salma', EV.YOU).at(-1).data.lastResult.kind, 'timeout');
  // a late answer is ignored
  assert.equal(room.answer(a.id, { id: q.id, choice: q.answer }).code, 'LATE');
  assert.equal(a.item, null);
});

test('kart: duplicate / stale / bad answers are ignored', () => {
  const { room } = mk();
  const a = join(room, 'Salma'); const b = join(room, 'Omar');
  race(room); park(room, a);
  const q = pickup(room, a);
  assert.equal(room.answer(a.id, { id: q.id, choice: 9 }).code, 'BAD_CHOICE');
  assert.ok(a.q, 'a bad choice does not close the question');
  assert.equal(room.answer(a.id, { id: q.id + 1, choice: q.answer }).code, 'LATE');
  assert.equal(room.answer(b.id, { id: q.id, choice: q.answer }).code, 'LATE', 'someone else cannot answer my question');
  assert.equal(room.answer(a.id, { id: q.id, choice: (q.answer + 1) % 4 }).kind, 'wrong');
  assert.equal(room.answer(a.id, { id: q.id, choice: q.answer }).code, 'LATE', 'second answer ignored');
  assert.equal(a.item, null); assert.equal(a.stats.wrong, 1); assert.equal(a.stats.right, 0);
});

test('kart: 3 right in a row -> automatic Turbo', () => {
  const { room, out } = mk();
  const a = join(room, 'Salma'); join(room, 'Omar');
  race(room); park(room, a);
  for (let i = 1; i <= 3; i++) {
    a.item = null;
    const q = pickup(room, a);
    const r = room.answer(a.id, { id: q.id, choice: q.answer });
    assert.equal(r.kind, 'right');
    if (i < 3) { assert.equal(a.streak, i); assert.ok(!(a.car.boostT > 0)); assert.ok(!r.streakTurbo); }
    else { assert.equal(r.streakTurbo, true); assert.equal(a.streak, 0); assert.ok(a.car.boostT > 0); assert.ok(a.item, 'still gets the box item too'); }
    run(room, RULES.BOX_RESPAWN_SEC + 0.1);
  }
  run(room, 0.1);
  assert.ok(out.some((o) => o.event === G.EVT.GAME_STATE && o.data.events.some((e) => e.type === 'streakTurbo' && e.id === a.id)));
});

test('kart: item use only by the holder, once, while racing', () => {
  const { room } = mk();
  const a = join(room, 'Salma'); const b = join(room, 'Omar');
  assert.equal(room.useItem(a.id).code, 'BAD_STATE');
  race(room);
  assert.equal(room.useItem(a.id).code, 'NO_ITEM');
  a.item = 'turbo';
  assert.equal(room.useItem(b.id).code, 'NO_ITEM', 'Omar cannot fire Salma\'s item');
  assert.equal(a.item, 'turbo');
  a.car.spinT = 1;
  assert.equal(room.useItem(a.id).code, 'SPINNING');
  a.car.spinT = 0;
  assert.deepEqual(room.useItem(a.id), { ok: true, item: 'turbo' });
  assert.equal(a.item, null);
  assert.equal(room.useItem(a.id).code, 'NO_ITEM');
  assert.equal(room.useItem('nobody').code, 'NO_PLAYER');
});

test('kart: Turbo goes faster than top speed for a while', () => {
  const { room } = mk();
  const a = join(room, 'Salma'); join(room, 'Omar');
  race(room); park(room, a); place(a, TRACK.P * 0.05, 0);
  a.item = 'turbo';
  room.useItem(a.id);
  run(room, 1);
  assert.ok(a.car.speed > CONFIG.PHYS.MAX_SPEED * 1.3, 'speed ' + a.car.speed);
  assert.equal(room.snapshot().cars.find((c) => c.id === a.id).boost, true);
  run(room, RULES.TURBO_SEC + 1);
  assert.ok(a.car.speed <= CONFIG.PHYS.MAX_SPEED + 0.01);
});

test('kart: Bug Bomb hits the kart ahead (or behind when leading); a Shield blocks it once', () => {
  const { room } = mk();
  const a = join(room, 'Salma'), b = join(room, 'Omar'), c = join(room, 'Ziad');
  race(room);
  place(c, 1500, -60); place(b, 1300, 0); place(a, 1100, 60); // order: Ziad, Omar, Salma
  assert.equal(room.bombTarget(a), b);
  assert.equal(room.bombTarget(c), b, 'leader hits the kart behind');
  a.item = 'bomb';
  assert.equal(room.useItem(a.id).ok, true);
  assert.ok(b.car.spinT > 1.9); assert.equal(c.car.spinT, 0); assert.equal(a.stats.hits, 1);
  run(room, 0.1);
  // shield on Omar: the next bomb only pops the shield
  b.car.spinT = 0; b.car.slowT = 0;
  b.item = 'shield'; room.useItem(b.id);
  assert.ok(b.car.shieldT > 0);
  place(c, 1500, -60); place(b, 1300, 0); place(a, 1100, 60);
  a.item = 'bomb';
  room.useItem(a.id);
  assert.equal(b.car.spinT, 0, 'shield blocked the bomb');
  assert.equal(b.car.shieldT, 0, 'shield is used up');
  assert.equal(b.stats.blocked, 1);
  assert.ok(room.pendingEvents.some((e) => e.type === 'bomb' && e.target === b.id && e.blocked));
  assert.ok(room.pendingEvents.some((e) => e.type === 'blocked' && e.id === b.id && e.what === 'bomb'));
});

test('kart: Shield runs out after a while', () => {
  const { room } = mk();
  const a = join(room, 'Salma'); join(room, 'Omar');
  race(room); park(room, a); place(a, 200, 0);
  a.item = 'shield'; room.useItem(a.id);
  run(room, RULES.SHIELD_SEC - 1); assert.ok(a.car.shieldT > 0);
  run(room, 1.5); assert.equal(a.car.shieldT, 0);
});

test('kart: Firewall blocks the lane behind: spins the kart that drives in, not its owner; a Shield absorbs it', () => {
  const { room } = mk();
  const a = join(room, 'Salma'), b = join(room, 'Omar'), c = join(room, 'Ziad');
  race(room);
  place(a, 1200, 40); place(b, 900, 40); place(c, 500, -60);
  a.item = 'firewall';
  assert.equal(room.useItem(a.id).ok, true);
  assert.equal(room.walls.length, 1);
  const w = room.walls[0];
  assert.ok(Math.abs(sim.wrapDelta(w.s, 1200 - RULES.FIREWALL_BACK)) < 1);
  assert.equal(room.snapshot().walls.length, 1);
  for (let i = 0; i < 60 && b.car.spinT === 0; i++) { b.steer = 0; room.tick(DT); }
  assert.ok(b.car.spinT > 0, 'Omar drove into the firewall');
  assert.equal(room.walls.length, 0, 'the wall breaks');
  assert.equal(a.car.spinT, 0); assert.equal(a.stats.hits, 1);
  // shielded kart breaks through a firewall unharmed
  b.car.spinT = 0; b.car.slowT = 0;
  place(a, 2000, -40); place(c, 1700, -40); c.car.shieldT = 5;
  a.item = 'firewall'; room.useItem(a.id);
  for (let i = 0; i < 60 && room.walls.length; i++) room.tick(DT);
  assert.equal(room.walls.length, 0);
  assert.equal(c.car.spinT, 0); assert.equal(c.car.shieldT, 0);
});

test('kart: firewall expires on its own', () => {
  const { room } = mk();
  const a = join(room, 'Salma'); join(room, 'Omar');
  race(room); park(room, a); place(a, 400, 0);
  a.item = 'firewall'; room.useItem(a.id);
  run(room, RULES.FIREWALL_SEC + 0.2);
  assert.equal(room.walls.length, 0);
});

test('kart: item odds favour the back of the pack (leader never rolls a Bug Bomb, last never a Firewall)', () => {
  const { room } = mk(3);
  const ps = ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => join(room, n));
  race(room);
  ps.forEach((p, i) => place(p, 2000 - i * 100, ((i % 3) - 1) * 50));
  const count = (p) => { const c = { bomb: 0, turbo: 0, shield: 0, firewall: 0 }; for (let i = 0; i < 3000; i++) c[room.rollItem(p)]++; return c; };
  const first = count(ps[0]), last = count(ps[5]);
  assert.equal(first.bomb, 0); assert.equal(last.firewall, 0);
  assert.ok(first.shield + first.firewall > 2400);
  assert.ok(last.bomb + last.turbo > 2400);
  assert.deepEqual(K.oddsAt(0.5), K.ODDS.middle);
});

test('kart: finishing, results carry kart stats; new round resets items and boxes', () => {
  const { room } = mk();
  const a = join(room, 'Salma'); const b = join(room, 'Omar');
  race(room);
  a.item = 'bomb'; a.stats.right = 2; room.boxes[0].on = false;
  for (const p of [a, b]) p.car.totalS = room.settings.laps * TRACK.P - 5;
  run(room, 0.5);
  assert.equal(room.status, STATUS.FINISHED);
  assert.equal(room.results[0].right !== undefined, true);
  assert.equal(room.results.find((r) => r.playerId === a.id).right, 2);
  assert.equal(room.useItem(a.id).code, 'BAD_STATE');
  assert.ok(room.newRound().ok);
  assert.equal(a.item, null); assert.equal(a.stats.right, 0); assert.equal(room.boxes[0].on, true);
});

test('kart: question bank loads (short questions for 5 s)', () => {
  const bank = loadKartBank();
  assert.ok(bank.length >= 12);
  for (const q of bank) assert.ok(String(q.code).split('\n').length <= 2);
});

test('kart sockets: kart station hosts /kart; phones join, answer and use items for themselves only', async (t) => {
  const s = await startServer({ server: { kartBank: BANK } });
  t.after(s.close);
  const SUB = '11111111-2222-4333-8444-666666666666';
  s.platform.set(SUB, true);
  const tok = (game) => 'gdg_station=' + signToken({ sub: SUB, game, evt: 'e', day: 1, label: 'Booth 3', by: 'Mona' }, KEY);

  const race = sio(s.port, { ns: '/kart', cookie: tok('race') }); await race.ready;
  assert.equal((await race.emit('create-room', { origin: 'http://x' })).ok, false, 'a race station cannot host kart');
  const host = sio(s.port, { ns: '/kart', cookie: tok('kart') }); await host.ready;
  const room = await host.emit('create-room', { origin: 'http://x' });
  assert.equal(room.ok, true);
  assert.match(room.joinUrl, /\/games\/kart\/play\?room=[A-Z]{4}$/);
  assert.equal(room.config.cars.length, 8);
  assert.equal(room.room.maxPlayers, 8);

  const p1 = sio(s.port, { ns: '/kart' }); await p1.ready;
  const p2 = sio(s.port, { ns: '/kart' }); await p2.ready;
  assert.equal((await p1.emit('kart:use', {})).ok, false, 'not joined yet');
  const j1 = await p1.emit('join-room', { code: room.room.code, name: 'Salma' });
  const j2 = await p2.emit('join-room', { code: room.room.code, name: 'Omar', carId: 8 });
  assert.equal(j1.ok, true); assert.equal(j2.ok, true); assert.equal(j2.player.carName, 'Orange');
  assert.equal((await p1.emit('start-countdown')).ok, false, 'phones cannot start');
  assert.equal((await host.emit('start-countdown')).ok, true);

  const kr = s.g.karts.get(room.room.code);
  run(kr, CONFIG.COUNTDOWN_SECONDS + 0.1); // the test server's clock is not started: tick by hand
  assert.equal(kr.status, STATUS.RACING);
  const a = kr.players.get(j1.player.id);
  place(kr.players.get(j2.player.id), TRACK.P * 0.3, -60);
  const box = K.BOXES[1];
  place(a, box.s - 30, box.d);
  for (let i = 0; i < 20 && !a.q; i++) kr.tick(DT);
  const q = await p1.waitFor('kart:question', 2000);
  assert.equal(typeof q.id, 'number');
  assert.equal((await p2.emit('kart:answer', { id: q.id, choice: 0 })).code, 'LATE', 'Omar cannot answer Salma\'s box');
  const right = a.q.answer;
  const ans = await p1.emit('kart:answer', { id: q.id, choice: right });
  assert.equal(ans.kind, 'right');
  assert.equal((await p1.emit('kart:answer', { id: q.id, choice: right })).ok, false, 'duplicate ignored');
  assert.equal((await p2.emit('kart:use', {})).code, 'NO_ITEM');
  const used = await p1.emit('kart:use', {});
  assert.equal(used.ok, true); assert.equal(used.item, q.item);
  [race, host, p1, p2].forEach((c) => c.close());
});

test('kart pages: big screen needs a kart station; the phone page and kart assets are open', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const SUB = '11111111-2222-4333-8444-777777777777';
  s.platform.set(SUB, true);
  const ck = (game) => 'gdg_station=' + signToken({ sub: SUB, game, evt: 'e', day: 1, label: 'Booth 4', by: 'Mona' }, KEY);
  const { get } = require('./helpers');
  const none = await get(s.base, '/games/kart/');
  assert.equal(none.status, 403); assert.match(await none.text(), /Hold on!/);
  assert.equal((await get(s.base, '/games/kart/', ck('race'))).status, 403, 'a race station cannot open kart');
  const ok = await get(s.base, '/games/kart/', ck('kart'));
  assert.equal(ok.status, 200); assert.match(await ok.text(), /Code Kart Battle/);
  const phone = await get(s.base, '/games/kart/play?room=ABCD');
  assert.equal(phone.status, 200); assert.match(await phone.text(), /ITEM<br>BOX!/);
  for (const p of ['/games/kart.css', '/games/kart-play.css', '/games/kart-host.js', '/games/kart-play.js', '/games/shared/kart.js']) assert.equal((await get(s.base, p)).status, 200, p);
  assert.equal((await get(s.base, '/games/kart-host.html')).status, 404, 'pages only through their routes');
  assert.equal((await get(s.base, '/games/kart')).headers.get('location'), '/games/kart/');
  assert.equal((await get(s.base, '/games/', ck('kart'))).headers.get('location'), '/games/kart/');
});
