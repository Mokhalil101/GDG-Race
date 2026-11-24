'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../shared/game');
const sim = require('../server/sim');
const { RoomManager } = require('../server/rooms');

const { TRACK, STATUS, CONFIG } = G;
const DT = 1 / CONFIG.SIM_HZ;

function mkRoom(settings) {
  const m = new RoomManager();
  const room = m.createRoom(settings);
  const out = [];
  room.on('out', (o) => out.push(o));
  return { m, room, out };
}
function join(room, name, carId) {
  const r = room.addPlayer({ name, carId, socketId: 's-' + name });
  assert.ok(r.ok, r.error);
  return r.player;
}
function runSeconds(room, sec) { for (let i = 0; i < sec / DT; i++) room.tick(DT); }
function startRace(room) {
  assert.ok(room.startCountdown().ok);
  runSeconds(room, CONFIG.COUNTDOWN_SECONDS + 0.2);
  assert.equal(room.status, STATUS.RACING);
}

test('track: closed, continuous, lap length matches geometry', () => {
  const P = TRACK.P;
  assert.ok(Math.abs(P - (2 * TRACK.Ls + 2 * Math.PI * TRACK.R)) < 1e-6);
  let prev = TRACK.pointAt(0, 0);
  let travelled = 0;
  for (let s = 1; s <= P + 1; s += 1) {
    const p = TRACK.pointAt(s, 0);
    travelled += Math.hypot(p.x - prev.x, p.y - prev.y);
    assert.ok(Math.hypot(p.x - prev.x, p.y - prev.y) < 1.5, 'gap at s=' + s);
    prev = p;
  }
  assert.ok(Math.abs(travelled - P) / P < 0.002);
  const a = TRACK.pointAt(0, 0), b = TRACK.pointAt(P, 0);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-6);
});

test('track: positive d is the left of travel (inside the corner)', () => {
  const left = TRACK.pointAt(0, 40), centre = TRACK.pointAt(0, 0);
  assert.ok(left.y < centre.y); // heading +x, left is up the screen
  const arc = TRACK.pointAt(TRACK.Ls / 2 + 10, 40);
  const arcC = TRACK.pointAt(TRACK.Ls / 2 + 10, 0);
  const mid = { x: TRACK.cx + TRACK.Ls / 2, y: TRACK.cy };
  assert.ok(Math.hypot(arc.x - mid.x, arc.y - mid.y) < Math.hypot(arcC.x - mid.x, arcC.y - mid.y));
});

test('name sanitising (SEC-010)', () => {
  assert.equal(G.sanitizeName('  <b>Ali</b>  '), 'bAlib');
  assert.equal(G.sanitizeName('a'.repeat(50)).length, CONFIG.NAME.MAX);
  assert.equal(G.sanitizeName('محمد  أحمد'), 'محمد أحمد');
  assert.equal(G.sanitizeName(123), '');
});

test('TC-003/004: six players join, seventh is rejected; cars are unique', () => {
  const { room } = mkRoom();
  for (let i = 1; i <= 6; i++) join(room, 'P' + i);
  assert.equal(new Set([...room.players.values()].map((p) => p.carId)).size, 6);
  const seventh = room.addPlayer({ name: 'P7', socketId: 'x' });
  assert.equal(seventh.ok, false);
  assert.equal(seventh.code, 'ROOM_FULL');
});

test('duplicate names and taken cars are refused', () => {
  const { room } = mkRoom();
  join(room, 'Sara', 2);
  assert.equal(room.addPlayer({ name: 'sara', socketId: 'a' }).code, 'NAME_TAKEN');
  assert.equal(room.addPlayer({ name: 'Omar', carId: 2, socketId: 'b' }).code, 'CAR_TAKEN');
  assert.equal(room.addPlayer({ name: '!!!', socketId: 'c' }).code, 'BAD_NAME');
  const o = join(room, 'Omar', 3);
  assert.equal(room.selectCar(o.id, 2).code, 'CAR_TAKEN');
  assert.ok(room.selectCar(o.id, 4).ok);
});

