'use strict';
/**
 * GDG RACE - HTTP + Socket.IO entry point.
 * Env: PORT, NODE_ENV, PUBLIC_URL, HOST_SECRET (+ optional FORCE_HTTPS=1 behind a TLS proxy).
 */
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const G = require('../shared/game');
const { RoomManager } = require('./rooms');
const { EVT, CONFIG, STATUS } = G;

const PORT = Number(process.env.PORT) || 3000;
const PROD = process.env.NODE_ENV === 'production';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
let HOST_SECRET = process.env.HOST_SECRET || '';
if (!HOST_SECRET) {
  if (PROD) { console.error('HOST_SECRET must be set when NODE_ENV=production.'); process.exit(1); }
  HOST_SECRET = 'gdg-race';
  console.warn('[warn] HOST_SECRET not set - using the development key "gdg-race". Set HOST_SECRET before a real event.');
}
const secretHash = crypto.createHash('sha256').update(HOST_SECRET).digest();
function secretOk(s) {
  if (typeof s !== 'string' || s.length > 200) return false;
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(s).digest(), secretHash);
}
function tokenOk(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ---------- HTTP ----------
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (process.env.FORCE_HTTPS === '1' && req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
  }
  next();
});
const ROOT = path.join(__dirname, '..');
app.get('/healthz', (req, res) => res.json({ ok: true, rooms: rooms.rooms.size }));
app.get('/', (req, res) => res.redirect('/host'));
app.use('/shared', express.static(path.join(ROOT, 'shared')));
app.use('/vendor/phaser', express.static(path.join(ROOT, 'node_modules', 'phaser', 'dist')));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e5, pingInterval: 5000, pingTimeout: 8000,
  serveClient: true,
});

const rooms = new RoomManager();

// Fan room output out to the right Socket.IO channels.
rooms.on('out', (code, { target, event, data }) => {
  if (target === 'all') io.to('room:' + code).emit(event, data);
  else if (target === 'host') io.to('host:' + code).emit(event, data);
  else if (target === 'players') io.to('players:' + code).emit(event, data);
  else if (target && target.socket) io.to(target.socket).emit(event, data);
});

// ---------- helpers ----------
// Wi-Fi / Ethernet addresses first; virtual adapters (VirtualBox, WSL, Docker, VPN...) last.
function lanIPs() {
  const VIRTUAL = /vmware|virtual|vbox|docker|veth|vethernet|wsl|hyper-v|tailscale|zerotier|vpn|tun|tap|utun|bridge|br-/i;
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal || i.address.startsWith('169.254.')) continue;
      let rank = 5;
      if (i.address.startsWith('192.168.')) rank = 0;
      else if (i.address.startsWith('10.')) rank = 1;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(i.address)) rank = 2;
      if (VIRTUAL.test(name)) rank += 10;
      found.push({ rank, address: i.address, name });
    }
  }
  found.sort((a, b) => a.rank - b.rank);
  return found.map((f) => f.address);
}

/** Base URL that phones can reach. localhost is swapped for the machine's LAN address. */
function baseUrlFor(origin) {
  if (PUBLIC_URL) return PUBLIC_URL;
  try {
    const u = new URL(String(origin || ''));
    if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname)) {
      const ip = lanIPs()[0];
      if (ip) u.hostname = ip;
    }
    return u.origin;
  } catch (e) {
    return 'http://' + (lanIPs()[0] || 'localhost') + ':' + PORT;
  }
}

const reply = (cb, obj) => { if (typeof cb === 'function') cb(obj); };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// failed host-login throttle (per address)
const fails = new Map();
function throttled(addr) {
  const f = fails.get(addr);
  return f && f.until > Date.now() && f.n >= 5;
}
function noteFail(addr) {
  const f = fails.get(addr);
  if (!f || f.until < Date.now()) fails.set(addr, { n: 1, until: Date.now() + 60000 });
  else f.n += 1;
}

