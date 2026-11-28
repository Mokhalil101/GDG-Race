'use strict';
/**
 * BOSS RAID - the whole hall fights one boss. Server-authoritative and socket-free (everything leaves through the
 * 'out' event), so it can be unit tested with plain calls + tick(dt).
 *
 * Flow: lobby -> intro (short "get ready") -> [question -> reveal] x ROUNDS -> finished (victory | defeat).
 * Damage = BASE x speed (1..2, faster = harder) x combo (streak of right answers in a row) [x2 for the round's first hit].
 * Boss HP = HP_PER_PLAYER x connected players at the start (late joiners add a share for the rounds that are left).
 * Built for 300+ phones in one room: per-answer work is O(1); the host gets one aggregated state ~4x/s plus a
 * batch of hit effects (volatile); phones only get phase changes and their own result.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { sanitizeName } = require('../shared/game');

const RAID = {
  ROUNDS: 8,
  INTRO_SEC: 4,
  QUESTION_SEC: 20,
  REVEAL_SEC: 6,
  BASE_DAMAGE: 100,
  COMBO_CAP: 8,
  FIRST_HIT_CRIT: 2,
  HP_PER_PLAYER: 1000,
  MIN_HP: 3000,
  MAX_PLAYERS: 600,
  STATE_HZ: 4,
  MAX_HITS_PER_BATCH: 14,
  LOBBY_GRACE_SEC: 60,
  TOP_N: 5,
};
const TEAMS = [
  { id: 0, name: 'Blue', color: '#4285F4' },
  { id: 1, name: 'Red', color: '#EA4335' },
  { id: 2, name: 'Yellow', color: '#FBBC04' },
  { id: 3, name: 'Green', color: '#34A853' },
];
const PHASE = { LOBBY: 'lobby', INTRO: 'intro', QUESTION: 'question', REVEAL: 'reveal', FINISHED: 'finished' };
const EV = {
  CREATE: 'raid:create', START: 'raid:start', NEXT: 'raid:next', PAUSE: 'raid:pause', END: 'raid:end', AGAIN: 'raid:again',
  INFO: 'raid:info', JOIN: 'raid:join', RECONNECT: 'raid:reconnect', ANSWER: 'raid:answer',
  STATE: 'raid:state', HITS: 'raid:hits', PHASE: 'raid:phase', YOU: 'raid:you', RESULT: 'raid:result', FINAL: 'raid:final',
  JOINED: 'raid:joined', KICKED: 'raid:kicked', REPLACED: 'raid:replaced', STATION_CLOSED: 'station-closed',
};

const fail = (code, error) => ({ ok: false, code, error });
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function loadBank(file = path.join(__dirname, '..', 'data', 'raid-questions.json')) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = (Array.isArray(j) ? j : j.questions).filter((q) =>
    q && typeof q.prompt === 'string' && Array.isArray(q.options) && q.options.length === 4 &&
    Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4);
  if (list.length < RAID.ROUNDS) throw new Error('Boss Raid question bank needs at least ' + RAID.ROUNDS + ' questions');
  return list;
}

class RaidRoom extends EventEmitter {
  constructor({ code, bank, random = Math.random, config = {} }) {
    super();
    this.code = code;
    this.cfg = Object.assign({}, RAID, config);
    this.bank = bank;
    this.random = random;
    this.station = null;          // set by the server (station binding)
    this.hostConnected = true;
    this.players = new Map();     // id -> player
    this.byKey = new Map();       // reconnect key -> id
    this.clock = 0;
    this.lastActivity = Date.now();
    this.stateAcc = 0;
    this.lobbyAcc = 0;
    this.dirty = true;
    this.hitBuffer = [];
    this._resetRaid();
  }

  out(target, event, data, volatile) { this.emit('out', { target, event, data, volatile: !!volatile }); }
  touch() { this.lastActivity = Date.now(); }

  _resetRaid() {
    this.phase = PHASE.LOBBY;
    this.paused = false;
    this.round = 0;               // 1-based while playing
    this.phaseLeft = 0;           // seconds left in intro / question / reveal
    this.questions = [];
    this.current = null;          // { prompt, code, options, answer, level }
    this.hp = 0; this.maxHp = 0;
    this.answered = 0; this.correctThisRound = 0;
    this.roundDamage = 0;
    this.firstHit = false;
    this.outcome = null; this.finalHit = null;
    this.teamDamage = [0, 0, 0, 0];
    this.history = [];            // per round: { round, correct, answered, damage }
    for (const p of this.players.values()) {
      p.damage = 0; p.hits = 0; p.combo = 0; p.bestCombo = 0; p.answeredRound = 0; p.lastResult = null;
    }
    this.dirty = true;
  }

  // ---------- views ----------
  teamCounts() {
    const c = [0, 0, 0, 0];
    for (const p of this.players.values()) if (p.connected) c[p.team] += 1;
    return c;
  }
  connectedCount() { let n = 0; for (const p of this.players.values()) if (p.connected) n++; return n; }

  topHitters(n = this.cfg.TOP_N) {
    const top = [];
    for (const p of this.players.values()) {
      if (p.damage <= 0) continue;
      if (top.length < n || p.damage > top[top.length - 1].damage) {
        top.push(p); top.sort((a, b) => b.damage - a.damage || b.bestCombo - a.bestCombo);
        if (top.length > n) top.pop();
      }
    }
    return top.map((p) => ({ id: p.id, name: p.name, team: p.team, damage: p.damage, combo: p.bestCombo }));
  }

  publicQuestion() {
    if (!this.current) return null;
    return { prompt: this.current.prompt, code: this.current.code, options: this.current.options };
  }

  phaseView() {
    const v = {
      phase: this.phase, paused: this.paused, round: this.round, rounds: this.cfg.ROUNDS,
      endsIn: Math.max(0, Math.round(this.phaseLeft * 1000)), duration: this._phaseDuration() * 1000,
    };
    if (this.phase === PHASE.QUESTION || this.phase === PHASE.REVEAL) v.question = this.publicQuestion();
    if (this.phase === PHASE.REVEAL) v.correct = this.current.answer;
    if (this.phase === PHASE.FINISHED) { v.outcome = this.outcome; v.finalHit = this.finalHit; v.topTeam = this.topTeam(); }
    return v;
  }

  state() {
    return Object.assign(this.phaseView(), {
      code: this.code, hp: Math.max(0, Math.round(this.hp)), maxHp: this.maxHp,
      players: this.connectedCount(), total: this.players.size, answered: this.answered,
      teams: TEAMS.map((t, i) => ({ id: i, damage: Math.round(this.teamDamage[i]) })), teamCounts: this.teamCounts(),
      top: this.topHitters(), hostConnected: this.hostConnected,
      roundDamage: Math.round(this.roundDamage), correctThisRound: this.correctThisRound,
    });
  }

  topTeam() {
    let best = 0;
    for (let i = 1; i < 4; i++) if (this.teamDamage[i] > this.teamDamage[best]) best = i;
    return this.teamDamage[best] > 0 ? best : null;
  }

  youView(p) {
    return {
      player: { id: p.id, name: p.name, team: p.team, teamName: TEAMS[p.team].name, color: TEAMS[p.team].color },
      hits: p.hits, damage: Math.round(p.damage), combo: p.combo, answeredRound: p.answeredRound,
      answeredThis: p.answeredRound === this.round && this.round > 0, lastResult: p.lastResult,
      phase: this.phaseView(),
    };
  }

  joinInfo() {
    if (this.players.size >= this.cfg.MAX_PLAYERS) return { ok: true, code: this.code, joinable: false, reason: 'The raid is full.' };
    return { ok: true, code: this.code, joinable: true, phase: this.phase, players: this.connectedCount() };
  }

  _phaseDuration() {
    if (this.phase === PHASE.INTRO) return this.cfg.INTRO_SEC;
    if (this.phase === PHASE.QUESTION) return this.cfg.QUESTION_SEC;
    if (this.phase === PHASE.REVEAL) return this.cfg.REVEAL_SEC;
    return 0;
  }

  _broadcastPhase() {
    this.out('all', EV.PHASE, this.phaseView());
    this.dirty = true; this.stateAcc = 1; // flush host state on the next tick
  }

  // ---------- players ----------
  _pickTeam() {
    const c = [0, 0, 0, 0];
    for (const p of this.players.values()) c[p.team] += 1;
    let best = 0;
    for (let i = 1; i < 4; i++) if (c[i] < c[best]) best = i;
    return best;
  }

  addPlayer({ name, socketId }) {
    const clean = sanitizeName(name);
    if (!clean) return fail('BAD_NAME', 'Please enter a name (letters and numbers).');
    if (this.players.size >= this.cfg.MAX_PLAYERS) return fail('ROOM_FULL', 'The raid is full.');
    const p = {
      id: crypto.randomBytes(6).toString('hex'), key: crypto.randomBytes(16).toString('hex'),
      name: clean, team: this._pickTeam(), socketId: socketId || null, connected: true, discAt: null,
      damage: 0, hits: 0, combo: 0, bestCombo: 0, answeredRound: 0, lastResult: null,
    };
    this.players.set(p.id, p);
    this.byKey.set(p.key, p.id);
    // late joiner: the boss gets tougher by this player's share of the rounds that are left
    if (this.phase !== PHASE.LOBBY && this.phase !== PHASE.FINISHED) {
      const done = this.phase === PHASE.REVEAL ? this.round : Math.max(0, this.round - 1);
      const extra = Math.round(this.cfg.HP_PER_PLAYER * (this.cfg.ROUNDS - done) / this.cfg.ROUNDS);
      this.hp += extra; this.maxHp += extra;
    }
    this.touch(); this.dirty = true;
    this.out('host', EV.JOINED, { name: p.name, team: p.team });
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

  // ---------- answers ----------
  answer(playerId, data) {
    const p = this.players.get(playerId);
    if (!p) return fail('NO_PLAYER', 'Not in this raid.');
    if (this.phase !== PHASE.QUESTION) return fail('NOT_OPEN', 'No question is open.');
    if (this.paused) return fail('PAUSED', 'The raid is paused.');
    const round = Number(data && data.round);
    if (round !== this.round) return fail('LATE', 'That question is over.');
    if (p.answeredRound === this.round) return fail('DUPLICATE', 'You already answered.');
    const choice = Number(data && data.choice);
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) return fail('BAD_CHOICE', 'Pick one of the four answers.');

    p.answeredRound = this.round;
    this.answered += 1;
    this.dirty = true;
    if (choice !== this.current.answer) {
      p.combo = 0;
      p.lastResult = { round: this.round, correct: false, damage: 0, combo: 0 };
      return { ok: true };
    }
    p.combo = Math.min(this.cfg.COMBO_CAP, p.combo + 1);
    p.bestCombo = Math.max(p.bestCombo, p.combo);
    const speed = 1 + Math.max(0, Math.min(1, this.phaseLeft / this.cfg.QUESTION_SEC));
    const crit = !this.firstHit;
    this.firstHit = true;
    const dmg = Math.round(this.cfg.BASE_DAMAGE * speed * p.combo * (crit ? this.cfg.FIRST_HIT_CRIT : 1));
    p.hits += 1; p.damage += dmg;
    p.lastResult = { round: this.round, correct: true, damage: dmg, combo: p.combo, crit };
    this.correctThisRound += 1;
    this.roundDamage += dmg;
    this.teamDamage[p.team] += dmg;
    this.hp -= dmg;
    this._queueHit({ team: p.team, damage: dmg, combo: p.combo, crit, name: p.name });
    if (this.hp <= 0) {
      this.hp = 0;
      this.finalHit = { name: p.name, team: p.team, id: p.id };
      this._finish('victory');
    }
    return { ok: true };
  }

  _queueHit(h) {
    const buf = this.hitBuffer;
    if (buf.length < this.cfg.MAX_HITS_PER_BATCH) { buf.push(h); return; }
    // keep the biggest hits for the screen; the rest only count in the totals
    let min = 0;
    for (let i = 1; i < buf.length; i++) if (buf[i].damage < buf[min].damage) min = i;
    if (h.damage > buf[min].damage) buf[min] = h;
  }

  // ---------- host actions ----------
  start() {
    if (this.phase !== PHASE.LOBBY) return fail('BAD_STATE', 'The raid has already started.');
    const n = this.connectedCount();
    if (n === 0) return fail('NO_PLAYERS', 'Waiting for at least one player.');
    // forget players that left the lobby
    for (const p of [...this.players.values()]) if (!p.connected) this._drop(p);
    this.maxHp = Math.max(this.cfg.MIN_HP, n * this.cfg.HP_PER_PLAYER);
    this.hp = this.maxHp;
    this.questions = this._pickQuestions();
    this.phase = PHASE.INTRO; this.phaseLeft = this.cfg.INTRO_SEC; this.paused = false;
    this.touch();
    this._broadcastPhase();
    return { ok: true };
  }

  next() {
    if (this.phase === PHASE.INTRO) this._openQuestion(1);
    else if (this.phase === PHASE.QUESTION) this._reveal();
    else if (this.phase === PHASE.REVEAL) this._afterReveal();
    else return fail('BAD_STATE', 'Nothing to skip right now.');
    this.touch();
    return { ok: true };
  }

  pause() {
    if (![PHASE.INTRO, PHASE.QUESTION, PHASE.REVEAL].includes(this.phase)) return fail('BAD_STATE', 'The raid is not running.');
    this.paused = !this.paused;
    this._broadcastPhase();
    return { ok: true, paused: this.paused };
  }

  end() {
    if (this.phase === PHASE.LOBBY) return fail('BAD_STATE', 'The raid has not started.');
    if (this.phase === PHASE.FINISHED) return fail('BAD_STATE', 'The raid is already over.');
    this._finish(this.hp <= 0 ? 'victory' : 'defeat');
    return { ok: true };
  }

  again() {
    if (this.phase !== PHASE.FINISHED) return fail('BAD_STATE', 'Finish or end the raid first.');
    for (const p of [...this.players.values()]) if (!p.connected) this._drop(p);
    this._resetRaid();
    this._broadcastPhase();
    for (const p of this.players.values()) this.out({ socket: p.socketId }, EV.YOU, this.youView(p));
    return { ok: true };
  }

  setHostConnected(v) {
    this.hostConnected = v;
    if (!v && this.phase === PHASE.QUESTION && !this.paused) { this.paused = true; this._broadcastPhase(); }
    this.dirty = true;
  }

  _drop(p) { this.players.delete(p.id); this.byKey.delete(p.key); }

  _pickQuestions() {
    const pool = this.bank.slice();
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(this.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    // easy first, then harder
    const picked = pool.slice(0, this.cfg.ROUNDS);
    const rank = { easy: 0, medium: 1, hard: 2 };
    picked.sort((a, b) => (rank[a.level] || 0) - (rank[b.level] || 0));
    return picked;
  }

  _openQuestion(n) {
    const q = this.questions[n - 1];
    // shuffle the four options; only the server knows where the right one went
    const order = [0, 1, 2, 3];
    for (let i = 3; i > 0; i--) { const j = Math.floor(this.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    this.current = { prompt: q.prompt, code: q.code || '', options: order.map((k) => String(q.options[k])), answer: order.indexOf(q.answer), level: q.level };
    this.round = n;
    this.phase = PHASE.QUESTION; this.phaseLeft = this.cfg.QUESTION_SEC;
    this.answered = 0; this.correctThisRound = 0; this.roundDamage = 0; this.firstHit = false;
    this._broadcastPhase();
  }

  _reveal() {
    for (const p of this.players.values()) {
      if (p.answeredRound !== this.round) { p.combo = 0; p.lastResult = { round: this.round, correct: null, damage: 0, combo: 0 }; }
    }
    this.history.push({ round: this.round, correct: this.correctThisRound, answered: this.answered, damage: Math.round(this.roundDamage) });
    this.phase = PHASE.REVEAL; this.phaseLeft = this.cfg.REVEAL_SEC;
    this._broadcastPhase();
    this._sendResults();
  }

  _sendResults() {
    for (const p of this.players.values()) {
      if (!p.connected || !p.socketId) continue;
      this.out({ socket: p.socketId }, EV.RESULT, {
        round: this.round, result: p.lastResult, hits: p.hits, damage: Math.round(p.damage), combo: p.combo,
      });
    }
  }

  _afterReveal() {
    if (this.round >= this.cfg.ROUNDS) this._finish(this.hp <= 0 ? 'victory' : 'defeat');
    else this._openQuestion(this.round + 1);
  }

  _finish(outcome) {
    if (this.phase === PHASE.QUESTION && outcome === 'victory') {
      // the killing blow ends the round: settle streaks and tell everyone how their last answer went
      this.history.push({ round: this.round, correct: this.correctThisRound, answered: this.answered, damage: Math.round(this.roundDamage) });
    }
    this.phase = PHASE.FINISHED; this.outcome = outcome; this.paused = false; this.phaseLeft = 0;
    this._flushHits();
    this._broadcastPhase();
    const ranked = [...this.players.values()].sort((a, b) => b.damage - a.damage);
    const total = ranked.length;
    ranked.forEach((p, i) => {
      if (!p.connected || !p.socketId) return;
      this.out({ socket: p.socketId }, EV.FINAL, {
        outcome, rank: i + 1, total, hits: p.hits, damage: Math.round(p.damage), bestCombo: p.bestCombo,
        team: p.team, topTeam: this.topTeam(), finalHit: this.finalHit && this.finalHit.id === p.id, result: p.lastResult,
      });
    });
    this.touch();
  }

  _flushHits() {
    if (!this.hitBuffer.length) return;
    this.out('host', EV.HITS, this.hitBuffer, true);
    this.hitBuffer = [];
  }

  // ---------- clock ----------
  tick(dt) {
    this.clock += dt;
    if (!this.paused && (this.phase === PHASE.INTRO || this.phase === PHASE.QUESTION || this.phase === PHASE.REVEAL)) {
      this.phaseLeft -= dt;
      if (this.phase === PHASE.QUESTION && this.answered > 0 && this.answered >= this.connectedCount()) {
        this.phaseLeft = Math.min(this.phaseLeft, 0); // everyone answered: close the question
      }
      if (this.phaseLeft <= 0) {
        if (this.phase === PHASE.INTRO) this._openQuestion(1);
        else if (this.phase === PHASE.QUESTION) this._reveal();
        else this._afterReveal();
      }
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
      this.stateAcc = this.stateAcc >= 2 * period ? 0 : this.stateAcc - period;
      this._flushHits();
      const running = this.phase === PHASE.INTRO || this.phase === PHASE.QUESTION || this.phase === PHASE.REVEAL;
      if (this.dirty || running) { this.dirty = false; this.out('host', EV.STATE, this.state()); }
    }
  }
}

class RaidManager extends EventEmitter {
  constructor({ bank = loadBank(), random } = {}) {
    super();
    this.bank = bank;
    this.random = random;
    this.rooms = new Map();
  }
  _newCode() {
    for (let tries = 0; tries < 200; tries++) {
      let c = '';
      for (let i = 0; i < 4; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(c)) return c;
    }
    throw new Error('Could not allocate a room code');
  }
  createRoom(opts = {}) {
    const code = this._newCode();
    const room = new RaidRoom({ code, bank: this.bank, random: this.random, config: opts.config });
    room.on('out', (msg) => this.emit('out', code, msg));
    this.rooms.set(code, room);
    return room;
  }
  get(code) { return typeof code === 'string' ? this.rooms.get(code.trim().toUpperCase()) || null : null; }
  findByStation(sub) { for (const r of this.rooms.values()) if (r.station && r.station.sub === sub) return r; return null; }
  destroy(code, reason = 'room-closed') {
    const room = this.rooms.get(code);
    if (!room) return;
    room.out('all', EV.KICKED, { reason });
    room.removeAllListeners();
    this.rooms.delete(code);
  }
  tickAll(dt) { for (const r of this.rooms.values()) r.tick(dt); }
  cleanup(now = Date.now(), maxIdleMs = 3 * 60 * 60 * 1000) {
    for (const [code, r] of this.rooms) if (now - r.lastActivity > maxIdleMs && !r.hostConnected) this.destroy(code);
  }
}

module.exports = { RAID, TEAMS, PHASE, EV, RaidRoom, RaidManager, loadBank };