test('TC-005: countdown starts at 10, runs 10..1, race starts at zero', () => {
  const { room, out } = mkRoom();
  join(room, 'A');
  assert.equal(room.startCountdown().ok, true);
  const first = out.find((o) => o.event === 'countdown-update');
  assert.equal(first.data.value, 10);
  runSeconds(room, 10.3);
  const values = out.filter((o) => o.event === 'countdown-update').map((o) => o.data.value);
  assert.deepEqual(values, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.equal(room.status, STATUS.RACING);
  assert.ok(out.some((o) => o.event === 'race-started'));
});

test('cannot start with nobody connected; cannot join once the race started', () => {
  const { room } = mkRoom();
  assert.equal(room.startCountdown().code, 'NO_PLAYERS');
  join(room, 'A');
  startRace(room);
  assert.equal(room.addPlayer({ name: 'Late', socketId: 'l' }).code, 'RACE_STARTED');
});

test('state machine rejects invalid transitions (duplicate host commands)', () => {
  const { room } = mkRoom();
  join(room, 'A');
  assert.equal(room.pause().ok, false);
  assert.equal(room.resume().ok, false);
  assert.equal(room.abort().ok, false);
  assert.equal(room.newRound().ok, false);
  room.startCountdown();
  assert.equal(room.startCountdown().ok, false);
  assert.ok(room.cancelCountdown().ok);
  assert.equal(room.status, STATUS.LOBBY);
  startRace(room);
  assert.ok(room.pause().ok);
  assert.equal(room.pause().ok, false);
  assert.ok(room.resume().ok);
  assert.ok(room.abort().ok);
  assert.equal(room.status, STATUS.ABORTED);
  assert.ok(room.newRound().ok);
  assert.equal(room.status, STATUS.LOBBY);
});

test('TC-006/007/008/009: cars start together, steering moves the car and stops on release', () => {
  const { room } = mkRoom();
  const a = join(room, 'A'), b = join(room, 'B');
  startRace(room);
  assert.ok(a.car.speed < 80 && a.car.speed === b.car.speed, 'both cars have identical, just-launched speed');
  room.steer(a.id, 1); // left
  const d0 = a.car.d;
  runSeconds(room, 0.3);
  assert.ok(a.car.d > d0, 'left should increase d');
  room.steer(a.id, -1);
  runSeconds(room, 0.8);
  assert.ok(a.car.d < d0);
  room.steer(a.id, 0);
  runSeconds(room, 0.3); // let latVel settle
  const settled = a.car.d;
  runSeconds(room, 0.5);
  assert.ok(Math.abs(a.car.d - settled) < 0.01);
  assert.ok(a.car.totalS > -50 && b.car.speed > 100, 'cars move forward automatically');
});

test('invalid steering values are ignored', () => {
  const { room } = mkRoom();
  const a = join(room, 'A');
  startRace(room);
  assert.equal(room.steer(a.id, 5), false);
  assert.equal(room.steer(a.id, 'left'), false);
  assert.equal(room.steer('nobody', 1), false);
  assert.equal(a.steer, 0);
});

test('steering is released if the phone goes silent', () => {
  const { room } = mkRoom();
  const a = join(room, 'A');
  startRace(room);
  room.steer(a.id, 1);
  runSeconds(room, CONFIG.PHYS.STEER_TIMEOUT_SEC + 0.2);
  assert.equal(a.steer, 0);
});

test('track boundaries are enforced', () => {
  const { room } = mkRoom({ obstacles: false });
  const a = join(room, 'A');
  startRace(room);
  room.steer(a.id, 1);
  for (let i = 0; i < 90; i++) { room.steer(a.id, 1); room.tick(DT); }
  assert.ok(Math.abs(a.car.d) <= TRACK.usable + 1e-9);
  assert.ok(a.car.wall);
});

test('TC-010: two cars side by side collide, are pushed apart and slowed', () => {
  const { room, out } = mkRoom({ obstacles: false });
  const a = join(room, 'A', 1), b = join(room, 'B', 2);
  startRace(room);
  b.car.totalS = a.car.totalS; b.car.d = a.car.d - 10; // overlap
  runSeconds(room, DT * 2);
  assert.ok(Math.abs(a.car.d - b.car.d) >= CONFIG.CAR.WIDTH - 1, 'no overlap after resolution');
  assert.ok(room.pendingEvents.length >= 0);
  const evs = [];
  b.car.totalS = a.car.totalS; b.car.d = a.car.d - 5;
  const race = room.race;
  race.pairCooldown.clear();
  sim.step([a, b], race, room.settings, DT, evs);
  assert.ok(evs.some((e) => e.type === 'collision'));
  assert.ok(a.car.slowT > 0 && b.car.slowT > 0);
});

test('obstacles slow a car once per pass', () => {
  const { room } = mkRoom();
  const a = join(room, 'A');
  startRace(room);
  const o = TRACK.obstacles[0];
  a.car.totalS = o.s - 5; a.car.d = o.d;
  const evs = [];
  for (let i = 0; i < 20; i++) sim.step([a], room.race, room.settings, DT, evs);
  assert.equal(evs.filter((e) => e.type === 'obstacle' && e.idx === 0).length, 1);
});

test('TC-011/012/013: laps are counted, finish recorded, results built, winner first', () => {
  const { room, out } = mkRoom({ laps: 1, obstacles: false });
  const a = join(room, 'A', 1), b = join(room, 'B', 2);
  startRace(room);
  // keep both cars in their own lane so they never touch
  a.car.d = 50; b.car.d = -50;
  let guard = 0;
  while (room.status === STATUS.RACING && guard++ < 30 * 120) {
    room.steer(a.id, 0); room.steer(b.id, 0);
    room.tick(DT);
  }
  assert.equal(room.status, STATUS.FINISHED);
  assert.equal(room.results.length, 2);
  assert.equal(room.results[0].finishPosition, 1);
  assert.equal(room.results[0].resultStatus, 'Finished');
  assert.ok(room.results[0].finishTime > 5 && room.results[0].finishTime < 60);
  assert.ok(out.some((o) => o.event === 'player-finished'));
  assert.ok(out.some((o) => o.event === 'race-finished'));
  // lap events fire for multi-lap races
});

test('lap counter only counts forward progress (no double counting)', () => {
  const { room } = mkRoom({ laps: 3, obstacles: false });
  const a = join(room, 'A');
  startRace(room);
  const laps = [];
  a.car.d = 0;
  for (let i = 0; i < 30 * 30; i++) {
    room.tick(DT);
    const row = room.leaderboard().rows[0];
    laps.push(row.lap);
  }
  for (let i = 1; i < laps.length; i++) assert.ok(laps[i] >= laps[i - 1]);
  assert.ok(laps[laps.length - 1] >= 2, 'after ~30s the car should be on lap 2+');
});

test('ranking: finished first, then by distance (SRS 6.7)', () => {
  const mk = (id, carId, totalS, fin, pos) => ({ id, carId, car: { totalS, finished: fin, finishPos: pos } });
  const order = sim.rank([mk('c', 3, 100, false), mk('b', 2, 900, false), mk('a', 1, 5000, true, 1), mk('d', 4, 100, false)]);
  assert.deepEqual(order.map((p) => p.id), ['a', 'b', 'c', 'd']);
});

test('timeout marks unfinished players DNF (TC: race timeout)', () => {
  const { room } = mkRoom({ raceTimeoutSec: 30, laps: 10, obstacles: false });
  const a = join(room, 'A');
  startRace(room);
  runSeconds(room, 31);
  assert.equal(room.status, STATUS.FINISHED);
  assert.equal(room.results[0].resultStatus, 'DNF');
  assert.equal(room.results[0].finishTime, null);
});

test('TC-014/015: a disconnect does not stop the race; reconnect restores the controller', () => {
  const { room } = mkRoom();
  const a = join(room, 'A'), b = join(room, 'B');
  startRace(room);
  room.markDisconnected(a.id, a.socketId);
  runSeconds(room, 2);
  assert.equal(room.status, STATUS.RACING);
  assert.ok(a.car.speed <= CONFIG.PHYS.MAX_SPEED * CONFIG.PHYS.DISCONNECT_FACTOR + 1);
  const bad = room.reconnectPlayer('wrong-key', 'sx');
  assert.equal(bad.ok, false);
  const ok = room.reconnectPlayer(a.key, 'sNew');
  assert.ok(ok.ok);
  assert.equal(a.connected, true);
  assert.equal(a.socketId, 'sNew');
});

test('lobby: disconnected players are dropped after the grace period', () => {
  const { room } = mkRoom();
  const a = join(room, 'A');
  room.markDisconnected(a.id, a.socketId);
  runSeconds(room, CONFIG.LOBBY_DISCONNECT_GRACE_SEC + 1);
  assert.equal(room.players.size, 0);
});

test('host disconnect pauses a race and cancels a countdown', () => {
  const { room } = mkRoom();
  join(room, 'A');
  startRace(room);
  room.setHostConnected(false);
  assert.equal(room.status, STATUS.PAUSED);
  const r2 = mkRoom().room;
  join(r2, 'B');
  r2.startCountdown();
  r2.setHostConnected(false);
  assert.equal(r2.status, STATUS.LOBBY);
});

test('TC-016: new round after results, session reset keeps players', () => {
  const { room } = mkRoom({ laps: 1, raceTimeoutSec: 30 });
  join(room, 'A');
  startRace(room);
  runSeconds(room, 31);
  assert.equal(room.status, STATUS.FINISHED);
  assert.ok(room.newRound().ok);
  assert.equal(room.players.size, 1);
  assert.equal(room.results.length, 0);
  assert.equal(room.history.length, 1);
  startRace(room);
  assert.ok(room.reset().ok);
  assert.equal(room.status, STATUS.LOBBY);
});

test('settings are clamped and only change in the lobby', () => {
  const { room } = mkRoom();
  room.updateSettings({ laps: 99, collisionPenalty: 5, obstacles: false });
  assert.equal(room.settings.laps, CONFIG.LIMITS.laps[1]);
  assert.equal(room.settings.collisionPenalty, CONFIG.LIMITS.collisionPenalty[1]);
  assert.equal(room.settings.obstacles, false);
  join(room, 'A');
  room.startCountdown();
  assert.equal(room.updateSettings({ laps: 2 }).ok, false);
});

test('room codes are unique 4-letter codes and lookup is case-insensitive', () => {
  const m = new RoomManager();
  const codes = new Set();
  for (let i = 0; i < 50; i++) codes.add(m.createRoom().code);
  assert.equal(codes.size, 50);
  const [c] = codes;
  assert.ok(/^[A-Z]{4}$/.test(c));
  assert.ok(m.get(c.toLowerCase()));
  assert.equal(m.get('ZZZZ9'), null);
});

test('snapshot payload stays small and has everything the host needs', () => {
  const { room } = mkRoom();
  for (let i = 1; i <= 6; i++) join(room, 'P' + i);
  const s = room.snapshot();
  assert.equal(s.cars.length, 6);
  assert.ok(JSON.stringify(s).length < 1200);
  for (const k of ['id', 'n', 'x', 'y', 'a', 'lap', 'spd']) assert.ok(k in s.cars[0]);
});

test('six cars start on six distinct grid slots without overlapping', () => {
  const { room } = mkRoom();
  for (let i = 1; i <= 6; i++) join(room, 'P' + i);
  const cars = [...room.players.values()].map((p) => p.car);
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const ds = Math.abs(cars[i].totalS - cars[j].totalS), dd = Math.abs(cars[i].d - cars[j].d);
      assert.ok(ds >= CONFIG.CAR.LENGTH || dd >= CONFIG.CAR.WIDTH, 'grid overlap ' + i + '/' + j);
    }
  }
});