// token-bucket for steering (SEC-008)
function allowSteer(socket) {
  const now = Date.now();
  const b = socket.data.bucket || (socket.data.bucket = { tokens: CONFIG.RATE.STEER_BURST, at: now });
  b.tokens = Math.min(CONFIG.RATE.STEER_BURST, b.tokens + ((now - b.at) / 1000) * CONFIG.RATE.STEER_PER_SEC);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function bindHost(socket, room, extra) {
  socket.data.role = 'host';
  socket.data.code = room.code;
  socket.join('room:' + room.code);
  socket.join('host:' + room.code);
  room.setHostConnected(true);
  return QRCode.toDataURL(extra.joinUrl, { margin: 2, width: 520, errorCorrectionLevel: 'M' });
}

function hostRoom(socket) {
  if (socket.data.role !== 'host') return null;
  return rooms.get(socket.data.code);
}

// ---------- sockets ----------
io.on('connection', (socket) => {
  // ----- host: create a room or re-attach to the one it already owns
  socket.on(EVT.CREATE_ROOM, async (data, cb) => {
    try {
      if (!isObj(data)) return reply(cb, { ok: false, error: 'Bad request.' });
      const addr = socket.handshake.address;
      let room = null;

      if (typeof data.token === 'string' && typeof data.code === 'string') {
        const r = rooms.get(data.code);
        if (r && tokenOk(r.hostToken, data.token)) room = r;
      }
      if (!room) {
        if (throttled(addr)) return reply(cb, { ok: false, error: 'Too many attempts. Wait a minute.' });
        if (!secretOk(data.secret)) { noteFail(addr); return reply(cb, { ok: false, error: 'Wrong host key.', code: 'AUTH' }); }
        room = rooms.createRoom(isObj(data.settings) ? data.settings : null);
      }
      const joinUrl = baseUrlFor(data.origin) + '/play?room=' + room.code;
      const qr = await bindHost(socket, room, { joinUrl });
      reply(cb, { ok: true, token: room.hostToken, joinUrl, qr, room: room.info(), config: { cars: G.CARS } });
      socket.emit(EVT.ROOM_CREATED, { code: room.code, joinUrl });
      room.broadcastRoom();
    } catch (e) {
      console.error('create-room', e);
      reply(cb, { ok: false, error: 'Server error. Try again.' });
    }
  });

  // ----- host actions (authorised by the socket binding made above, SEC-005/006/012)
  const hostAction = (event, fn) => socket.on(event, (data, cb) => {
    try {
      const room = hostRoom(socket);
      if (!room) return reply(cb, { ok: false, error: 'Not authorised.' });
      reply(cb, fn(room, isObj(data) ? data : {}));
    } catch (e) {
      console.error(event, e);
      reply(cb, { ok: false, error: 'Server error.' });
    }
  });
  hostAction(EVT.START_COUNTDOWN, (r) => r.startCountdown());
  hostAction(EVT.CANCEL_COUNTDOWN, (r) => r.cancelCountdown());
  hostAction(EVT.PAUSE_RACE, (r) => r.pause());
  hostAction(EVT.RESUME_RACE, (r) => r.resume());
  hostAction(EVT.ABORT_RACE, (r) => r.abort());
  hostAction(EVT.NEW_ROUND, (r) => r.newRound());
  hostAction(EVT.RESET_SESSION, (r) => r.reset());
  hostAction(EVT.UPDATE_SETTINGS, (r, d) => r.updateSettings(d));
  hostAction(EVT.REMOVE_PLAYER, (r, d) => {
    const res = r.removePlayer(String(d.playerId || ''), 'removed');
    if (res.ok && res.socketId) {
      const s = io.sockets.sockets.get(res.socketId);
      if (s) { s.leave('room:' + r.code); s.leave('players:' + r.code); s.data.role = null; s.data.playerId = null; }
    }
    return { ok: res.ok, error: res.error };
  });

  // ----- player: look at a room before joining
  socket.on(EVT.ROOM_INFO, (data, cb) => {
    const room = isObj(data) ? rooms.get(data.code) : null;
    if (!room) return reply(cb, { ok: false, code: 'NO_ROOM', error: 'Room not found. Check the code or scan the QR again.' });
    reply(cb, room.joinInfo());
  });

  // ----- player: join
  socket.on(EVT.JOIN_ROOM, (data, cb) => {
    try {
      if (!isObj(data)) return reply(cb, { ok: false, error: 'Bad request.' });
      const room = rooms.get(data.code);
      if (!room) return reply(cb, { ok: false, code: 'NO_ROOM', error: 'Room not found. Check the code or scan the QR again.' });
      if (socket.data.role) return reply(cb, { ok: false, code: 'ALREADY', error: 'This device is already in a room.' });
      const res = room.addPlayer({ name: data.name, carId: data.carId, socketId: socket.id });
      if (!res.ok) return reply(cb, res);
      attachPlayer(socket, room, res.player);
      reply(cb, { ok: true, player: publicSelf(res.player), key: res.player.key, room: room.info() });
    } catch (e) {
      console.error('join-room', e);
      reply(cb, { ok: false, error: 'Server error.' });
    }
  });

  socket.on(EVT.RECONNECT_PLAYER, (data, cb) => {
    try {
      const room = isObj(data) ? rooms.get(data.code) : null;
      if (!room) return reply(cb, { ok: false, code: 'NO_ROOM', error: 'Room not found.' });
      const res = room.reconnectPlayer(data.key, socket.id);
      if (!res.ok) return reply(cb, res);
      if (res.previousSocketId && res.previousSocketId !== socket.id) {
        const old = io.sockets.sockets.get(res.previousSocketId);
        if (old) { old.data.role = null; old.data.playerId = null; old.emit(EVT.REPLACED, {}); old.leave('room:' + room.code); old.leave('players:' + room.code); }
      }
      attachPlayer(socket, room, res.player);
      reply(cb, { ok: true, player: publicSelf(res.player), room: room.info() });
    } catch (e) {
      console.error('reconnect-player', e);
      reply(cb, { ok: false, error: 'Server error.' });
    }
  });

  socket.on(EVT.SELECT_CAR, (data, cb) => {
    const room = playerRoom(socket);
    if (!room) return reply(cb, { ok: false, error: 'Not in a room.' });
    const res = room.selectCar(socket.data.playerId, isObj(data) ? data.carId : null);
    reply(cb, res);
  });

  socket.on(EVT.STEER, (data) => {
    const room = playerRoom(socket);
    if (!room || !isObj(data)) return;
    if (!allowSteer(socket)) return;
    room.steer(socket.data.playerId, data.dir);
  });

  socket.on('disconnect', () => {
    if (socket.data.role === 'host') {
      const room = rooms.get(socket.data.code);
      if (room) {
        // another host socket may already have re-attached; only mark gone if none is left
        const left = io.sockets.adapter.rooms.get('host:' + room.code);
        if (!left || left.size === 0) room.setHostConnected(false);
      }
    } else if (socket.data.role === 'player') {
      const room = rooms.get(socket.data.code);
      if (room) room.markDisconnected(socket.data.playerId, socket.id);
    }
  });
});

function publicSelf(p) {
  const car = G.CARS[p.carId - 1];
  return { id: p.id, name: p.name, carId: p.carId, color: car.color, carName: car.name };
}
function attachPlayer(socket, room, player) {
  socket.data.role = 'player';
  socket.data.code = room.code;
  socket.data.playerId = player.id;
  socket.join('room:' + room.code);
  socket.join('players:' + room.code);
  socket.emit(EVT.CONNECTION_STATUS, { connected: true, hostConnected: room.hostConnected });
}
function playerRoom(socket) {
  if (socket.data.role !== 'player') return null;
  const room = rooms.get(socket.data.code);
  if (!room || !room.players.has(socket.data.playerId)) return null; // SEC-012: membership check
  return room;
}

// ---------- main loop ----------
let last = process.hrtime.bigint();
setInterval(() => {
  const now = process.hrtime.bigint();
  const dt = Math.min(0.1, Number(now - last) / 1e9);
  last = now;
  try { rooms.tickAll(dt); } catch (e) { console.error('tick error', e); }
}, Math.round(1000 / CONFIG.SIM_HZ));
setInterval(() => rooms.cleanup(), 60000);

server.listen(PORT, () => {
  console.log('\n  GDG RACE: Code to Victory');
  console.log('  Host screen :  http://localhost:' + PORT + '/host');
  const ips = lanIPs();
  ips.forEach((ip, n) => console.log('  ' + (n === 0 ? 'On your Wi-Fi (used in QR)' : 'Other address           ') + ': http://' + ip + ':' + PORT + '/host'));
  if (!ips.length) console.log('  [warn] No network address found. Connect to Wi-Fi, or set PUBLIC_URL.');
  console.log('  Phone test  : open the first address above (replace /host with /play) in the phone browser.');
  if (PUBLIC_URL) console.log('  PUBLIC_URL  :  ' + PUBLIC_URL + '  (used in the QR code)');
  console.log('  Host key    :  ' + (process.env.HOST_SECRET ? '(from HOST_SECRET)' : HOST_SECRET + '  (dev default)') + '\n');
});

module.exports = { app, server, io, rooms };
