'use strict';
/**
 * Room + RoomManager. Owns the race state machine (SRS 6.8), player rules (5.2/5.3),
 * results (5.7) and reconnection (12.1). No socket code in here: everything leaves through
 * the 'out' event, so the whole thing can be unit tested with plain function calls.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');
const G = require('../shared/game');
const sim = require('./sim');

const { CONFIG, STATUS, EVT, CARS, TRACK, sanitizeName, clamp } = G;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O to avoid confusion on a projector

const r1 = (n) => Math.round(n * 10) / 10;
const r3 = (n) => Math.round(n * 1000) / 1000;
const fail = (code, message) => ({ ok: false, code, error: message });

class Room extends EventEmitter {
  /**
   * cars / maxPlayers / defaults let other race-based games (Code Kart Battle) reuse this room with their own grid.
   */
  constructor({ id, code, hostToken, settings, cars, maxPlayers, defaults }) {
    super();
    this.cars = cars || CARS;
    this.id = id;
    this.code = code;
    this.hostToken = hostToken;
    this.hostConnected = true;
    this.status = STATUS.LOBBY;
    this.maxPlayers = maxPlayers || CONFIG.MAX_PLAYERS;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.settings = Object.assign({}, CONFIG.DEFAULTS, defaults || {});
    this.players = new Map();
    this.race = null;
    this.results = [];
    this.history = [];
    this.clock = 0;           // simulated seconds since the room was created
    this.cd = 0;              // countdown seconds left
    this.lastCdValue = null;
    this.pendingEvents = [];
    this.acc = { state: 0, board: 0 };
    this.raceCounter = 0;
    if (settings) this.updateSettings(settings);
  }

  // ---------- hooks (overridden by Code Kart Battle) ----------
  /** Put a player's car back on its grid slot. */
  _resetCar(p) { sim.resetCar(p.car, p.carId); }
  /** One physics step for every car; `events` collects what the big screen should animate. */
  _simStep(list, dt, events) { sim.step(list, this.race, this.settings, dt, events); }
  /** Extra fields for a player's row in the results. */
  _resultExtra() { return {}; }

  // ---------- output helpers ----------
  out(target, event, data) { this.emit('out', { target, event, data }); }
  touch() { this.lastActivity = Date.now(); }

  // ---------- public views ----------
  playerView(p) {
    const car = this.cars[p.carId - 1];
    return {
      id: p.id, name: p.name, carId: p.carId, color: car.color, carName: car.name,
      connected: p.connected, raceStatus: p.raceStatus, joinedAt: p.joinedAt,
    };
  }

  info() {
    return {
      code: this.code, status: this.status, maxPlayers: this.maxPlayers, settings: this.settings,
      hostConnected: this.hostConnected,
      players: [...this.players.values()].map((p) => this.playerView(p)),
      results: this.status === STATUS.FINISHED ? this.results : [],
    };
  }

  /** What a phone needs before joining (SRS 5.3: select from available cars). */
  joinInfo() {
    const taken = new Set([...this.players.values()].map((p) => p.carId));
    let joinable = true, reason = null;
    if (this.status !== STATUS.LOBBY) {
      joinable = false;
      reason = [STATUS.COUNTDOWN, STATUS.RACING, STATUS.PAUSED].includes(this.status)
        ? 'The race has already started. Wait for the next round.'
        : 'Results are on screen. Wait for the next round.';
    } else if (this.players.size >= this.maxPlayers) {
      joinable = false; reason = 'The room is full.';
    }
    return {
      ok: true, code: this.code, status: this.status, count: this.players.size, max: this.maxPlayers,
      joinable, reason, cars: this.cars.map((c) => ({ id: c.id, name: c.name, color: c.color, taken: taken.has(c.id) })),
    };
  }

  broadcastRoom() { this.out('all', EVT.ROOM_UPDATE, this.info()); }

  // ---------- players ----------
  addPlayer({ name, carId, socketId }) {
    const clean = sanitizeName(name);
    if (clean.length < CONFIG.NAME.MIN) return fail('BAD_NAME', 'Please enter a name (letters and numbers).');
    if (this.status !== STATUS.LOBBY) {
      return fail('RACE_STARTED', this.joinInfo().reason);
    }
    if (this.players.size >= this.maxPlayers) return fail('ROOM_FULL', 'The room is full.');
    const lower = clean.toLowerCase();
    for (const p of this.players.values()) {
      if (p.name.toLowerCase() === lower) return fail('NAME_TAKEN', 'That name is already used. Pick a different one.');
    }
    const taken = new Set([...this.players.values()].map((p) => p.carId));
    let chosen = null;
    if (carId != null) {
      const id = Number(carId);
      if (!Number.isInteger(id) || id < 1 || id > this.cars.length) return fail('BAD_CAR', 'Unknown car.');
      if (taken.has(id)) return fail('CAR_TAKEN', 'Someone just took that car. Pick another.');
      chosen = id;
    } else {
      chosen = this.cars.find((c) => !taken.has(c.id)).id;
    }
    const player = {
      id: crypto.randomBytes(6).toString('hex'),
      key: crypto.randomBytes(16).toString('hex'),
      name: clean, carId: chosen, connected: true, socketId: socketId || null,
      raceStatus: 'waiting', joinedAt: Date.now(), discAt: null,
      steer: 0, steerAt: 0, car: {},
    };
    this._resetCar(player);
    this.players.set(player.id, player);
    this.touch();
    this.out('host', EVT.PLAYER_JOINED, this.playerView(player));
    this.broadcastRoom();
    return { ok: true, player };
  }

  findByKey(key) {
    if (typeof key !== 'string') return null;
    for (const p of this.players.values()) if (p.key === key) return p;
    return null;
  }

  reconnectPlayer(key, socketId) {
    const p = this.findByKey(key);
    if (!p) return fail('NO_SESSION', 'Session not found. Join again.');
    const previous = p.socketId;
    p.socketId = socketId; p.connected = true; p.discAt = null; p.steer = 0;
    this.touch();
    this.out('host', EVT.PLAYER_JOINED, Object.assign(this.playerView(p), { reconnected: true }));
    this.broadcastRoom();
    return { ok: true, player: p, previousSocketId: previous };
  }

  markDisconnected(playerId, socketId) {
    const p = this.players.get(playerId);
    if (!p || (socketId && p.socketId !== socketId)) return;
    p.connected = false; p.steer = 0; p.discAt = this.clock;
    this.out('host', EVT.PLAYER_LEFT, { playerId: p.id, name: p.name, reason: 'disconnected' });
    this.broadcastRoom();
  }

  removePlayer(playerId, reason = 'removed') {
    const p = this.players.get(playerId);
    if (!p) return fail('NO_PLAYER', 'Player not found.');
    this.players.delete(playerId);
    this.out('host', EVT.PLAYER_LEFT, { playerId, name: p.name, reason });
    this.out({ socket: p.socketId }, EVT.KICKED, { reason });
    if (this.players.size === 0 && [STATUS.COUNTDOWN, STATUS.RACING, STATUS.PAUSED].includes(this.status)) {
      this._toLobby();
    } else {
      this.broadcastRoom();
    }
    return { ok: true, socketId: p.socketId };
  }

  selectCar(playerId, carId) {
    const p = this.players.get(playerId);
    if (!p) return fail('NO_PLAYER', 'Player not found.');
    if (this.status !== STATUS.LOBBY) return fail('BAD_STATE', 'Cars can only be changed in the lobby.');
    const id = Number(carId);
    if (!Number.isInteger(id) || id < 1 || id > this.cars.length) return fail('BAD_CAR', 'Unknown car.');
    for (const o of this.players.values()) if (o !== p && o.carId === id) return fail('CAR_TAKEN', 'That car is taken.');
    p.carId = id;
    this._resetCar(p);
    this.out('all', EVT.CAR_SELECTED, { playerId: p.id, carId: id, color: this.cars[id - 1].color });
    this.broadcastRoom();
    return { ok: true };
  }

  /** Steering input from a phone. Only -1 / 0 / 1 are ever accepted (SRS 11.1). */
  steer(playerId, dir) {
    const p = this.players.get(playerId);
    if (!p) return false;
    const d = Number(dir);
    if (d !== -1 && d !== 0 && d !== 1) return false;
    if (this.status !== STATUS.RACING) { p.steer = 0; return false; }
    p.steer = d; p.steerAt = this.clock;
    return true;
  }

  // ---------- settings ----------
  updateSettings(s) {
    if (this.status !== STATUS.LOBBY) return fail('BAD_STATE', 'Settings can only change in the lobby.');
    if (!s || typeof s !== 'object') return fail('BAD_INPUT', 'Invalid settings.');
    const L = CONFIG.LIMITS, cur = this.settings;
    if (s.laps != null) cur.laps = Math.round(clamp(Number(s.laps) || cur.laps, L.laps[0], L.laps[1]));
    if (s.collisionPenalty != null) {
      const v = Number(s.collisionPenalty);
      if (isFinite(v)) cur.collisionPenalty = clamp(v, L.collisionPenalty[0], L.collisionPenalty[1]);
    }
    if (s.raceTimeoutSec != null) {
      const v = Number(s.raceTimeoutSec);
      if (isFinite(v)) cur.raceTimeoutSec = Math.round(clamp(v, L.raceTimeoutSec[0], L.raceTimeoutSec[1]));
    }
    if (s.finishGraceSec != null) {
      const v = Number(s.finishGraceSec);
      if (isFinite(v)) cur.finishGraceSec = Math.round(clamp(v, L.finishGraceSec[0], L.finishGraceSec[1]));
    }
    if (s.obstacles != null) cur.obstacles = !!s.obstacles;
    this.broadcastRoom();
    return { ok: true, settings: cur };
  }

  // ---------- state machine (host actions) ----------
  startCountdown() {
    if (this.status !== STATUS.LOBBY) return fail('BAD_STATE', 'The race can only be started from the lobby.');
    const connected = [...this.players.values()].filter((p) => p.connected);
    if (connected.length === 0) return fail('NO_PLAYERS', 'Waiting for at least one player.');
    for (const p of this.players.values()) { this._resetCar(p); p.raceStatus = 'waiting'; p.steer = 0; }
    this.results = [];
    this.status = STATUS.COUNTDOWN;
    this.cd = CONFIG.COUNTDOWN_SECONDS;
    this.lastCdValue = null;
    this._emitCountdown();
    this.broadcastRoom();
    this.touch();
    return { ok: true };
  }

  cancelCountdown() {
    if (this.status !== STATUS.COUNTDOWN) return fail('BAD_STATE', 'No countdown is running.');
    this._toLobby();
    return { ok: true };
  }

  pause() {
    if (this.status !== STATUS.RACING) return fail('BAD_STATE', 'The race is not running.');
    this.status = STATUS.PAUSED;
    for (const p of this.players.values()) p.steer = 0;
    this.broadcastRoom();
    return { ok: true };
  }

  resume() {
    if (this.status !== STATUS.PAUSED) return fail('BAD_STATE', 'The race is not paused.');
    this.status = STATUS.RACING;
    this.broadcastRoom();
    return { ok: true };
  }

  abort() {
    if (![STATUS.COUNTDOWN, STATUS.RACING, STATUS.PAUSED].includes(this.status)) {
      return fail('BAD_STATE', 'There is no active race to abort.');
    }
    this.status = STATUS.ABORTED;
    this.race = null;
    for (const p of this.players.values()) { p.raceStatus = 'waiting'; p.steer = 0; }
    this.out('all', 'race-aborted', {});
    this.broadcastRoom();
    return { ok: true };
  }

  /** FR-011: Finished / Aborted -> Lobby, keeps players. */
  newRound() {
    if (![STATUS.FINISHED, STATUS.ABORTED].includes(this.status)) return fail('BAD_STATE', 'A round is still in progress.');
    this._toLobby();
    return { ok: true };
  }

  /** FR-010: from any state back to a clean lobby. Players that already left are dropped. */
  reset() {
    for (const p of [...this.players.values()]) if (!p.connected) this.players.delete(p.id);
    this._toLobby();
    return { ok: true };
  }

  setHostConnected(v) {
    this.hostConnected = v;
    if (!v) {
      if (this.status === STATUS.RACING) this.pause();          // SRS 12: pause or stop safely
      else if (this.status === STATUS.COUNTDOWN) this._toLobby();
    }
    this.out('all', EVT.CONNECTION_STATUS, { hostConnected: v });
    this.broadcastRoom();
  }

  _toLobby() {
    this.status = STATUS.LOBBY;
    this.race = null;
    this.results = [];
    this.lastCdValue = null;
    for (const p of this.players.values()) {
      p.raceStatus = 'waiting'; p.steer = 0;
      this._resetCar(p);
    }
    this.broadcastRoom();
    this.touch();
  }

  _emitCountdown() {
    const v = Math.ceil(this.cd);
    if (v === this.lastCdValue || v <= 0) return;
    this.lastCdValue = v;
    this.out('all', EVT.COUNTDOWN_UPDATE, {
      value: v, total: CONFIG.COUNTDOWN_SECONDS, serverTime: Date.now(), endsAt: Date.now() + this.cd * 1000,
    });
  }

  _startRace() {
    this.raceCounter += 1;
    this.race = {
      id: this.id + '-r' + this.raceCounter, startTime: Date.now(), time: 0,
      finishCount: 0, firstFinishAt: null, pairCooldown: new Map(),
    };
    for (const p of this.players.values()) { p.raceStatus = 'racing'; p.steer = 0; }
    this.status = STATUS.RACING;
    this.acc.state = 1; this.acc.board = 1; // flush an immediate update
    this.out('all', EVT.RACE_STARTED, {
      raceId: this.race.id, startTime: this.race.startTime, serverTime: Date.now(), totalLaps: this.settings.laps,
    });
    this.broadcastRoom();
  }

  _endRace(reason) {
    const list = [...this.players.values()];
    for (const p of list) {
      if (!p.car.finished) { p.car.dnf = true; p.raceStatus = 'dnf'; } else p.raceStatus = 'finished';
    }
    const ranked = sim.rank(list);
    this.results = ranked.map((p, i) => Object.assign({
      resultId: this.race.id + '-' + (i + 1), raceId: this.race.id, playerId: p.id, name: p.name,
      carId: p.carId, color: this.cars[p.carId - 1].color,
      finishPosition: i + 1,
      finishTime: p.car.finished ? r3(p.car.finishTime) : null,
      completedLaps: sim.completedLaps(p.car, this.settings.laps),
      resultStatus: p.car.finished ? 'Finished' : 'DNF',
    }, this._resultExtra(p)));
    this.history.push({ raceId: this.race.id, endedAt: Date.now(), reason, results: this.results });
    this.status = STATUS.FINISHED;
    this.out('all', EVT.RACE_FINISHED, { raceId: this.race.id, reason, results: this.results });
    this.broadcastRoom();
    this.out('all', EVT.LEADERBOARD_UPDATE, this.leaderboard());
    this.touch();
  }

  // ---------- per-tick update ----------
  tick(dt) {
    this.clock += dt;
    const s = this.status;

    if (s === STATUS.LOBBY) {
      for (const p of [...this.players.values()]) {
        if (!p.connected && p.discAt != null && this.clock - p.discAt > CONFIG.LOBBY_DISCONNECT_GRACE_SEC) {
          this.removePlayer(p.id, 'timeout');
        }
      }
    } else if (s === STATUS.COUNTDOWN) {
      this.cd -= dt;
      if (this.cd <= 0) this._startRace(); else this._emitCountdown();
    } else if (s === STATUS.RACING) {
      this._tickRace(dt);
    }

    if (this.status === STATUS.RACING || this.status === STATUS.PAUSED) {
      this.acc.board += dt;
      if (this.acc.board >= 1 / CONFIG.LEADERBOARD_HZ) {
        this.acc.board = 0;
        this.out('all', EVT.LEADERBOARD_UPDATE, this.leaderboard());
      }
    }

    this.acc.state += dt;
    const hz = this.status === STATUS.RACING ? CONFIG.BROADCAST_HZ : CONFIG.IDLE_BROADCAST_HZ;
    if (this.acc.state >= 1 / hz) {
      this.acc.state = 0;
      this.out('host', EVT.GAME_STATE, this.snapshot());
      this.pendingEvents = [];
    }
  }

  _tickRace(dt) {
    const list = [...this.players.values()];
    for (const p of list) { // phone went silent -> release the steering
      if (p.steer !== 0 && this.clock - p.steerAt > CONFIG.PHYS.STEER_TIMEOUT_SEC) p.steer = 0;
    }
    const events = [];
    this._simStep(list, dt, events);
    for (const e of events) {
      this.pendingEvents.push(e);
      if (e.type === 'finish') {
        const p = this.players.get(e.id);
        p.raceStatus = 'finished';
        this.out('all', EVT.PLAYER_FINISHED, { playerId: p.id, name: p.name, position: e.pos, time: r3(e.time) });
      }
    }
    const r = this.race;
    const unfinished = list.filter((p) => !p.car.finished);
    if (list.length === 0) { this._toLobby(); return; }
    if (unfinished.length === 0) return this._endRace('all-finished');
    if (r.time >= this.settings.raceTimeoutSec) return this._endRace('timeout');
    if (r.firstFinishAt != null && r.time - r.firstFinishAt >= this.settings.finishGraceSec) return this._endRace('grace');
  }

  // ---------- views for the wire ----------
  snapshot() {
    const list = [...this.players.values()];
    return {
      t: Date.now(), status: this.status,
      raceTime: this.race ? r1(this.race.time) : 0,
      laps: this.settings.laps,
      cars: list.map((p) => ({
        id: p.id, n: p.carId, x: r1(p.car.x), y: r1(p.car.y), a: r3(p.car.a),
        lap: Math.min(this.settings.laps, Math.max(0, Math.floor(Math.max(0, p.car.totalS) / TRACK.P)) + 1),
        spd: Math.round(p.car.speed), slow: p.car.slowT > 0, fin: p.car.finished, dnf: p.car.dnf, off: !p.connected,
      })),
      events: this.pendingEvents,
    };
  }

  leaderboard() {
    const list = [...this.players.values()];
    const ranked = sim.rank(list);
    return {
      status: this.status, laps: this.settings.laps, raceTime: this.race ? r1(this.race.time) : 0,
      rows: ranked.map((p, i) => ({
        pos: i + 1, id: p.id, name: p.name, carId: p.carId, color: this.cars[p.carId - 1].color,
        lap: Math.min(this.settings.laps, Math.max(0, Math.floor(Math.max(0, p.car.totalS) / TRACK.P)) + 1),
        progress: r3(clamp(p.car.totalS / (this.settings.laps * TRACK.P), 0, 1)),
        finished: p.car.finished, dnf: p.car.dnf, finishTime: p.car.finished ? r3(p.car.finishTime) : null,
        connected: p.connected,
      })),
    };
  }
}

