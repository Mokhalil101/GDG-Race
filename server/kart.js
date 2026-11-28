'use strict';
/**
 * CODE KART BATTLE - GDG Race + rainbow "?" item boxes. Built on the GDG Race room (server/rooms.js) and simulation
 * (server/sim.js); everything kart-specific lives here and is server-authoritative:
 *  - drive over a box -> the server rolls an item for your position and sends a 5 s question to your phone only;
 *    your kart keeps driving straight (steering is ignored) until you answer
 *  - right -> you hold that item; wrong -> spin out 2 s; no answer -> nothing (streak lost); 3 right in a row -> auto Turbo
 *  - "use item" from the phone: Bug Bomb hits the kart ahead (the one behind if you lead), Turbo, Shield (blocks the next
 *    hit), Firewall (a wall in your lane behind you that spins out whoever drives into it)
 *  - boxes respawn a few seconds after they are taken
 * Like rooms.js there is no socket code: everything leaves through the 'out' event.
 */
const fs = require('fs');
const path = require('path');
const G = require('../shared/game');
const K = require('../shared/kart');
const sim = require('./sim');
const { Room, RoomManager } = require('./rooms');

const { CONFIG, STATUS, TRACK, clamp } = G;
const { RULES, ITEMS, BOXES, EV } = K;
const fail = (code, error) => ({ ok: false, code, error });
const r1 = (n) => Math.round(n * 10) / 10;

/** Question bank: the Boss Raid bank (read-only copy of CodeBreaker's print-output questions). Short ones first. */
function loadKartBank(file = path.join(__dirname, '..', 'data', 'raid-questions.json')) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const all = (Array.isArray(j) ? j : j.questions).filter((q) =>
    q && typeof q.prompt === 'string' && Array.isArray(q.options) && q.options.length === 4 &&
    Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4);
  // 5 seconds is short: prefer code that fits in two lines
  const short = all.filter((q) => String(q.code || '').split('\n').length <= 2);
  const list = short.length >= 12 ? short : all;
  if (list.length < 4) throw new Error('Code Kart Battle needs at least 4 questions');
  return list;
}

class KartRoom extends Room {
  constructor(opts) {
    super(Object.assign({}, opts, {
      cars: K.CARS, maxPlayers: RULES.MAX_PLAYERS,
      defaults: Object.assign({ obstacles: false }, opts.defaults),
    }));
    this.bank = opts.bank;
    this.random = opts.random || Math.random;
    this.qSeq = 0;
    this.wallSeq = 0;
    this._resetKart();
  }

  // ---------- kart state ----------
  _resetKart() {
    this.boxes = BOXES.map((b) => ({ i: b.i, s: b.s, d: b.d, on: true, back: 0 }));
    this.walls = [];
    this.feed = [];
    for (const p of this.players.values()) this._resetKartPlayer(p);
  }

  _resetKartPlayer(p) {
    p.item = null; p.q = null; p.streak = 0;
    p.stats = { right: 0, wrong: 0, items: 0, hits: 0, blocked: 0, turbos: 0 };
    p.lastResult = null;
    p.deck = [];
  }

  _resetCar(p) {
    sim.resetCar(p.car, p.carId);
    const g = K.gridSlot(p.carId);
    p.car.d = g.d; p.car.totalS = g.totalS;
    p.car.spinT = 0; p.car.shieldT = 0;
    sim.updatePose(p.car);
    if (!p.stats) this._resetKartPlayer(p);
  }

  _now() { return this.race ? this.race.time : 0; }

  // ---------- room lifecycle (keep the race behaviour, reset the kart parts) ----------
  startCountdown() {
    const r = super.startCountdown();
    if (r.ok) { this._resetKart(); this._sendAllYou(); }
    return r;
  }
  _toLobby() { super._toLobby(); this._resetKart(); this._sendAllYou(); }
  abort() {
    const r = super.abort();
    if (r.ok) { for (const p of this.players.values()) { p.q = null; p.item = null; } this._sendAllYou(); }
    return r;
  }
  _endRace(reason) {
    for (const p of this.players.values()) p.q = null;
    super._endRace(reason);
    this._sendAllYou();
  }
  _resultExtra(p) {
    return { right: p.stats.right, wrong: p.stats.wrong, hits: p.stats.hits, items: p.stats.items, turbos: p.stats.turbos };
  }

