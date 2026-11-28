'use strict';
/**
 * Authoritative race simulation (SRS 8.3). Pure functions - no sockets, no timers.
 * A "player" here is any object with: { id, carId, connected, steer, car: {...} }.
 */
const { CONFIG, TRACK, clamp } = require('../shared/game');

const PH = CONFIG.PHYS;
const P = TRACK.P;
const QUARTER = P / 4;

// All cars start side by side in ONE row across the start line (car 1 on the inside/left, car 6 on the outside).
// Spacing 28 > car width 26, so the six cars fit in the 190px track without touching.
const GRID_SPACING = 28;
function gridSlot(carId) {
  const i = Math.max(0, carId - 1);
  return { d: ((CONFIG.MAX_PLAYERS - 1) / 2 - i) * GRID_SPACING, totalS: -40 };
}

function wrapS(totalS) { return ((totalS % P) + P) % P; }

function updatePose(car) {
  const pt = TRACK.pointAt(wrapS(car.totalS), car.d);
  car.x = pt.x; car.y = pt.y; car.a = pt.a;
}

function newCar(carId) {
  const car = {};
  resetCar(car, carId);
  return car;
}

/** Put a car back on its unique grid slot. */
function resetCar(car, carId) {
  const g = gridSlot(carId);
  car.totalS = g.totalS; car.d = g.d; car.latVel = 0; car.speed = 0;
  car.slowT = 0; car.slowF = 1; car.wall = false; car.boostT = 0; car.boostF = 1;
  car.finished = false; car.finishTime = null; car.finishPos = null; car.dnf = false;
  car.obstacleCooldown = {};
  updatePose(car);
  return car;
}

function pairKey(a, b) { return a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id; }

function wrapDelta(a, b) { // signed shortest distance a-b along the loop
  return ((a - b + P / 2) % P + P) % P - P / 2;
}

/**
 * Advance the race by dt seconds.
 * race = { time, finishCount, firstFinishAt, pairCooldown: Map }
 * settings = { laps, collisionPenalty, obstacles }
 * events is an array that receives {type, ...} entries for the host to render.
 */
function step(list, race, settings, dt, events) {
  const total = settings.laps * P;
  race.time += dt;

  for (const p of list) {
    const c = p.car;
    const prev = c.totalS;

    // --- steering (server validates: only -1/0/1, ignored when disconnected or done)
    const canSteer = p.connected && !c.finished && !c.dnf;
    const steer = canSteer ? p.steer : 0;
    if (c.finished) {
      c.d += (0 - c.d) * Math.min(1, dt * 2); // drift to the middle on the victory lap
      c.latVel = 0;
    } else {
      const target = steer * PH.LAT_SPEED;
      const dv = clamp(target - c.latVel, -PH.LAT_ACCEL * dt, PH.LAT_ACCEL * dt);
      c.latVel += dv;
      c.d += c.latVel * dt;
    }
    c.wall = false;
    if (c.d > TRACK.usable) { c.d = TRACK.usable; if (c.latVel > 0) c.latVel = 0; c.wall = true; }
    if (c.d < -TRACK.usable) { c.d = -TRACK.usable; if (c.latVel < 0) c.latVel = 0; c.wall = true; }

    // --- speed
    let factor = 1;
    if (c.finished) factor = PH.GHOST_FACTOR;
    else {
      if (c.wall && steer !== 0) factor = Math.min(factor, PH.WALL_FACTOR);
      if (!p.connected) factor = Math.min(factor, PH.DISCONNECT_FACTOR);
      if (c.slowT > 0) { factor = Math.min(factor, c.slowF); c.slowT -= dt; }
      // turbo (Code Kart Battle only; GDG Race never sets boostT): beats every slow-down while it lasts
      if (c.boostT > 0) { factor = c.boostF; c.boostT -= dt; }
    }
    const targetSpeed = PH.MAX_SPEED * factor;
    if (c.speed < targetSpeed) c.speed = Math.min(targetSpeed, c.speed + PH.ACCEL * dt);
    else c.speed = Math.max(targetSpeed, c.speed - PH.BRAKE * dt);

    // --- advance along the track (own-lane distance -> centre-line distance)
    const dist = c.speed * dt;
    c.totalS += dist * TRACK.progressFactor(wrapS(c.totalS), c.d, PH.INSIDE_BONUS);

    // --- checkpoints / laps
    const qOld = Math.floor(prev / QUARTER), qNew = Math.floor(c.totalS / QUARTER);
    if (!c.finished && qNew > qOld && qNew > 0) {
      events.push({ type: 'checkpoint', id: p.id, idx: qNew % 4 });
      if (qNew % 4 === 0 && c.totalS < total) events.push({ type: 'lap', id: p.id, lap: qNew / 4 });
    }

    // --- finish line
    if (!c.finished && c.totalS >= total) {
      const frac = (total - prev) / Math.max(1e-9, c.totalS - prev);
      c.finished = true;
      c.finishTime = Math.max(0, race.time - dt * (1 - frac));
      c.finishPos = ++race.finishCount;
      if (race.firstFinishAt == null) race.firstFinishAt = race.time;
      events.push({ type: 'finish', id: p.id, pos: c.finishPos, time: c.finishTime });
    }
    updatePose(c);
  }

  const active = list.filter((p) => !p.car.finished && !p.car.dnf);

  // --- car vs car collisions
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      collide(active[i], active[j], race, settings, events);
    }
  }
  // --- cars vs obstacles
  if (settings.obstacles) {
    for (const p of active) hitObstacles(p, race, events);
  }
  for (const p of active) {
    p.car.d = clamp(p.car.d, -TRACK.usable, TRACK.usable);
    updatePose(p.car);
  }
  // expire cooldowns
  for (const [k, until] of race.pairCooldown) if (until <= race.time) race.pairCooldown.delete(k);
}

