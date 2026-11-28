'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RaidManager, RAID, PHASE, loadBank } = require('../server/raid');

const bank = loadBank();
function mk(config) {
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const m = new RaidManager({ bank, random });
  const room = m.createRoom({ config });
  const out = [];
  room.on('out', (o) => out.push(o));
  return { room, out };
}
function join(room, name) { const r = room.addPlayer({ name, socketId: 's-' + name }); assert.ok(r.ok, r.error); return r.player; }
const right = (room) => room.current.answer;
const wrongOf = (room) => (room.current.answer + 1) % 4;
function toQuestion(room) { assert.ok(room.start().ok); room.tick(RAID.INTRO_SEC + 0.01); assert.equal(room.phase, PHASE.QUESTION); }

test('raid: question bank is valid and has enough items', () => {
  assert.ok(bank.length >= 40);
  for (const q of bank) { assert.equal(q.options.length, 4); assert.ok(q.answer >= 0 && q.answer < 4); assert.equal(new Set(q.options).size, 4); }
});

test('raid: teams are balanced and HP scales with players', () => {
  const { room } = mk();
  const ps = Array.from({ length: 10 }, (_, i) => join(room, 'P' + i));
  assert.deepEqual(room.teamCounts(), [3, 3, 2, 2]);
  assert.ok(room.start().ok);
  assert.equal(room.maxHp, Math.max(RAID.MIN_HP, 10 * RAID.HP_PER_PLAYER));
  assert.equal(room.hp, room.maxHp);
  assert.equal(ps.length, 10);
  const { room: r2 } = mk(); join(r2, 'solo'); r2.start();
  assert.equal(r2.maxHp, RAID.MIN_HP, 'minimum HP for tiny rooms');
  const { room: r3 } = mk();
  assert.equal(r3.start().code, 'NO_PLAYERS');
});

test('raid: the question goes out without the answer; the answer stays on the server', () => {
  const { room, out } = mk();
  join(room, 'A');
  toQuestion(room);
  const phase = out.filter((o) => o.event === 'raid:phase').at(-1).data;
  assert.equal(phase.phase, 'question');
  assert.equal(phase.question.options.length, 4);
  assert.equal(phase.correct, undefined);
  assert.equal(JSON.stringify(phase).includes('"answer"'), false);
});

test('raid: damage = base x speed x combo (+ crit for the first hit), wrong answers reset the combo', () => {
  const { room } = mk({ HP_PER_PLAYER: 1e6 });
  const a = join(room, 'A'), b = join(room, 'B');
  toQuestion(room);
  // A answers instantly (speed ~2) and is first -> crit x2 ; B answers at half time -> speed 1.5
  assert.ok(room.answer(a.id, { round: 1, choice: right(room) }).ok);
  assert.equal(a.damage, Math.round(RAID.BASE_DAMAGE * 2 * 1 * RAID.FIRST_HIT_CRIT), 'instant + first hit = crit');
  room.tick(RAID.QUESTION_SEC / 2);
  assert.ok(room.answer(b.id, { round: 1, choice: right(room) }).ok);
  assert.equal(b.damage, Math.round(RAID.BASE_DAMAGE * 1.5));
  assert.equal(a.combo, 1); assert.equal(b.combo, 1);
  assert.equal(room.hp, room.maxHp - a.damage - b.damage);
  assert.equal(room.teamDamage[a.team], a.damage);

  // round 2: A right again -> combo x2; B wrong -> combo 0, no damage
  room.next(); room.next();
  assert.equal(room.round, 2);
  const before = a.damage;
  room.answer(a.id, { round: 2, choice: right(room) });
  assert.equal(a.combo, 2);
  assert.equal(a.damage - before, Math.round(RAID.BASE_DAMAGE * 2 * 2 * RAID.FIRST_HIT_CRIT), 'instant answer, combo 2, crit');
  const bBefore = b.damage;
  assert.ok(room.answer(b.id, { round: 2, choice: wrongOf(room) }).ok);
  assert.equal(b.combo, 0); assert.equal(b.damage, bBefore);
  assert.equal(b.lastResult.correct, false);

  // round 3: B gets it right but slower, A doesn't answer -> A's combo resets at reveal
  room.next(); room.next();
  room.tick(RAID.QUESTION_SEC * 0.75);
  room.answer(b.id, { round: 3, choice: right(room) });
  assert.equal(b.combo, 1);
  assert.equal(b.lastResult.damage, Math.round(RAID.BASE_DAMAGE * 1.25 * 1 * RAID.FIRST_HIT_CRIT));
  room.next(); // reveal
  assert.equal(room.phase, PHASE.REVEAL);
  assert.equal(a.combo, 0);
  assert.equal(a.lastResult.correct, null);
});