class RoomManager extends EventEmitter {
  /** RoomClass / roomOptions: other race-based games plug in their own Room subclass. */
  constructor({ RoomClass = Room, roomOptions = {} } = {}) {
    super();
    this.RoomClass = RoomClass;
    this.roomOptions = roomOptions;
    this.rooms = new Map(); // code -> Room
  }

  _newCode() {
    for (let tries = 0; tries < 200; tries++) {
      let c = '';
      for (let i = 0; i < 4; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(c)) return c;
    }
    throw new Error('Could not allocate a room code');
  }

  createRoom(settings) {
    const code = this._newCode();
    const room = new this.RoomClass(Object.assign({}, this.roomOptions, {
      id: crypto.randomBytes(5).toString('hex'), code,
      hostToken: crypto.randomBytes(24).toString('hex'), settings,
    }));
    room.on('out', (msg) => this.emit('out', code, msg));
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    if (typeof code !== 'string') return null;
    return this.rooms.get(code.trim().toUpperCase()) || null;
  }

  destroy(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    room.out('all', EVT.KICKED, { reason: 'room-closed' });
    room.removeAllListeners();
    this.rooms.delete(code);
  }

  tickAll(dt) {
    for (const room of this.rooms.values()) room.tick(dt);
  }

  /** Drop rooms nobody has touched for a long time (host gone, event over). */
  cleanup(now = Date.now(), maxIdleMs = 3 * 60 * 60 * 1000) {
    for (const [code, room] of this.rooms) {
      if (now - room.lastActivity > maxIdleMs && !room.hostConnected) this.destroy(code);
    }
  }
}

module.exports = { Room, RoomManager };
