'use strict';
/**
 * AMONG BUGS - 5..10 players fix a spaceship; 1 secret Bug (2 from 9 players) tries to break it. Nobody is killed:
 * the big screen is public, so the game is about watching who fixes what. Server-authoritative and socket-free
 * (everything leaves through 'out'), unit tested with plain calls + tick(dt).
 *
 * Secrecy rules (checked by tests):
 *  - roles only go to that player's own socket (Bugs also learn the other Bug); public/host views never carry roles
 *    until the game is finished
 *  - task answers never leave the server
 *  - a faked fix and a real fix produce the same public event and the same room counter; the SHIP FIXED bar only
 *    syncs every SYNC_SEC, so a single fix can't be told apart by watching the bar
 *
 * Flow: lobby -> roles (secret reveal on phones) -> play <-> meeting -> verdict -> ... -> finished.
 *  play: pick a room (walking takes MOVE_SEC), then crew open a task there (multiple choice or fix-the-line); a right
 *  answer adds a real fix. Each player can fix a room ROOM_CAP times (fakes count against the same cap).
 *  The Bug can: fake a fix (busy for a few seconds, then the same "fixed!" pop, adds nothing), swap a line in its
 *  room (the next task there needs an extra step; cooldown), sabotage any room (alarm + countdown: SAB_NEED different
 *  players must solve a fix-it task in that room in time, or the Bugs win).
 *  Anyone still aboard can call a meeting (MEETINGS_EACH per player, not during a sabotage): vote on phones, most
 *  votes is thrown off (tie or skip = nobody), then the big screen shows whether they were a Bug.
 *  Crew win at 100% or when every Bug is thrown off; Bugs win if a sabotage runs out, crew <= bugs, or time runs out.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { sanitizeName } = require('../shared/game');
const { PartyManager, shuffle, fail, pickColor, colorHex } = require('./party');

const AMONG = {
  MIN_PLAYERS: 5,
  MAX_PLAYERS: 10,
  TWO_BUGS_AT: 9,
  ROLE_SEC: 7,
  MOVE_SEC: 3,
  TASK_SEC: 30,
  WRONG_LOCK_SEC: 3,
  FAKE_MIN: 5,
  FAKE_MAX: 10,
  SWAP_COOLDOWN: 30,
  SWAP_FIRST: 15,
  SAB_SEC: 45,
  SAB_COOLDOWN: 60,
  SAB_FIRST: 30,
  SAB_NEED: 2,
  MEETINGS_EACH: 1,
  MEETING_SEC: 60,
  VERDICT_SEC: 7,
  GAME_SEC: 480,
  FIXES_PER_CREW: 6,
  ROOM_CAP: 2,
  SYNC_SEC: 8,
  STATE_HZ: 5,
  LOBBY_GRACE_SEC: 60,
};
const ROOMS = [
  { id: 'bridge', name: 'Bridge', color: '#4285f4' },
  { id: 'lab', name: 'Lab', color: '#34a853' },
  { id: 'server', name: 'Server Room', color: '#ea4335' },
  { id: 'cafe', name: 'Cafeteria', color: '#fbbc04' },
  { id: 'engine', name: 'Engine', color: '#a142f4' },
];
const ROOM_IDS = ROOMS.map((r) => r.id);
const PHASE = { LOBBY: 'lobby', ROLES: 'roles', PLAY: 'play', MEETING: 'meeting', VERDICT: 'verdict', FINISHED: 'finished' };
const EV = {
  CREATE: 'among:create', START: 'among:start', PAUSE: 'among:pause', END: 'among:end', AGAIN: 'among:again',
  INFO: 'among:info', JOIN: 'among:join', RECONNECT: 'among:reconnect',
  MOVE: 'among:move', TASK: 'among:task', ANSWER: 'among:answer', FAKE: 'among:fake', SWAP: 'among:swap',
  SABOTAGE: 'among:sabotage', MEETING: 'among:meeting', VOTE: 'among:vote',
  STATE: 'among:state', YOU: 'among:you', FX: 'among:fx', FINAL: 'among:final', JOINED: 'among:joined',
  KICKED: 'among:kicked', REPLACED: 'among:replaced', STATION_CLOSED: 'station-closed',
};
const REASONS = ['I saw something sus', 'Someone faked a fix!', 'Who swapped the code?', 'Let\'s talk!'];

function loadAmongBank(file = path.join(__dirname, '..', 'data', 'among-tasks.json')) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = (Array.isArray(j) ? j : j.tasks).filter((q) => q && typeof q.prompt === 'string' && Array.isArray(q.options) &&
    ((q.kind === 'mc' && q.options.length === 4) || (q.kind === 'fix' && q.options.length === 3)) &&
    Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length);
  if (list.length < 20) throw new Error('Among Bugs needs at least 20 tasks');
  return list;
}

const r1 = (n) => Math.round(n * 10) / 10;

class AmongRoom extends EventEmitter {
  constructor({ code, bank, random = Math.random, config = {} }) {
    super();
    this.code = code;
    this.cfg = Object.assign({}, AMONG, config);
    this.bank = bank;
    this.random = random;
    this.station = null;
    this.hostConnected = true;
    this.players = new Map();
    this.byKey = new Map();
    this.clock = 0;
    this.lastActivity = Date.now();
    this.stateAcc = 0;
    this.lobbyAcc = 0;
    this.dirty = true;
    this.seq = 0;
    this.deck = [];
    this._reset();
  }

  out(target, event, data, volatile) { this.emit('out', { target, event, data, volatile: !!volatile }); }
  touch() { this.lastActivity = Date.now(); }

  _reset() {
    this.phase = PHASE.LOBBY;
    this.paused = false;
    this.phaseLeft = 0;
    this.timeLeft = this.cfg.GAME_SEC;
    this.rooms = {};
    for (const r of ROOMS) this.rooms[r.id] = { apparent: 0, swapped: false };
    this.realFixes = 0;
    this.shownFixes = 0;           // what the SHIP FIXED bar shows (synced every SYNC_SEC)
    this.syncAcc = 0;
    this.target = 0;
    this.sab = null;               // { room, left, fixers:Set, need }
    this.sabCd = 0;
    this.meeting = null;           // { by, reason, votes: Map(voterId -> targetId|'skip'), n }
    this.verdict = null;           // { id, name, wasBug, tally, skip }
    this.ejected = [];             // ids thrown off, in order
    this.meetingsHeld = 0;
    this.outcome = null;           // { winner: 'crew'|'bugs', reason }
    for (const p of this.players.values()) this._resetPlayer(p);
    this.dirty = true;
  }

  _resetPlayer(p) {
    p.role = null; p.ghost = false; p.spectator = false;
    p.room = null; p.walk = null; p.task = null; p.fake = null; p.lock = 0;
    p.meetingsLeft = this.cfg.MEETINGS_EACH; p.byRoom = {}; p.fixes = 0; p.swapCd = 0;
    p.lastResult = null;
  }

  // ---------- helpers ----------
  list() { return [...this.players.values()]; }
  inGame() { return this.list().filter((p) => !p.spectator); }
  aboard() { return this.inGame().filter((p) => !p.ghost); }
  bugs() { return this.inGame().filter((p) => p.role === 'bug'); }
  crewAboard() { return this.aboard().filter((p) => p.role === 'crew').length; }
  bugsAboard() { return this.aboard().filter((p) => p.role === 'bug').length; }
  connectedCount() { let n = 0; for (const p of this.players.values()) if (p.connected) n++; return n; }
  running() { return this.phase === PHASE.ROLES || this.phase === PHASE.PLAY || this.phase === PHASE.MEETING || this.phase === PHASE.VERDICT; }
  quota() { return Math.max(1, Math.ceil(this.target / ROOMS.length)); }
  sabNeed() { // never more fixers than there are crew (ghost crew help too)
    const crew = this.inGame().filter((p) => p.role === 'crew' && p.connected).length;
    return Math.max(1, Math.min(this.cfg.SAB_NEED, crew));
  }

  // ---------- views ----------
  /** Public view for the big screen and every phone. NEVER contains roles (until finished) or answers. */
  publicView() {
    const meeting = this.meeting;
    const v = {
      code: this.code, phase: this.phase, paused: this.paused,
      endsIn: (this.phase === PHASE.ROLES || this.phase === PHASE.MEETING || this.phase === PHASE.VERDICT) ? Math.max(0, Math.round(this.phaseLeft * 1000)) : 0,
      timeLeft: Math.max(0, Math.round(this.timeLeft * 1000)),
      players: this.list().map((p) => ({
        id: p.id, name: p.name, color: p.color, hex: colorHex(p.color), connected: p.connected, spectator: p.spectator,
        ghost: p.ghost, room: p.room, busy: !!(p.task || p.fake),
        walk: p.walk ? { from: p.walk.from, to: p.walk.to, ms: Math.round(p.walk.left * 1000) } : null,
        meetingsLeft: p.meetingsLeft,
      })),
      rooms: ROOMS.map((r) => ({ id: r.id, name: r.name, color: r.color, fixes: this.rooms[r.id].apparent, sabotaged: !!(this.sab && this.sab.room === r.id) })),
      quota: this.quota(),
      ship: this.target ? Math.min(100, Math.round(this.shownFixes / this.target * 100)) : 0,
      sabotage: this.sab ? { room: this.sab.room, ms: Math.round(this.sab.left * 1000), fixed: this.sab.fixers.size, need: this.sab.need } : null,
      bugCount: this.phase === PHASE.LOBBY ? (this.inGame().length >= this.cfg.TWO_BUGS_AT ? 2 : 1) : this.bugs().length,
      inGame: this.inGame().length, aboard: this.aboard().length,
      min: this.cfg.MIN_PLAYERS, max: this.cfg.MAX_PLAYERS, hostConnected: this.hostConnected,
      ejected: this.ejected.map((id) => { const p = this.players.get(id); return p ? { id, wasBug: p.role === 'bug' } : null; }).filter(Boolean),
    };
    if (meeting) {
      v.meeting = { by: meeting.by, reason: meeting.reason, voted: [...meeting.votes.keys()], voters: this.aboard().length };
    }
    if (this.verdict) v.verdict = this.verdict;
    if (this.phase === PHASE.FINISHED) {
      v.outcome = this.outcome;
      v.bugs = this.bugs().map((p) => p.id);   // the reveal: only once the game is over
      v.fixes = {};
      for (const p of this.inGame()) v.fixes[p.id] = p.fixes;
      v.meetings = this.meetingsHeld;
    }
    return v;
  }

  taskView(p) {
    const t = p.task;
    if (!t) return null;
    return { id: t.id, kind: t.kind, prompt: t.prompt, code: t.code, options: t.options, step: t.step, steps: t.steps, sab: t.sab, room: t.room,
      endsIn: Math.max(0, Math.round(t.left * 1000)), duration: this.cfg.TASK_SEC * 1000 };
  }

  /** Private view: sent only to p's own socket. */
  youView(p) {
    const v = {
      player: { id: p.id, name: p.name, color: p.color, hex: colorHex(p.color) },
      role: p.role, ghost: p.ghost, spectator: p.spectator,
      room: p.room, walk: p.walk ? { from: p.walk.from, to: p.walk.to, ms: Math.round(p.walk.left * 1000) } : null,
      task: this.taskView(p), lock: Math.round(p.lock * 1000), fixes: p.fixes, byRoom: p.byRoom, cap: this.cfg.ROOM_CAP,
      meetingsLeft: p.meetingsLeft, vote: this.meeting && this.meeting.votes.has(p.id) ? this.meeting.votes.get(p.id) : null,
      lastResult: p.lastResult, reasons: REASONS,
      state: this.publicView(),
    };
    if (p.role === 'bug') {
      v.allies = this.bugs().filter((b) => b.id !== p.id).map((b) => b.id);
      v.swapCd = Math.round(p.swapCd * 1000);
      v.sabCd = Math.round(this.sabCd * 1000);
      v.fake = p.fake ? { ms: Math.round(p.fake.left * 1000), room: p.fake.room } : null;
    }
    return v;
  }

  joinInfo() {
    if (this.players.size >= this.cfg.MAX_PLAYERS) return { ok: true, code: this.code, joinable: false, reason: 'The ship is full (10 players).' };
    return { ok: true, code: this.code, joinable: true, phase: this.phase, players: this.players.size };
  }

  _you(p) { if (p && p.socketId && p.connected) this.out({ socket: p.socketId }, EV.YOU, this.youView(p)); }
  _allYou() { for (const p of this.players.values()) this._you(p); }
  _flushNow() { this.dirty = false; this.stateAcc = 0; this.out('all', EV.STATE, this.publicView()); }

  // ---------- players ----------
  addPlayer({ name, socketId }) {
    const clean = sanitizeName(name);
    if (!clean) return fail('BAD_NAME', 'Please enter a name (letters and numbers).');
    if (this.players.size >= this.cfg.MAX_PLAYERS) return fail('ROOM_FULL', 'The ship is full (10 players).');
    for (const o of this.players.values()) if (o.name.toLowerCase() === clean.toLowerCase()) return fail('NAME_TAKEN', 'Someone already has that name. Try another one.');
    const p = {
      id: crypto.randomBytes(6).toString('hex'), key: crypto.randomBytes(16).toString('hex'),
      name: clean, color: pickColor(this.players), socketId: socketId || null, connected: true, discAt: null,
    };
    this._resetPlayer(p);
    p.spectator = this.phase !== PHASE.LOBBY && this.phase !== PHASE.FINISHED;
    this.players.set(p.id, p);
    this.byKey.set(p.key, p.id);
    this.touch(); this.dirty = true;
    this.out('host', EV.JOINED, { name: p.name, color: p.color });
    return { ok: true, player: p };
  }

  reconnectPlayer(key, socketId) {
    const id = typeof key === 'string' ? this.byKey.get(key) : null;
    const p = id ? this.players.get(id) : null;
    if (!p) return fail('NO_SESSION', 'Session not found. Join again.');
    const previous = p.socketId;
    p.socketId = socketId; p.connected = true; p.discAt = null;
    this.touch(); this.dirty = true;
    return { ok: true, player: p, previousSocketId: previous };
  }

  markDisconnected(playerId, socketId) {
    const p = this.players.get(playerId);
    if (!p || (socketId && p.socketId !== socketId)) return;
    p.connected = false; p.discAt = this.clock; this.dirty = true;
  }

  _drop(p) { this.players.delete(p.id); this.byKey.delete(p.key); }

  // ---------- host actions ----------
  start() {
    if (this.phase !== PHASE.LOBBY) return fail('BAD_STATE', 'The game has already started.');
    for (const p of [...this.players.values()]) if (!p.connected) this._drop(p);
    const n = this.players.size;
    if (n < this.cfg.MIN_PLAYERS) return fail('NO_PLAYERS', 'Among Bugs needs at least ' + this.cfg.MIN_PLAYERS + ' players.');
    this._reset();
    const ps = shuffle(this.list(), this.random);
    const nBugs = n >= this.cfg.TWO_BUGS_AT ? 2 : 1;
    ps.forEach((p, i) => { p.role = i < nBugs ? 'bug' : 'crew'; });
    // spread everyone over the rooms
    const order = shuffle(ROOM_IDS, this.random);
    shuffle(this.list(), this.random).forEach((p, i) => { p.room = order[i % order.length]; });
    this.target = this.cfg.FIXES_PER_CREW * (n - nBugs);
    this.sabCd = this.cfg.SAB_FIRST;
    for (const p of this.list()) p.swapCd = this.cfg.SWAP_FIRST;
    this.phase = PHASE.ROLES; this.phaseLeft = this.cfg.ROLE_SEC;
    this.touch();
    this._flushNow();
    this._allYou(); // each phone learns its own role here (and only its own)
    return { ok: true };
  }

  pause() {
    if (!this.running()) return fail('BAD_STATE', 'The game is not running.');
    this.paused = !this.paused;
    this._flushNow(); this._allYou();
    return { ok: true, paused: this.paused };
  }

  end() {
    if (this.phase === PHASE.LOBBY) return fail('BAD_STATE', 'The game has not started.');
    if (this.phase === PHASE.FINISHED) return fail('BAD_STATE', 'The game is already over.');
    this._finish(null, 'ended');
    return { ok: true };
  }

  again() {
    if (this.phase !== PHASE.FINISHED) return fail('BAD_STATE', 'Finish or end the game first.');
    for (const p of [...this.players.values()]) if (!p.connected) this._drop(p);
    this._reset();
    this.touch();
    this._flushNow(); this._allYou();
    return { ok: true };
  }

  setHostConnected(v) {
    this.hostConnected = v;
    if (!v && this.running() && !this.paused) { this.paused = true; this._flushNow(); this._allYou(); }
    this.dirty = true;
  }

  // ---------- player actions ----------
  _actor(playerId, { aboard = false, phase = PHASE.PLAY } = {}) {
    const p = this.players.get(playerId);
    if (!p) return { err: fail('NO_PLAYER', 'Not in this game.') };
    if (p.spectator) return { err: fail('SPECTATOR', 'You join the next game.') };
    if (this.phase !== phase) return { err: fail('BAD_STATE', phase === PHASE.MEETING ? 'No meeting right now.' : 'Not right now.') };
    if (this.paused) return { err: fail('PAUSED', 'The game is paused.') };
    if (aboard && p.ghost) return { err: fail('GHOST', 'You were thrown off the ship.') };
    return { p };
  }

  move(playerId, data) {
    const { p, err } = this._actor(playerId);
    if (err) return err;
    if (p.ghost && p.role === 'bug') return fail('GHOST', 'You were thrown off the ship.');
    const to = data && data.room;
    if (!ROOM_IDS.includes(to)) return fail('BAD_ROOM', 'Pick a room on the map.');
    if (p.walk) return fail('WALKING', 'You are already walking.');
    if (p.room === to) return fail('HERE', 'You are already there.');
    this._cancelWork(p);
    p.walk = { from: p.room, to, left: this.cfg.MOVE_SEC };
    p.room = null;
    this.touch(); this.dirty = true;
    this._you(p);
    return { ok: true, ms: this.cfg.MOVE_SEC * 1000 };
  }

  _cancelWork(p) {
    if (p.task) { p.task = null; this.dirty = true; }
    if (p.fake) { p.fake = null; this.dirty = true; }
  }

  _draw() {
    if (!this.deck.length) this.deck = shuffle(this.bank.map((_, i) => i), this.random);
    const q = this.bank[this.deck.pop()];
    const order = shuffle(q.options.map((_, i) => i), this.random);
    return { kind: q.kind, prompt: q.prompt, code: q.code || '', options: order.map((k) => String(q.options[k])), answer: order.indexOf(q.answer) };
  }

  /** Crew (also thrown-off crew, as ghosts) open a task in the room they are standing in. */
  openTask(playerId) {
    const { p, err } = this._actor(playerId);
    if (err) return err;
    if (p.role !== 'crew') return fail('NOT_CREW', 'Only crew can fix code.');
    if (p.walk || !p.room) return fail('WALKING', 'Wait until you reach the room.');
    if (p.task) return { ok: true, task: this.taskView(p) };
    if (p.lock > 0) return fail('LOCKED', 'Ouch! Try again in a moment.');
    const room = this.rooms[p.room];
    const sab = !!(this.sab && this.sab.room === p.room);
    if (sab && this.sab.fixers.has(p.id)) return fail('DONE', 'You already fixed your part. Someone else has to help!');
    if (!sab && (p.byRoom[p.room] || 0) >= this.cfg.ROOM_CAP) return fail('ROOM_DONE', 'You fixed everything you can here. Try another room.');
    const steps = room.swapped ? 2 : 1;
    room.swapped = false; // a swapped line hits the next task in the room, once
    p.task = Object.assign({ id: ++this.seq, step: 1, steps, sab, room: p.room, left: this.cfg.TASK_SEC }, this._draw());
    this.touch(); this.dirty = true;
    this._you(p);
    return { ok: true, task: this.taskView(p) };
  }

  answer(playerId, data) {
    const { p, err } = this._actor(playerId);
    if (err) return err;
    const t = p.task;
    const id = Number(data && data.id);
    if (!t || id !== t.id) return fail('LATE', 'That task is over.');
    const choice = Number(data && data.choice);
    if (!Number.isInteger(choice) || choice < 0 || choice >= t.options.length) return fail('BAD_CHOICE', 'Pick one of the answers.');
    this.touch();
    if (choice !== t.answer) {
      p.task = null; p.lock = this.cfg.WRONG_LOCK_SEC;
      p.lastResult = { id: t.id, correct: false };
      this.dirty = true; this._you(p);
      return { ok: true, correct: false, answer: t.answer };
    }
    if (t.step < t.steps) { // swapped line: one more step
      const next = this._draw();
      p.task = Object.assign({}, t, next, { id: ++this.seq, step: t.step + 1 });
      this._you(p);
      return { ok: true, correct: true, next: true, task: this.taskView(p) };
    }
    p.task = null;
    p.lastResult = { id: t.id, correct: true, sab: t.sab };
    if (t.sab && this.sab && this.sab.room === t.room) {
      this.sab.fixers.add(p.id);
      this._fixFx(p, t.room);
      if (this.sab.fixers.size >= this.sab.need) this._clearSabotage();
    } else {
      p.byRoom[t.room] = (p.byRoom[t.room] || 0) + 1;
      p.fixes += 1;
      this.realFixes += 1;
      this._fixFx(p, t.room);
      if (this.realFixes >= this.target) { this.shownFixes = this.realFixes; this._finish('crew', 'ship'); }
    }
    this.dirty = true;
    if (this.phase !== PHASE.FINISHED) this._you(p);
    return { ok: true, correct: true };
  }

  /** The public "fixed!" pop. Exactly the same for a real fix and a faked one. */
  _fixFx(p, room) {
    this.rooms[room].apparent += 1;
    this.out('all', EV.FX, { type: 'fix', id: p.id, room });
  }

  fakeFix(playerId) {
    const { p, err } = this._actor(playerId, { aboard: true });
    if (err) return err;
    if (p.role !== 'bug') return fail('NOT_BUG', 'Nice try.');
    if (p.walk || !p.room) return fail('WALKING', 'Wait until you reach the room.');
    if (p.fake) return fail('BUSY', 'You are already "fixing".');
    const sab = !!(this.sab && this.sab.room === p.room);
    if (!sab && (p.byRoom[p.room] || 0) >= this.cfg.ROOM_CAP) return fail('ROOM_DONE', 'Crew can\'t fix this room again either. Move on!');
    p.fake = { left: r1(this.cfg.FAKE_MIN + this.random() * (this.cfg.FAKE_MAX - this.cfg.FAKE_MIN)), room: p.room, sab };
    this.touch(); this.dirty = true;
    this._you(p);
    return { ok: true, ms: Math.round(p.fake.left * 1000) };
  }

  _finishFake(p) {
    const f = p.fake;
    p.fake = null;
    if (!f.sab) p.byRoom[f.room] = (p.byRoom[f.room] || 0) + 1; // same cap as crew, so it looks right
    this._fixFx(p, f.room); // looks exactly like a fix; adds nothing to the ship
    this.dirty = true;
    this._you(p);
  }

  swapLine(playerId) {
    const { p, err } = this._actor(playerId, { aboard: true });
    if (err) return err;
    if (p.role !== 'bug') return fail('NOT_BUG', 'Nice try.');
    if (p.walk || !p.room) return fail('WALKING', 'Wait until you reach the room.');
    if (p.swapCd > 0) return fail('COOLDOWN', 'Swap is not ready yet.');
    this.rooms[p.room].swapped = true;
    p.swapCd = this.cfg.SWAP_COOLDOWN;
    this.touch();
    this._you(p);
    return { ok: true, room: p.room };
  }

  sabotage(playerId, data) {
    const { p, err } = this._actor(playerId, { aboard: true });
    if (err) return err;
    if (p.role !== 'bug') return fail('NOT_BUG', 'Nice try.');
    const room = data && data.room;
    if (!ROOM_IDS.includes(room)) return fail('BAD_ROOM', 'Pick a room to sabotage.');
    if (this.sab) return fail('ACTIVE', 'A sabotage is already running.');
    if (this.sabCd > 0) return fail('COOLDOWN', 'Sabotage is not ready yet.');
    this.sab = { room, left: this.cfg.SAB_SEC, fixers: new Set(), need: this.sabNeed() };
    this.touch();
    this._flushNow();
    this._allYou();
    return { ok: true };
  }

  _clearSabotage() {
    this.sab = null;
    this.sabCd = this.cfg.SAB_COOLDOWN;
    this._flushNow();
    this._allYou();
  }

  callMeeting(playerId, data) {
    const { p, err } = this._actor(playerId, { aboard: true });
    if (err) return err;
    if (p.meetingsLeft <= 0) return fail('NO_MEETINGS', 'You already used your meeting.');
    if (this.sab) return fail('SABOTAGE', 'Fix the sabotage first!');
    const reason = REASONS.includes(data && data.reason) ? data.reason : '';
    p.meetingsLeft -= 1;
    for (const x of this.list()) {
      this._cancelWork(x);
      if (x.walk) { x.room = x.walk.to; x.walk = null; }
    }
    this.meeting = { by: p.id, reason, votes: new Map() };
    this.meetingsHeld += 1;
    this.verdict = null;
    this.phase = PHASE.MEETING; this.phaseLeft = this.cfg.MEETING_SEC;
    this.touch();
    this._flushNow();
    this._allYou();
    return { ok: true };
  }

  vote(playerId, data) {
    const { p, err } = this._actor(playerId, { aboard: true, phase: PHASE.MEETING });
    if (err) return err;
    if (this.meeting.votes.has(p.id)) return fail('DUPLICATE', 'You already voted.');
    const target = data && data.target;
    if (target !== 'skip') {
      const t = this.players.get(target);
      if (!t || t.spectator || t.ghost) return fail('BAD_TARGET', 'Vote for someone still on the ship, or skip.');
    }
    this.meeting.votes.set(p.id, target);
    this.touch(); this.dirty = true;
    this._you(p);
    if (this.meeting.votes.size >= this.aboard().length) this._tally();
    return { ok: true };
  }

  /** Most votes is thrown off; a tie (or skip winning / tying) throws nobody off. */
  tally() {
    const counts = new Map();
    let skip = 0;
    for (const t of this.meeting.votes.values()) {
      if (t === 'skip') skip += 1;
      else counts.set(t, (counts.get(t) || 0) + 1);
    }
    let bestN = 0;
    for (const n of counts.values()) bestN = Math.max(bestN, n);
    const leaders = [...counts].filter(([, n]) => n === bestN).map(([id]) => id);
    let out = null, tie = false;
    if (bestN > 0) {
      if (leaders.length > 1 || skip === bestN) tie = true;
      else if (skip < bestN) out = leaders[0];
    }
    const votes = {};
    for (const [voter, t] of this.meeting.votes) { (votes[t] = votes[t] || []).push(voter); }
    return { out, votes, skip, tie };
  }

  _tally() {
    const t = this.tally();
    let verdict = { id: null, name: null, wasBug: null, votes: t.votes, skip: t.skip, tie: t.tie };
    if (t.out) {
      const p = this.players.get(t.out);
      p.ghost = true; p.task = null; p.fake = null; p.walk = null;
      this.ejected.push(p.id);
      verdict = Object.assign(verdict, { id: p.id, name: p.name, wasBug: p.role === 'bug' });
    }
    this.verdict = verdict;
    this.phase = PHASE.VERDICT; this.phaseLeft = this.cfg.VERDICT_SEC;
    this._flushNow();
    this._allYou();
  }

  _afterVerdict() {
    this.meeting = null;
    if (this._checkWin()) return;
    this.verdict = null;
    this.phase = PHASE.PLAY;
    this._flushNow();
    this._allYou();
  }

  _checkWin() {
    if (this.bugsAboard() === 0) { this._finish('crew', 'voted'); return true; }
    if (this.crewAboard() <= this.bugsAboard()) { this._finish('bugs', 'outnumbered'); return true; }
    return false;
  }

  _finish(winner, reason) {
    this.outcome = { winner, reason };
    this.phase = PHASE.FINISHED; this.paused = false; this.phaseLeft = 0;
    this.shownFixes = this.realFixes; // the truth comes out at the end
    for (const p of this.list()) { p.task = null; p.fake = null; if (p.walk) { p.room = p.walk.to; p.walk = null; } }
    this.sab = null;
    this._flushNow();
    for (const p of this.inGame()) {
      if (!p.connected || !p.socketId) continue;
      this.out({ socket: p.socketId }, EV.FINAL, { winner, reason, role: p.role, won: !!winner && winner === (p.role === 'bug' ? 'bugs' : 'crew'), fixes: p.fixes });
    }
    this._allYou();
    this.touch();
  }

  // ---------- clock ----------
  tick(dt) {
    this.clock += dt;
    if (this.running() && !this.paused) this._run(dt);
    if (this.phase === PHASE.LOBBY) {
      this.lobbyAcc += dt;
      if (this.lobbyAcc >= 1) {
        this.lobbyAcc = 0;
        for (const p of [...this.players.values()]) {
          if (!p.connected && p.discAt != null && this.clock - p.discAt > this.cfg.LOBBY_GRACE_SEC) { this._drop(p); this.dirty = true; }
        }
      }
    }
    this.stateAcc += dt;
    if (this.stateAcc >= 1 / this.cfg.STATE_HZ) {
      this.stateAcc = 0;
      if (this.dirty) this._flushNow();
    }
  }

  _run(dt) {
    if (this.phase === PHASE.ROLES) {
      this.phaseLeft -= dt;
      if (this.phaseLeft <= 0) { this.phase = PHASE.PLAY; this._flushNow(); this._allYou(); }
      return;
    }
    if (this.phase === PHASE.MEETING) {
      this.phaseLeft -= dt;
      if (this.phaseLeft <= 0) this._tally();
      return;
    }
    if (this.phase === PHASE.VERDICT) {
      this.phaseLeft -= dt;
      if (this.phaseLeft <= 0) this._afterVerdict();
      return;
    }
    // PLAY
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) { this.timeLeft = 0; this._finish('bugs', 'time'); return; }
    if (this.sabCd > 0) this.sabCd = Math.max(0, this.sabCd - dt);
    if (this.sab) {
      this.sab.left -= dt;
      if (this.sab.left <= 0) { this._finish('bugs', 'sabotage'); return; }
    }
    for (const p of this.list()) {
      if (p.swapCd > 0) p.swapCd = Math.max(0, p.swapCd - dt);
      if (p.lock > 0) p.lock = Math.max(0, p.lock - dt);
      if (p.walk) {
        p.walk.left -= dt;
        if (p.walk.left <= 0) { p.room = p.walk.to; p.walk = null; this.dirty = true; this._you(p); }
      }
      if (p.task) {
        p.task.left -= dt;
        if (p.task.left <= 0) { p.task = null; p.lastResult = { correct: null }; this.dirty = true; this._you(p); }
      }
      if (p.fake) {
        p.fake.left -= dt;
        if (p.fake.left <= 0) this._finishFake(p);
      }
    }
    this.syncAcc += dt;
    if (this.syncAcc >= this.cfg.SYNC_SEC) { this.syncAcc = 0; if (this.shownFixes !== this.realFixes) { this.shownFixes = this.realFixes; this.dirty = true; } }
  }
}

class AmongManager extends PartyManager {
  constructor({ bank = loadAmongBank(), random } = {}) {
    super({ RoomClass: AmongRoom, roomOptions: { bank, random }, kickEvent: EV.KICKED });
    this.bank = bank;
  }
}

module.exports = { AMONG, ROOMS, PHASE, EV, REASONS, AmongRoom, AmongManager, loadAmongBank };