test('raid: duplicate answers in a round are ignored; late / bad / out-of-phase answers rejected', () => {
  const { room } = mk({ HP_PER_PLAYER: 1e6 });
  const a = join(room, 'A'); join(room, 'B');
  assert.equal(room.answer(a.id, { round: 0, choice: 0 }).code, 'NOT_OPEN');
  toQuestion(room);
  assert.equal(room.answer(a.id, { round: 1, choice: 9 }).code, 'BAD_CHOICE');
  assert.equal(room.answer(a.id, { round: 1, choice: '1; drop' }).code, 'BAD_CHOICE');
  assert.equal(room.answer(a.id, { round: 2, choice: 0 }).code, 'LATE');
  assert.ok(room.answer(a.id, { round: 1, choice: wrongOf(room) }).ok);
  assert.equal(room.answer(a.id, { round: 1, choice: right(room) }).code, 'DUPLICATE');
  assert.equal(a.damage, 0, 'second answer did not count');
  assert.equal(room.answered, 1);
  room.pause();
  assert.equal(room.answer('nobody', { round: 1, choice: 0 }).code, 'NO_PLAYER');
  room.pause();
  room.next();
  assert.equal(room.answer(a.id, { round: 1, choice: right(room) }).code, 'NOT_OPEN');
});

test('raid: 8 rounds then defeat if the boss survives; timers drive the phases', () => {
  const { room, out } = mk();
  join(room, 'A');
  toQuestion(room);
  for (let r = 1; r <= RAID.ROUNDS; r++) {
    assert.equal(room.round, r);
    assert.equal(room.phase, PHASE.QUESTION);
    room.tick(RAID.QUESTION_SEC + 0.01);
    assert.equal(room.phase, PHASE.REVEAL);
    room.tick(RAID.REVEAL_SEC + 0.01);
  }
  assert.equal(room.phase, PHASE.FINISHED);
  assert.equal(room.outcome, 'defeat');
  const fin = out.filter((o) => o.event === 'raid:final');
  assert.equal(fin.length, 1);
  assert.equal(fin[0].data.outcome, 'defeat');
});

test('raid: everyone answered closes the question early; pause freezes the clock', () => {
  const { room } = mk({ HP_PER_PLAYER: 1e6 });
  const a = join(room, 'A'), b = join(room, 'B');
  toQuestion(room);
  room.pause();
  room.tick(100);
  assert.equal(room.phase, PHASE.QUESTION, 'paused: no timeout');
  assert.equal(room.answer(a.id, { round: 1, choice: 0 }).code, 'PAUSED');
  room.pause();
  room.answer(a.id, { round: 1, choice: 0 });
  room.tick(0.1);
  assert.equal(room.phase, PHASE.QUESTION);
  room.answer(b.id, { round: 1, choice: 1 });
  room.tick(0.1);
  assert.equal(room.phase, PHASE.REVEAL);
});

