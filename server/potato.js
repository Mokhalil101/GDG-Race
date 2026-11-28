'use strict';
/**
 * HOT POTATO CODE - 4..12 players sit in a circle on the big screen and pass a bomb by answering quick questions.
 * Server-authoritative and socket-free (everything leaves through 'out'), unit tested with plain calls + tick(dt).
 *
 * Round: intro ("round N, get ready") -> live -> boom -> next round ... -> finished (last one standing).
 *  - the holder's phone gets a quick true/false or 2-choice question (the answer never leaves the server)
 *  - right -> the bomb flies (FLIGHT_SEC, fuse paused) to a random other player who is still in
 *  - wrong -> the fuse loses WRONG_BURN_SEC and the holder gets a new question
 *  - the fuse is a hidden random FUSE_MIN..FUSE_MAX seconds per round and only burns while someone holds the bomb.
 *    The big screen never gets the seconds, only a coarse "stage" (0 fresh .. 3 about to blow); only the holder's
 *    own phone sees its seconds.
 *  - when it blows the holder is out; the last player in wins.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { sanitizeName } = require('../shared/game');
const { PartyManager, shuffle, fail, pickColor, colorHex } = require('./party');

const POTATO = {
  MIN_PLAYERS: 4,
  MAX_PLAYERS: 12,
  FUSE_MIN: 6,
  FUSE_MAX: 15,
  WRONG_BURN_SEC: 2,
  FLIGHT_SEC: 1.1,
  INTRO_SEC: 3,
  BOOM_SEC: 4,
  STATE_HZ: 5,
  FEED: 4,
  LOBBY_GRACE_SEC: 60,
};
const PHASE = { LOBBY: 'lobby', INTRO: 'intro', LIVE: 'live', BOOM: 'boom', FINISHED: 'finished' };
const EV = {
  CREATE: 'potato:create', START: 'potato:start', PAUSE: 'potato:pause', END: 'potato:end', AGAIN: 'potato:again',
  INFO: 'potato:info', JOIN: 'potato:join', RECONNECT: 'potato:reconnect', ANSWER: 'potato:answer',
  STATE: 'potato:state', YOU: 'potato:you', FINAL: 'potato:final', JOINED: 'potato:joined',
  KICKED: 'potato:kicked', REPLACED: 'potato:replaced', STATION_CLOSED: 'station-closed',
};

function loadPotatoBank(file = path.join(__dirname, '..', 'data', 'potato-questions.json')) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = (Array.isArray(j) ? j : j.questions).filter((q) => q && typeof q.prompt === 'string' && (
    (q.kind === 'tf' && typeof q.answer === 'boolean') ||
    (q.kind === 'pick' && Array.isArray(q.options) && q.options.length === 2 && (q.answer === 0 || q.answer === 1))));
  if (list.length < 20) throw new Error('Hot Potato Code needs at least 20 questions');
  return list;
}

class PotatoRoom extends EventEmitter {
  constructor({ code, bank, random = Math.random, config = {} }) {
    super();
    this.code = code;
    this.cfg = Object.assign({}, POTATO, config);
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
    this.qSeq = 0;
    this.deck = [];
    this._reset();
  }

  out(target, event, data, volatile) { this.emit('out', { target, event, data, volatile: !!volatile }); }
  touch() { this.lastActivity = Date.now(); }

  _reset() {
    this.phase = PHASE.LOBBY;
    this.paused = false;
    this.round = 0;
    this.phaseLeft = 0;
    this.fuse = 0; this.fuseMax = 0;      // private: never in a public view
    this.holderId = null;
    this.flight = null;                    // { from, to, left }
    this.q = null;                         // the holder's open question (with the answer)
    this.holdSince = 0;
    this.feed = [];
    this.outOrder = [];
    this.winnerId = null;
    this.outcome = null;
    for (const p of this.players.values()) {
      p.out = false; p.outRound = 0; p.spectator = false; p.passes = 0; p.wrong = 0; p.lastResult = null;
    }
    this.dirty = true;
  }

  // ---------- helpers ----------
  inGame(p) { return !p.spectator; }
  alive() { return [...this.players.values()].filter((p) => !p.spectator && !p.out); }
  connectedCount() { let n = 0; for (const p of this.players.values()) if (p.connected) n++; return n; }
  running() { return this.phase === PHASE.INTRO || this.phase === PHASE.LIVE || this.phase === PHASE.BOOM; }

  /** Coarse fuse stage for the big screen: 0 fresh, 1 sparking, 2 hissing, 3 about to blow. Never the seconds. */
  stage() {
    if (!this.fuseMax) return 0;
    const f = this.fuse / this.fuseMax;
    return f > 0.66 ? 0 : f > 0.4 ? 1 : f > 0.18 ? 2 : 3;
  }

  // ---------- views ----------
  publicView() {
    const v = {
      code: this.code, phase: this.phase, paused: this.paused, round: this.round,
      endsIn: (this.phase === PHASE.INTRO || this.phase === PHASE.BOOM) ? Math.max(0, Math.round(this.phaseLeft * 1000)) : 0,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, color: p.color, hex: colorHex(p.color), out: p.out, outRound: p.outRound, spectator: p.spectator, connected: p.connected,
      })),
      holder: this.holderId, stage: this.running() ? this.stage() : 0,
      flight: this.flight ? { from: this.flight.from, to: this.flight.to, ms: Math.round(this.flight.left * 1000) } : null,
      alive: this.alive().length, inGame: [...this.players.values()].filter((p) => !p.spectator).length,
      feed: this.feed, min: this.cfg.MIN_PLAYERS, max: this.cfg.MAX_PLAYERS, hostConnected: this.hostConnected,
    };
    if (this.phase === PHASE.FINISHED) {
      v.outcome = this.outcome;
      v.winner = this.winnerId;
      v.ranking = this.ranking().map((p) => p.id);
    }
    return v;
  }

  youView(p) {
    const holding = this.phase === PHASE.LIVE && this.holderId === p.id && !this.flight;
    return {
      player: { id: p.id, name: p.name, color: p.color, hex: colorHex(p.color) },
      out: p.out, spectator: p.spectator, holding,
      incoming: !!(this.flight && this.flight.to === p.id),
      question: holding && this.q ? { id: this.q.id, kind: this.q.kind, prompt: this.q.prompt, code: this.q.code, options: this.q.options } : null,
      fuseLeft: holding ? Math.max(0, Math.round(this.fuse * 1000)) : null,
      fuseCap: this.cfg.FUSE_MAX * 1000,
      passes: p.passes, lastResult: p.lastResult,
      state: this.publicView(),
    };
  }

  joinInfo() {
    if (this.players.size >= this.cfg.MAX_PLAYERS) return { ok: true, code: this.code, joinable: false, reason: 'This game is full (12 players).' };
    return { ok: true, code: this.code, joinable: true, phase: this.phase, players: this.players.size };
  }

  _you(p) { if (p && p.socketId && p.connected) this.out({ socket: p.socketId }, EV.YOU, this.youView(p)); }
  _allYou() { for (const p of this.players.values()) this._you(p); }
  /** Push the public state now (phase changes) instead of waiting for the throttled flush. */
  _flushNow() { this.dirty = false; this.stateAcc = 0; this.out('all', EV.STATE, this.publicView()); }

  _feed(item) {
    this.feed.unshift(Object.assign({ t: Math.round(this.clock * 10) / 10 }, item));
    if (this.feed.length > this.cfg.FEED) this.feed.length = this.cfg.FEED;
  }

  // ---------- players ----------
  addPlayer({ name, socketId }) {
    const clean = sanitizeName(name);
    if (!clean) return fail('BAD_NAME', 'Please enter a name (letters and numbers).');
    if (this.players.size >= this.cfg.MAX_PLAYERS) return fail('ROOM_FULL', 'This game is full (12 players).');
    for (const o of this.players.values()) if (o.name.toLowerCase() === clean.toLowerCase()) return fail('NAME_TAKEN', 'Someone already has that name. Try another one.');
    const p = {
      id: crypto.randomBytes(6).toString('hex'), key: crypto.randomBytes(16).toString('hex'),
      name: clean, color: pickColor(this.players), socketId: socketId || null, connected: true, discAt: null,
      out: false, outRound: 0, spectator: this.phase !== PHASE.LOBBY && this.phase !== PHASE.FINISHED,
      passes: 0, wrong: 0, lastResult: null,
    };
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

  // ---------- questions ----------
  _draw() {
    if (!this.deck.length) this.deck = shuffle(this.bank.map((_, i) => i), this.random);
    const q = this.bank[this.deck.pop()];
    if (q.kind === 'tf') return { kind: 'tf', prompt: q.prompt, code: q.code || '', options: ['TRUE', 'FALSE'], answer: q.answer ? 0 : 1 };
    const order = shuffle([0, 1], this.random);
    return { kind: 'pick', prompt: q.prompt, code: q.code || '', options: order.map((k) => String(q.options[k])), answer: order.indexOf(q.answer) };
  }

  _ask(p) {
    this.q = Object.assign({ id: ++this.qSeq }, this._draw());
    this._you(p);
  }

  // ---------- host actions ----------
  start() {
    if (this.phase !== PHASE.LOBBY) return fail('BAD_STATE', 'The game has already started.');
    for (const p of [...this.players.values()]) if (!p.connected) this._drop(p);
    if (this.players.size < this.cfg.MIN_PLAYERS) return fail('NO_PLAYERS', 'Hot Potato needs at least ' + this.cfg.MIN_PLAYERS + ' players.');
    this._reset();
    this.touch();
    this._nextRound();
    return { ok: true };
  }

  pause() {
    if (!this.running()) return fail('BAD_STATE', 'The game is not running.');
    this.paused = !this.paused;
    this._flushNow();
    this._allYou();
    return { ok: true, paused: this.paused };
  }

  end() {
    if (this.phase === PHASE.LOBBY) return fail('BAD_STATE', 'The game has not started.');
    if (this.phase === PHASE.FINISHED) return fail('BAD_STATE', 'The game is already over.');
    this._finish('ended');
    return { ok: true };
  }

  again() {
    if (this.phase !== PHASE.FINISHED) return fail('BAD_STATE', 'Finish or end the game first.');
    for (const p of [...this.players.values()]) if (!p.connected) this._drop(p);
    this._reset();
    this.touch();
    this._flushNow();
    this._allYou();
    return { ok: true };
  }

  setHostConnected(v) {
    this.hostConnected = v;
    if (!v && this.running() && !this.paused) { this.paused = true; this._flushNow(); this._allYou(); }
    this.dirty = true;
  }

  // ---------- rounds ----------
  _pickHolder(exceptId) {
    const alive = this.alive().filter((p) => p.id !== exceptId);
    const online = alive.filter((p) => p.connected);
    const pool = online.length ? online : alive;
    return pool.length ? pool[Math.floor(this.random() * pool.length)] : null;
  }

  _nextRound() {
    this.round += 1;
    this.phase = PHASE.INTRO; this.phaseLeft = this.cfg.INTRO_SEC; this.paused = false;
    this.fuseMax = Math.round((this.cfg.FUSE_MIN + this.random() * (this.cfg.FUSE_MAX - this.cfg.FUSE_MIN)) * 10) / 10;
    this.fuse = this.fuseMax;
    this.flight = null; this.q = null;
    const h = this._pickHolder(null);
    this.holderId = h ? h.id : null;
    this._flushNow();
    this._allYou();
  }

  _goLive() {
    this.phase = PHASE.LIVE; this.phaseLeft = 0;
    const h = this.players.get(this.holderId);
    this.holdSince = this.clock;
    if (h) this.q = Object.assign({ id: ++this.qSeq }, this._draw());
    this._flushNow();
    this._allYou();
  }

  _land() {
    const to = this.players.get(this.flight.to);
    const from = this.players.get(this.flight.from);
    this.flight = null;
    this.holderId = to ? to.id : null;
    this.holdSince = this.clock;
    this.dirty = true;
    if (from) this._you(from);
    if (to) this._ask(to); else this._boom();
  }

  _boom() {
    const p = this.players.get(this.holderId);
    this.q = null; this.flight = null;
    if (p) {
      p.out = true; p.outRound = this.round;
      this.outOrder.push(p.id);
      this._feed({ type: 'boom', name: p.name, id: p.id });
    }
    this.phase = PHASE.BOOM; this.phaseLeft = this.cfg.BOOM_SEC;
    this.fuse = 0;
    this._flushNow();
    this._allYou();
  }

  _afterBoom() {
    if (this.alive().length <= 1) this._finish('winner');
    else this._nextRound();
  }

  /** Out order reversed: the winner first, then whoever lasted longest. Spectators are not ranked. */
  ranking() {
    const alive = this.alive();
    const outs = this.outOrder.slice().reverse().map((id) => this.players.get(id)).filter(Boolean);
    return [...alive, ...outs];
  }

  _finish(outcome) {
    const alive = this.alive();
    this.winnerId = alive.length === 1 ? alive[0].id : null;
    this.outcome = this.winnerId ? 'winner' : outcome;
    this.phase = PHASE.FINISHED; this.paused = false; this.phaseLeft = 0;
    this.q = null; this.flight = null; this.holderId = null; this.fuse = 0;
    this._flushNow();
    const ranked = this.ranking();
    const total = ranked.length;
    ranked.forEach((p, i) => {
      if (!p.connected || !p.socketId) return;
      this.out({ socket: p.socketId }, EV.FINAL, {
        outcome: this.outcome, place: i + 1, total, winner: this.winnerId === p.id, alive: !p.out, passes: p.passes,
        winnerName: this.winnerId ? this.players.get(this.winnerId).name : null,
      });
    });
    this._allYou();
    this.touch();
  }

  // ---------- answers ----------
  answer(playerId, data) {
    const p = this.players.get(playerId);
    if (!p) return fail('NO_PLAYER', 'Not in this game.');
    if (this.phase !== PHASE.LIVE) return fail('NOT_OPEN', 'No bomb in play right now.');
    if (this.paused) return fail('PAUSED', 'The game is paused.');
    if (this.holderId !== p.id || this.flight) return fail('NOT_HOLDER', 'You do not have the bomb.');
    const qid = Number(data && data.id);
    if (!this.q || qid !== this.q.id) return fail('LATE', 'That question is over.');
    const choice = Number(data && data.choice);
    if (!Number.isInteger(choice) || (choice !== 0 && choice !== 1)) return fail('BAD_CHOICE', 'Pick one of the two answers.');
    const q = this.q;
    this.q = null; // one answer per question
    this.touch(); this.dirty = true;
    if (choice === q.answer) {
      const to = this._pickHolder(p.id);
      const sec = Math.round((this.clock - this.holdSince) * 10) / 10;
      p.passes += 1;
      p.lastResult = { qid: q.id, correct: true };
      if (!to) { this._you(p); return { ok: true, correct: true }; }
      this.flight = { from: p.id, to: to.id, left: this.cfg.FLIGHT_SEC };
      this.holderId = to.id;
      this._feed({ type: 'pass', name: p.name, id: p.id, to: to.name, toId: to.id, sec });
      this._flushNow();
      this._you(p); this._you(to);
      return { ok: true, correct: true, to: to.name };
    }
    p.wrong += 1;
    p.lastResult = { qid: q.id, correct: false, answer: q.answer };
    this.fuse -= this.cfg.WRONG_BURN_SEC;
    this._feed({ type: 'wrong', name: p.name, id: p.id });
    if (this.fuse <= 0) { this._boom(); return { ok: true, correct: false, answer: q.answer, boom: true }; }
    this.dirty = true;
    this._ask(p);
    return { ok: true, correct: false, answer: q.answer };
  }

  // ---------- clock ----------
  tick(dt) {
    this.clock += dt;
    if (this.running() && !this.paused) {
      const before = this.stage();
      if (this.phase === PHASE.INTRO) {
        this.phaseLeft -= dt;
        if (this.phaseLeft <= 0) this._goLive();
      } else if (this.phase === PHASE.LIVE) {
        if (this.flight) {
          this.flight.left -= dt;
          if (this.flight.left <= 0) this._land();
        } else {
          this.fuse -= dt;
          if (this.fuse <= 0) this._boom();
        }
      } else if (this.phase === PHASE.BOOM) {
        this.phaseLeft -= dt;
        if (this.phaseLeft <= 0) this._afterBoom();
      }
      if (this.phase === PHASE.LIVE && this.stage() !== before) this.dirty = true;
    }
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
    const period = 1 / this.cfg.STATE_HZ;
    if (this.stateAcc >= period) {
      this.stateAcc = 0;
      if (this.dirty) this._flushNow();
    }
  }
}

class PotatoManager extends PartyManager {
  constructor({ bank = loadPotatoBank(), random } = {}) {
    super({ RoomClass: PotatoRoom, roomOptions: { bank, random }, kickEvent: EV.KICKED });
    this.bank = bank;
  }
}

module.exports = { POTATO, PHASE, EV, PotatoRoom, PotatoManager, loadPotatoBank };