  /** Steering is ignored while you answer (the kart drives straight) and while you spin. */
  steer(playerId, dir) {
    const p = this.players.get(playerId);
    if (p && (p.q || p.car.spinT > 0)) { p.steer = 0; return false; }
    return super.steer(playerId, dir);
  }

  // ---------- physics step: kart rules around the race simulation ----------
  _simStep(list, dt, events) {
    const now = this._now();
    for (const p of list) {
      const c = p.car;
      if (c.spinT > 0) { c.spinT = Math.max(0, c.spinT - dt); p.steer = 0; }
      if (c.shieldT > 0) {
        c.shieldT = Math.max(0, c.shieldT - dt);
        if (c.shieldT === 0) { events.push({ type: 'shieldOff', id: p.id }); this._you(p); }
      }
      if (p.q) {
        p.steer = 0;
        if (now >= p.q.endsAt) this._settle(p, null, events); // time is up
      }
    }
    for (const b of this.boxes) if (!b.on && now >= b.back) { b.on = true; events.push({ type: 'boxBack', i: b.i }); }
    this.walls = this.walls.filter((w) => {
      if (now < w.until) return true;
      events.push({ type: 'wallGone', wall: w.id });
      return false;
    });

    sim.step(list, this.race, this.settings, dt, events);

    for (const p of list) {
      const c = p.car;
      if (c.finished || c.dnf) {
        if (p.q) { p.q = null; this._you(p); }
        continue;
      }
      this._pickupBoxes(p, events);
      this._hitWalls(p, events);
    }
  }

  _overlaps(c, s, d, halfL, halfW) {
    return Math.abs(sim.wrapDelta(sim.wrapS(c.totalS), s)) < CONFIG.CAR.LENGTH / 2 + halfL &&
      Math.abs(c.d - d) < CONFIG.CAR.WIDTH / 2 + halfW;
  }

  _pickupBoxes(p, events) {
    const c = p.car;
    // hands full, already answering or spinning: drive straight through, the box stays for someone else
    if (p.item || p.q || c.spinT > 0 || c.totalS < 0) return;
    for (const b of this.boxes) {
      if (!b.on || !this._overlaps(c, b.s, b.d, RULES.BOX_R, RULES.BOX_R)) continue;
      b.on = false; b.back = this._now() + RULES.BOX_RESPAWN_SEC;
      this._ask(p, b, events);
      return;
    }
  }

  _hitWalls(p, events) {
    const c = p.car;
    for (const w of this.walls) {
      if (w.owner === p.id || !this._overlaps(c, w.s, w.d, RULES.FIREWALL_HALF_L, RULES.FIREWALL_HALF_W)) continue;
      this.walls = this.walls.filter((x) => x !== w);
      const owner = this.players.get(w.owner);
      if (this._blockedByShield(p, events, owner, 'firewall')) { events.push({ type: 'wallGone', wall: w.id }); return; }
      this._spin(p, RULES.WALL_SPIN_SEC);
      if (owner) owner.stats.hits += 1;
      events.push({ type: 'wallHit', wall: w.id, id: p.id, by: w.owner, x: c.x, y: c.y });
      this._you(p);
      return;
    }
  }

  // ---------- questions ----------
  /** Race position (1-based) and field size, for the item odds. */
  _position(p) {
    const ranked = sim.rank([...this.players.values()]);
    return { pos: ranked.indexOf(p) + 1, n: ranked.length };
  }

  rollItem(p) {
    const { pos, n } = this._position(p);
    const odds = K.oddsAt(n <= 1 ? 0 : (pos - 1) / (n - 1));
    let total = 0;
    for (const k of K.ITEM_IDS) total += odds[k];
    let x = this.random() * total;
    for (const k of K.ITEM_IDS) { if (odds[k] <= 0) continue; x -= odds[k]; if (x < 0) return k; }
    return 'turbo';
  }

  _nextQuestion(p) {
    if (!p.deck.length) {
      p.deck = this.bank.map((_, i) => i);
      for (let i = p.deck.length - 1; i > 0; i--) { const j = Math.floor(this.random() * (i + 1)); [p.deck[i], p.deck[j]] = [p.deck[j], p.deck[i]]; }
    }
    return this.bank[p.deck.pop()];
  }

