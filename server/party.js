'use strict';
/**
 * Shared plumbing for the small "party" games (Hot Potato Code, Among Bugs): a room manager with 4-letter codes,
 * station lookup, destroy (kicks phones), tick and idle cleanup. Rooms are socket-free EventEmitters that send
 * everything through an 'out' event ({ target: 'all'|'host'|'players'|{socket}, event, data, volatile }).
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const fail = (code, error) => ({ ok: false, code, error });

/** Fisher-Yates with an injectable random (tests use a seeded one). */
function shuffle(list, random = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Player colours (bean / face colours on the big screen). Order = join order. */
const COLORS = [
  { id: 'red', hex: '#ea4335' }, { id: 'blue', hex: '#4285f4' }, { id: 'green', hex: '#34a853' }, { id: 'yellow', hex: '#fbbc04' },
  { id: 'purple', hex: '#a142f4' }, { id: 'pink', hex: '#ff8fb1' }, { id: 'orange', hex: '#ff7043' }, { id: 'cyan', hex: '#00bcd4' },
  { id: 'lime', hex: '#9ccc65' }, { id: 'brown', hex: '#a1887f' }, { id: 'white', hex: '#f5f5f5' }, { id: 'navy', hex: '#3f51b5' },
];
function pickColor(players) {
  const used = new Set([...players.values()].map((p) => p.color));
  const c = COLORS.find((x) => !used.has(x.id));
  return c ? c.id : COLORS[players.size % COLORS.length].id;
}
const colorHex = (id) => (COLORS.find((c) => c.id === id) || COLORS[0]).hex;

class PartyManager extends EventEmitter {
  /** @param {{ RoomClass: Function, roomOptions?: object, kickEvent: string }} o */
  constructor({ RoomClass, roomOptions = {}, kickEvent }) {
    super();
    this.RoomClass = RoomClass;
    this.roomOptions = roomOptions;
    this.kickEvent = kickEvent;
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
    const room = new this.RoomClass(Object.assign({ code }, this.roomOptions, opts));
    room.on('out', (msg) => this.emit('out', code, msg));
    this.rooms.set(code, room);
    return room;
  }
  get(code) { return typeof code === 'string' ? this.rooms.get(code.trim().toUpperCase()) || null : null; }
  findByStation(sub) { for (const r of this.rooms.values()) if (r.station && r.station.sub === sub) return r; return null; }
  destroy(code, reason = 'room-closed') {
    const room = this.rooms.get(code);
    if (!room) return;
    room.out('all', this.kickEvent, { reason });
    if (room.dispose) room.dispose();
    room.removeAllListeners();
    this.rooms.delete(code);
  }
  tickAll(dt) { for (const r of this.rooms.values()) r.tick(dt); }
  cleanup(now = Date.now(), maxIdleMs = 3 * 60 * 60 * 1000) {
    for (const [code, r] of this.rooms) if (now - r.lastActivity > maxIdleMs && !r.hostConnected) this.destroy(code);
  }
}

module.exports = { PartyManager, shuffle, fail, COLORS, pickColor, colorHex };