function collide(a, b, race, settings, events) {
  const ca = a.car, cb = b.car;
  const ds = wrapDelta(wrapS(ca.totalS), wrapS(cb.totalS)); // + => a ahead of b
  const dd = ca.d - cb.d;
  if (Math.abs(ds) >= CONFIG.CAR.LENGTH || Math.abs(dd) >= CONFIG.CAR.WIDTH) return;

  const front = ds >= 0 ? a : b, rear = ds >= 0 ? b : a;

  // 1) push apart sideways (cannot pass through each other)
  const overlapD = CONFIG.CAR.WIDTH - Math.abs(dd);
  let dir = dd === 0 ? (a.id < b.id ? 1 : -1) : Math.sign(dd);
  ca.d += dir * (overlapD / 2 + 0.5);
  cb.d -= dir * (overlapD / 2 + 0.5);
  ca.d = clamp(ca.d, -TRACK.usable, TRACK.usable);
  cb.d = clamp(cb.d, -TRACK.usable, TRACK.usable);

  // 2) still overlapping (e.g. pinned against a wall)? shove the rear car backwards
  if (Math.abs(ca.d - cb.d) < CONFIG.CAR.WIDTH) {
    rear.car.totalS -= (CONFIG.CAR.LENGTH - Math.abs(ds)) + 0.5;
  }

  // 3) penalties (configurable). Rear car loses more speed than the car it hit.
  const pen = settings.collisionPenalty;
  setSlow(rear.car, 1 - pen, PH.COLLISION_SLOW_SEC);
  setSlow(front.car, 1 - pen * 0.4, PH.COLLISION_SLOW_SEC * 0.6);

  const key = pairKey(a, b);
  if (!race.pairCooldown.has(key)) {
    race.pairCooldown.set(key, race.time + 0.5);
    events.push({ type: 'collision', a: a.id, b: b.id, x: (ca.x + cb.x) / 2, y: (ca.y + cb.y) / 2 });
  }
}

function setSlow(car, factor, seconds) {
  if (car.slowT <= 0 || factor < car.slowF) car.slowF = factor;
  car.slowT = Math.max(car.slowT, seconds);
}

function hitObstacles(p, race, events) {
  const c = p.car;
  TRACK.obstacles.forEach((o, idx) => {
    const ds = wrapDelta(wrapS(c.totalS), o.s);
    if (Math.abs(ds) < CONFIG.CAR.LENGTH / 2 + o.r && Math.abs(c.d - o.d) < CONFIG.CAR.WIDTH / 2 + o.r) {
      const until = c.obstacleCooldown[idx] || 0;
      if (race.time >= until) {
        c.obstacleCooldown[idx] = race.time + 1.2;
        setSlow(c, PH.OBSTACLE_FACTOR, PH.OBSTACLE_SLOW_SEC);
        events.push({ type: 'obstacle', id: p.id, idx });
      }
    }
  });
}

/** SRS 6.7: finished by finish position, then completed laps / lap progress / distance, then id. */
function rank(list) {
  return list.slice().sort((a, b) => {
    const A = a.car, B = b.car;
    if (A.finished && B.finished) return A.finishPos - B.finishPos;
    if (A.finished) return -1;
    if (B.finished) return 1;
    if (B.totalS !== A.totalS) return B.totalS - A.totalS;
    return a.carId - b.carId;
  });
}

function completedLaps(car, laps) {
  return car.finished ? laps : clamp(Math.floor(Math.max(0, car.totalS) / P), 0, laps);
}

module.exports = { step, rank, newCar, resetCar, updatePose, gridSlot, completedLaps, wrapS, wrapDelta, setSlow };