  _ask(p, box, events) {
    const q = this._nextQuestion(p);
    const order = [0, 1, 2, 3];
    for (let i = 3; i > 0; i--) { const j = Math.floor(this.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    p.q = {
      id: ++this.qSeq, prompt: q.prompt, code: q.code || '', options: order.map((k) => String(q.options[k])),
      answer: order.indexOf(q.answer), item: this.rollItem(p), endsAt: this._now() + RULES.QUESTION_SEC,
    };
    p.steer = 0;
    events.push({ type: 'pickup', id: p.id, box: box.i });
    this.out({ socket: p.socketId }, EV.QUESTION, this.questionView(p));
    this._you(p);
  }

  questionView(p) {
    if (!p.q) return null;
    return {
      id: p.q.id, prompt: p.q.prompt, code: p.q.code, options: p.q.options, item: p.q.item,
      endsIn: Math.max(0, Math.round((p.q.endsAt - this._now()) * 1000)), duration: RULES.QUESTION_SEC * 1000,
    };
  }

  /** Phone answer. Only the open question counts, once; anything else is ignored. */
  answer(playerId, data) {
    const p = this.players.get(playerId);
    if (!p) return fail('NO_PLAYER', 'Not in this race.');
    if (this.status !== STATUS.RACING) return fail('BAD_STATE', 'The race is not running.');
    const qid = Number(data && data.id);
    if (!p.q || qid !== p.q.id) return fail('LATE', 'That question is over.');
    const choice = Number(data && data.choice);
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) return fail('BAD_CHOICE', 'Pick one of the four answers.');
    const events = [];
    const res = this._settle(p, choice, events);
    this.pendingEvents.push(...events);
    return Object.assign({ ok: true }, res);
  }

  /** Close p's question: choice = 0..3, or null when the time ran out. */
  _settle(p, choice, events) {
    const q = p.q;
    p.q = null;
    let result;
    if (choice == null) {
      p.streak = 0;
      result = { kind: 'timeout', correct: null, answer: q.answer };
      events.push({ type: 'timeout', id: p.id });
    } else if (choice === q.answer) {
      p.streak += 1; p.stats.right += 1; p.stats.items += 1;
      p.item = q.item;
      result = { kind: 'right', correct: true, item: q.item, answer: q.answer };
      events.push({ type: 'gotItem', id: p.id, item: q.item });
      if (p.streak >= RULES.STREAK_TURBO) {
        p.streak = 0;
        this._turbo(p);
        result.streakTurbo = true;
        events.push({ type: 'streakTurbo', id: p.id });
      }
    } else {
      p.streak = 0; p.stats.wrong += 1;
      this._spin(p, RULES.SPIN_SEC);
      result = { kind: 'wrong', correct: false, answer: q.answer };
      events.push({ type: 'wrong', id: p.id });
    }
    result.qid = q.id;
    p.lastResult = result;
    this._you(p);
    return result;
  }

  // ---------- items ----------
  _spin(p, sec) {
    const c = p.car;
    c.spinT = Math.max(c.spinT, sec);
    c.boostT = 0;
    sim.setSlow(c, RULES.SPIN_FACTOR, sec);
    p.steer = 0;
  }

  _turbo(p) {
    const c = p.car;
    c.boostT = RULES.TURBO_SEC; c.boostF = RULES.TURBO_FACTOR;
    c.slowT = 0; c.slowF = 1;
    p.stats.turbos += 1;
  }

  /** A shield eats one hit. Returns true when the hit was blocked. */
  _blockedByShield(p, events, by, what) {
    if (!(p.car.shieldT > 0)) return false;
    p.car.shieldT = 0;
    p.stats.blocked += 1;
    events.push({ type: 'blocked', id: p.id, by: by ? by.id : null, what });
    this._you(p);
    return true;
  }

  /** The kart a Bug Bomb flies to: the one just ahead in the race, or just behind when you are leading. */
  bombTarget(p) {
    const active = sim.rank([...this.players.values()]).filter((x) => !x.car.finished && !x.car.dnf);
    const i = active.indexOf(p);
    if (i < 0) return null;
    return active[i - 1] || active[i + 1] || null;
  }

  useItem(playerId) {
    const p = this.players.get(playerId);
    if (!p) return fail('NO_PLAYER', 'Not in this race.');
    if (this.status !== STATUS.RACING) return fail('BAD_STATE', 'The race is not running.');
    if (!p.item) return fail('NO_ITEM', 'You have no item.');
    if (p.car.finished || p.car.dnf) return fail('DONE', 'You already finished.');
    if (p.car.spinT > 0) return fail('SPINNING', 'Wait until your kart stops spinning.');
    const item = p.item, c = p.car, events = [];
    p.item = null;
    if (item === 'turbo') {
      this._turbo(p);
      events.push({ type: 'turbo', id: p.id });
    } else if (item === 'shield') {
      c.shieldT = RULES.SHIELD_SEC;
      events.push({ type: 'shield', id: p.id });
    } else if (item === 'firewall') {
      const s = sim.wrapS(c.totalS - RULES.FIREWALL_BACK), pt = TRACK.pointAt(s, c.d);
      const w = { id: ++this.wallSeq, s, d: clamp(c.d, -TRACK.usable + 10, TRACK.usable - 10), owner: p.id, until: this._now() + RULES.FIREWALL_SEC, x: pt.x, y: pt.y, a: pt.a };
      this.walls.push(w);
      events.push({ type: 'wall', id: p.id, wall: w.id });
    } else if (item === 'bomb') {
      const t = this.bombTarget(p);
      if (!t) events.push({ type: 'bomb', id: p.id, target: null });
      else if (this._blockedByShield(t, events, p, 'bomb')) events.push({ type: 'bomb', id: p.id, target: t.id, blocked: true });
      else {
        this._spin(t, RULES.SPIN_SEC);
        p.stats.hits += 1;
        events.push({ type: 'bomb', id: p.id, target: t.id, x: t.car.x, y: t.car.y });
        this._you(t);
      }
    }
    this.pendingEvents.push(...events);
    this._you(p);
    return { ok: true, item };
  }

  // ---------- views ----------
  youView(p) {
    const { pos, n } = this._position(p);
    return {
      item: p.item, streak: p.streak, spin: p.car.spinT > 0, shield: p.car.shieldT > 0, boost: p.car.boostT > 0,
      question: this.questionView(p), lastResult: p.lastResult, pos, n,
    };
  }
  _you(p) { if (p.socketId && p.connected) this.out({ socket: p.socketId }, EV.YOU, this.youView(p)); }
  _sendAllYou() { for (const p of this.players.values()) this._you(p); }

  snapshot() {
    const s = super.snapshot();
    const now = this._now();
    for (const car of s.cars) {
      const p = this.players.get(car.id);
      car.spin = p.car.spinT > 0; car.shield = p.car.shieldT > 0; car.boost = p.car.boostT > 0;
      car.ask = !!p.q; car.item = p.item;
    }
    s.boxes = this.boxes.map((b) => (b.on ? 1 : 0));
    s.walls = this.walls.map((w) => ({ id: w.id, x: r1(w.x), y: r1(w.y), a: Math.round(w.a * 1000) / 1000, left: r1(Math.max(0, w.until - now)) }));
    return s;
  }

  leaderboard() {
    const b = super.leaderboard();
    for (const row of b.rows) {
      const p = this.players.get(row.id);
      row.item = p.item; row.ask = !!p.q; row.spin = p.car.spinT > 0; row.shield = p.car.shieldT > 0; row.boost = p.car.boostT > 0;
      row.streak = p.streak;
    }
    return b;
  }

  reconnectPlayer(key, socketId) {
    const r = super.reconnectPlayer(key, socketId);
    if (r.ok) r.you = this.youView(r.player);
    return r;
  }
}

class KartManager extends RoomManager {
  constructor({ bank = loadKartBank(), random } = {}) {
    super({ RoomClass: KartRoom, roomOptions: { bank, random } });
    this.bank = bank;
  }
  findByStation(sub) { for (const r of this.rooms.values()) if (r.station && r.station.sub === sub) return r; return null; }
}

module.exports = { KartRoom, KartManager, loadKartBank, EV };