test('raid: the killing blow wins at once and is credited; top team is reported', () => {
  const { room, out } = mk({ HP_PER_PLAYER: 100, MIN_HP: 300 });
  const a = join(room, 'A');
  toQuestion(room);
  room.answer(a.id, { round: 1, choice: right(room) }); // ~400 dmg (2 x 2 crit) > 300 HP
  assert.equal(room.phase, PHASE.FINISHED);
  assert.equal(room.outcome, 'victory');
  assert.equal(room.hp, 0);
  assert.equal(room.finalHit.name, 'A');
  const v = room.state();
  assert.equal(v.finalHit.name, 'A');
  assert.equal(v.topTeam, a.team);
  const fin = out.find((o) => o.event === 'raid:final' && o.target.socket === 's-A');
  assert.equal(fin.data.finalHit, true);
  assert.equal(fin.data.rank, 1);
  // further answers are ignored
  assert.equal(room.answer(a.id, { round: 1, choice: 0 }).ok, false);
});

test('raid: late joiners can play the current round and make the boss tougher', () => {
  const { room } = mk({ HP_PER_PLAYER: 1000, MIN_HP: 0 });
  join(room, 'A'); join(room, 'B');
  toQuestion(room);
  assert.equal(room.maxHp, 2000);
  const late = join(room, 'Late'); // round 1 of 8: a full share
  assert.equal(room.maxHp, 3000); assert.equal(room.hp, 3000);
  assert.ok(room.answer(late.id, { round: 1, choice: right(room) }).ok);
  assert.ok(late.damage > 0);
  room.next(); // reveal round 1 -> 7 of 8 rounds left
  join(room, 'Later');
  assert.equal(room.maxHp, 3000 + Math.round(1000 * 7 / 8));
  // finished rooms: joiners wait for the next raid (no HP change)
  room.end();
  const hp = room.maxHp;
  join(room, 'After');
  assert.equal(room.maxHp, hp);
  assert.ok(room.again().ok);
  assert.equal(room.phase, PHASE.LOBBY);
  assert.equal(room.players.size, 5);
  assert.equal([...room.players.values()].every((p) => p.damage === 0 && p.combo === 0), true);
});

test('raid: reconnect with the key keeps the player and score; host gets batched state, hits are volatile', () => {
  const { room, out } = mk({ HP_PER_PLAYER: 1e6 });
  const a = join(room, 'A');
  toQuestion(room);
  room.answer(a.id, { round: 1, choice: right(room) });
  room.markDisconnected(a.id, 's-A');
  assert.equal(a.connected, false);
  const r = room.reconnectPlayer(a.key, 's-A2');
  assert.ok(r.ok);
  assert.equal(r.previousSocketId, 's-A');
  assert.equal(room.youView(a).answeredThis, true);
  assert.ok(room.youView(a).damage > 0);
  assert.equal(room.reconnectPlayer('nope', 'x').code, 'NO_SESSION');
  out.length = 0;
  for (let i = 0; i < 40; i++) room.tick(0.1); // 4 s
  const states = out.filter((o) => o.event === 'raid:state');
  assert.ok(states.length >= 14 && states.length <= 17, 'about 4 states per second, got ' + states.length);
  assert.ok(states.every((o) => o.target === 'host'), 'aggregate state only goes to the big screen');
});

test('raid: 300 phones in one room stays cheap and bounded', () => {
  const { room, out } = mk();
  const ps = Array.from({ length: 300 }, (_, i) => join(room, 'P' + i));
  toQuestion(room);
  out.length = 0;
  const t0 = process.hrtime.bigint();
  ps.forEach((p, i) => room.answer(p.id, { round: 1, choice: i % 3 === 0 ? wrongOf(room) : right(room) }));
  room.tick(0.3);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 200, 'took ' + ms + ' ms');
  const hits = out.filter((o) => o.event === 'raid:hits');
  assert.ok(hits.length >= 1);
  assert.ok(hits.every((h) => h.volatile && h.data.length <= RAID.MAX_HITS_PER_BATCH));
  const st = out.filter((o) => o.event === 'raid:state').at(-1).data;
  assert.equal(st.players, 300);
  assert.equal(st.top.length, RAID.TOP_N);
  assert.equal(st.answered, 300);
  assert.equal(room.phase, PHASE.REVEAL, 'all answered closes the round');
  const results = out.filter((o) => o.event === 'raid:result');
  assert.equal(results.length, 300, 'one personal result per phone');
});