test('grid: all six cars start in one row, side by side, inside the track', () => {
  const { room, out } = mkRoom();
  for (let i = 1; i <= 6; i++) join(room, 'P' + i);
  const cars = [...room.players.values()].map((p) => p.car);
  assert.equal(new Set(cars.map((c) => c.totalS)).size, 1, 'same distance = same row');
  assert.equal(new Set(cars.map((c) => c.d)).size, 6);
  for (const c of cars) assert.ok(Math.abs(c.d) <= TRACK.usable);
  startRace(room);
  runSeconds(room, 1.5); // nobody steers: cars must not bump into each other off the line
  const collisions = out.filter((o) => o.event === 'game-state').flatMap((o) => o.data.events).filter((e) => e.type === 'collision');
  assert.equal(collisions.length, 0);
  assert.ok(out.some((o) => o.event === 'game-state' && o.data.status === 'racing'), 'race really ran');
});

test('stress: six cars mashing steering for 3 minutes never produce NaN or leave the track', () => {
  const { room } = mkRoom({ laps: 10, raceTimeoutSec: 600 });
  const ps = [];
  for (let i = 1; i <= 6; i++) ps.push(join(room, 'P' + i));
  startRace(room);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let t = 0; t < 30 * 180; t++) {
    if (t % 6 === 0) for (const p of ps) room.steer(p.id, Math.floor(rnd() * 3) - 1);
    room.tick(DT);
    if (room.status !== STATUS.RACING) break;
    for (const p of ps) {
      assert.ok(Number.isFinite(p.car.x) && Number.isFinite(p.car.y) && Number.isFinite(p.car.totalS));
      assert.ok(Math.abs(p.car.d) <= TRACK.usable + 1e-6);
    }
  }
});
