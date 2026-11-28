'use strict';
/**
 * GDG Games server: HTTP + Socket.IO, everything mounted under BASE_PATH (default /games).
 *  - /games/launch?t=<station token>  -> cookie + redirect to the game (see server/station.js and the contract)
 *  - /games/race/ , /games/raid/ , /games/kart/ , /games/potato/ , /games/among/ -> big screens (need a station cookie for that game)
 *  - /games/<game>/play -> phones (no cookie; they can only join rooms a station created)
 *  - /games/code-man/ , /games/codebreaker/ -> the static builds, behind the same gate
 *  - Socket.IO at /games/socket.io: "/" = GDG Race, "/raid" = Boss Raid, "/kart" = Code Kart Battle,
 *    "/potato" = Hot Potato Code, "/among" = Among Bugs
 * createGamesServer() does not listen and never exits the process, so tests can build one per case.
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
const { RaidManager, EV: REV, TEAMS } = require('./raid');
const { KartManager, EV: KEV } = require('./kart');
const { PotatoManager, EV: PEV } = require('./potato');
const { AmongManager, EV: AEV } = require('./among');
const station = require('./station');
const { renderHoldOn } = require('./holdon');
const { EVT, CONFIG } = G;

const ROOT = path.join(__dirname, '..');
const PLAYABLE = { race: true, raid: true, kart: true, potato: true, among: true, 'code-man': true, codebreaker: true };
// never served from the static game folders
const MANIFEST_FILES = /^\/(manifest\.webmanifest|manifest\.json|assets\/icons\/[\w.-]+\.(png|svg|ico|webp))$/;
const STATIC_DENY = /(^|\/)(\.|node_modules(\/|$)|tests?(\/|$)|tools(\/|$)|package(-lock)?\.json$|README|TESTING|.*\.md$|.*\.py$)/i;

function normBase(b) {
  if (b == null) return '/games';
  b = String(b).trim().replace(/\/+$/, '');
  if (b && !b.startsWith('/')) b = '/' + b;
  return b;
}

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

/**
 * @param {object} o
 *  basePath, port, production, publicUrl, stationKey, platformApiUrl, hostSecret (dev only), signInUrl,
 *  codeManDir, codeBreakerDir, fetchImpl, statusTtlMs, raidBank, kartBank, potatoBank, amongBank, random, logger
 */
function createGamesServer(o = {}) {
  const BASE = normBase(o.basePath);
  const PROD = !!o.production;
  const KEY = o.stationKey || '';
  const DEV_HOST = !PROD && !KEY; // HOST_SECRET fallback: local development without a platform only
  const HOST_SECRET = DEV_HOST ? (o.hostSecret || 'gdg-race') : null;
  const PORT = o.port || 3000;
  const log = o.logger || console;
  const PUBLIC_ORIGIN = (() => {
    const u = String(o.publicUrl || '').replace(/\/+$/, '');
    return BASE && u.endsWith(BASE) ? u.slice(0, -BASE.length) : u; // accept https://x or https://x/games
  })();
  const SIGN_IN = o.signInUrl != null ? o.signInUrl : (PUBLIC_ORIGIN ? PUBLIC_ORIGIN + '/' : '');
  const dirs = {
    'code-man': o.codeManDir || path.join(ROOT, '..', 'Code-Man'),
    codebreaker: o.codeBreakerDir || path.join(ROOT, '..', 'CodeBreaker'),
  };
  const status = new station.StationStatus({ apiUrl: o.platformApiUrl, fetchImpl: o.fetchImpl, ttlMs: o.statusTtlMs || 30000 });
  const secretHash = HOST_SECRET ? crypto.createHash('sha256').update(HOST_SECRET).digest() : null;
  const secretOk = (s) => !!secretHash && typeof s === 'string' && s.length <= 200 &&
    crypto.timingSafeEqual(crypto.createHash('sha256').update(s).digest(), secretHash);
  const tokenOk = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

  // ---------- station checks ----------
  /** Full check of a station token for `game`: signature/claims + platform status (cached). */
  async function checkStation(token, game) {
    if (DEV_HOST) return { ok: true, dev: true, claims: { game, sub: 'dev', label: 'Dev', by: 'Developer' } };
    if (!token) return { ok: false, variant: 'locked' };
    const v = station.verifyToken(token, KEY, { game });
    if (!v.ok) return { ok: false, variant: v.reason === 'EXPIRED' ? 'expired' : 'locked', reason: v.reason };
    const s = await status.check(v.claims.sub, token);
    if (s.open) return { ok: true, claims: v.claims, token };
    if (!s.known) return { ok: false, variant: 'unreachable', claims: v.claims };
    return { ok: false, variant: 'closed', claims: v.claims };
  }

  function holdOn(res, variant, code) {
    res.status(code || 403).set('Cache-Control', 'no-store').type('html')
      .send(renderHoldOn({ basePath: BASE, variant, signInUrl: SIGN_IN }));
  }
  const secureCookie = PROD;
  const gate = (game) => async (req, res, next) => {
    try {
      const token = station.parseCookies(req.headers.cookie)[station.COOKIE];
      const r = await checkStation(token, game);
      if (r.ok) { res.set('Cache-Control', 'private, no-cache'); return next(); }
      if (r.variant === 'closed' || r.variant === 'expired') res.append('Set-Cookie', station.clearStationCookie({ basePath: BASE || '/', secure: secureCookie }));
      return holdOn(res, r.variant, r.variant === 'unreachable' ? 503 : 403);
    } catch (e) { next(e); }
  };

  // ---------- HTTP ----------
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (o.forceHttps && req.headers['x-forwarded-proto'] === 'http') return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
    next();
  });
  app.get('/healthz', (req, res) => res.json({ ok: true, rooms: rooms.rooms.size, raids: raids.rooms.size, karts: karts.rooms.size, potatoes: potatoes.rooms.size, among: amongs.rooms.size }));
  if (BASE) app.get('/', (req, res) => res.redirect(BASE + '/'));

  const r = express.Router({ strict: true });
  r.get('/healthz', (req, res) => res.json({ ok: true }));

  // launch: verify locally, confirm with the platform, set the cookie, go to the game
  r.get('/launch', async (req, res, next) => {
    try {
      const t = typeof req.query.t === 'string' ? req.query.t : '';
      if (DEV_HOST) return res.redirect(302, BASE + '/race/');
      const v = station.verifyToken(t, KEY);
      if (!v.ok) return holdOn(res, v.reason === 'EXPIRED' ? 'expired' : 'locked');
      const s = await status.check(v.claims.sub, t, { force: true });
      if (!s.known) return holdOn(res, 'unreachable', 503);
      if (!s.open) return holdOn(res, 'closed');
      const maxAge = v.claims.exp - Math.floor(Date.now() / 1000);
      res.append('Set-Cookie', station.stationCookie(t, { basePath: BASE || '/', secure: secureCookie, maxAgeSec: maxAge }));
      res.set('Cache-Control', 'no-store');
      return res.redirect(302, BASE + '/' + v.claims.game + '/');
    } catch (e) { next(e); }
  });

  // /games/ : with a station go to its game, otherwise "Hold on!"
  r.get('/', async (req, res, next) => {
    try {
      if (DEV_HOST) return res.redirect(302, BASE + '/race/');
      const token = station.parseCookies(req.headers.cookie)[station.COOKIE];
      const v = token ? station.verifyToken(token, KEY) : null;
      if (v && v.ok) return res.redirect(302, BASE + '/' + v.claims.game + '/');
      return holdOn(res, v && v.reason === 'EXPIRED' ? 'expired' : 'locked');
    } catch (e) { next(e); }
  });

  // shared static (css / client js / socket helpers). Pages (*.html) are only reachable through the routes below.
  r.use('/shared', express.static(path.join(ROOT, 'shared')));
  r.use('/vendor/phaser', express.static(path.join(ROOT, 'node_modules', 'phaser', 'dist')));
  const publicStatic = express.static(path.join(ROOT, 'public'), { index: false, redirect: false });
  r.use((req, res, next) => (/\.html?$/i.test(req.path) ? next() : publicStatic(req, res, next)));

  const page = (file) => (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(ROOT, 'public', file)); };
  for (const game of station.GAMES) {
    r.get('/' + game, (req, res) => res.redirect(301, BASE + '/' + game + '/'));
  }
  r.get('/race/', gate('race'), page('host.html'));
  r.get('/race/play', page('play.html'));
  r.get('/raid/', gate('raid'), page('raid-host.html'));
  r.get('/raid/play', page('raid-play.html'));
  r.get('/kart/', gate('kart'), page('kart-host.html'));
  r.get('/kart/play', page('kart-play.html'));
  r.get('/potato/', gate('potato'), page('potato-host.html'));
  r.get('/potato/play', page('potato-play.html'));
  r.get('/among/', gate('among'), page('among-host.html'));
  r.get('/among/play', page('among-play.html'));
  for (const game of ['code-man', 'codebreaker']) {
    const serve = express.static(dirs[game], { index: 'index.html', dotfiles: 'ignore', redirect: false });
    // Browsers fetch a web app manifest (and its icons) WITHOUT cookies, so those few public files skip the gate.
    r.use('/' + game + '/', (req, res, next) => (MANIFEST_FILES.test(req.path) ? serve(req, res, next) : next()));
    r.use('/' + game + '/', gate(game), (req, res, next) => {
      if (STATIC_DENY.test(req.path.replace(/^\/+/, ''))) return res.status(404).end();
      serve(req, res, next);
    });
  }
  // games that exist on the platform but are not on this server yet
  for (const game of station.GAMES.filter((g) => !PLAYABLE[g])) {
    r.use('/' + game + '/', gate(game), (req, res) => res.status(404).type('text').send('This game is not available yet.'));
  }
  app.use(BASE || '/', r);
  app.use((req, res) => res.status(404).type('text').send('Not found'));

  // ---------- Socket.IO ----------
  const server = http.createServer(app);
  const io = new Server(server, {
    path: (BASE || '') + '/socket.io',
    maxHttpBufferSize: 1e5, pingInterval: 5000, pingTimeout: 8000, serveClient: true,
  });
  const raidNs = io.of('/raid');
  const kartNs = io.of('/kart');
  const potatoNs = io.of('/potato');
  const amongNs = io.of('/among');
  const readStation = (socket, next) => {
    socket.data.stationToken = station.parseCookies(socket.handshake.headers.cookie)[station.COOKIE] || null;
    next();
  };
  io.use(readStation);
  raidNs.use(readStation);
  kartNs.use(readStation);
  potatoNs.use(readStation);
  amongNs.use(readStation);

  const rooms = new RoomManager();
  const raids = new RaidManager({ bank: o.raidBank, random: o.random });
  const karts = new KartManager({ bank: o.kartBank, random: o.random });
  const potatoes = new PotatoManager({ bank: o.potatoBank, random: o.random });
  /** Party games (socket-free rooms on a PartyManager): namespace + manager + events; the station sweep covers them. */
  const amongs = new AmongManager({ bank: o.amongBank, random: o.random });
  const party = [{ game: 'potato', nsp: potatoNs, mgr: potatoes, EV: PEV }, { game: 'among', nsp: amongNs, mgr: amongs, EV: AEV }];

  raids.on('out', (code, { target, event, data, volatile }) => {
    let to;
    if (target === 'all') to = raidNs.to('room:' + code);
    else if (target === 'host') to = raidNs.to('host:' + code);
    else if (target === 'players') to = raidNs.to('players:' + code);
    else if (target && target.socket) to = raidNs.to(target.socket);
    if (!to) return;
    (volatile ? to.volatile : to).emit(event, data);
  });

  function baseUrlFor(origin) {
    if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN;
    try {
      const u = new URL(String(origin || ''));
      if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname)) { const ip = lanIPs()[0]; if (ip) u.hostname = ip; }
      return u.origin;
    } catch (e) { return 'http://' + (lanIPs()[0] || 'localhost') + ':' + PORT; }
  }
  const reply = (cb, obj) => { if (typeof cb === 'function') cb(obj); };
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

  /** Close every room opened by a station and tell the big screens. */
  function endStation(sub, reason = 'closed') {
    status.markClosed(sub);
    for (const room of [...rooms.rooms.values()]) {
      if (room.station && room.station.sub === sub) {
        io.to('host:' + room.code).emit(REV.STATION_CLOSED, { reason });
        rooms.destroy(room.code);
      }
    }
    for (const room of [...raids.rooms.values()]) {
      if (room.station && room.station.sub === sub) {
        raidNs.to('host:' + room.code).emit(REV.STATION_CLOSED, { reason });
        raids.destroy(room.code, 'station-closed');
      }
    }
    for (const room of [...karts.rooms.values()]) {
      if (room.station && room.station.sub === sub) {
        kartNs.to('host:' + room.code).emit(KEV.STATION_CLOSED, { reason });
        karts.destroy(room.code);
      }
    }
    for (const pg of party) {
      for (const room of [...pg.mgr.rooms.values()]) {
        if (room.station && room.station.sub === sub) {
          pg.nsp.to('host:' + room.code).emit(pg.EV.STATION_CLOSED, { reason });
          pg.mgr.destroy(room.code, 'station-closed');
        }
      }
    }
  }

  /** Host authorisation for `game` on a socket. Resolves to { ok, claims } or an error reply. */
  async function hostAuth(socket, game, data) {
    if (DEV_HOST) {
      if (socket.data.devHost) return { ok: true, claims: { sub: 'dev', game, label: 'Dev', by: 'Developer' } };
      if (isObj(data) && secretOk(data.secret)) { socket.data.devHost = true; return { ok: true, claims: { sub: 'dev', game, label: 'Dev', by: 'Developer' } }; }
      return { ok: false, code: 'AUTH', error: 'Wrong host key.' };
    }
    const token = socket.data.stationToken;
    const r = await checkStation(token, game);
    if (r.ok) return { ok: true, claims: r.claims, token };
    if (r.variant === 'closed' || r.variant === 'expired') {
      if (r.claims) endStation(r.claims.sub, r.variant);
      return { ok: false, code: 'STATION_CLOSED', variant: r.variant, error: 'This station was closed by the Registration Team.' };
    }
    if (r.variant === 'unreachable') return { ok: false, code: 'UNREACHABLE', error: 'Could not reach the event platform. Try again.' };
    return { ok: false, code: 'STATION', variant: 'locked', error: 'Open this game from a game station.' };
  }

  function hello(socket) {
    socket.emit('hello', { mode: DEV_HOST ? 'dev' : 'station', signInUrl: SIGN_IN });
  }

  // ======================= GDG RACE ("/") and CODE KART BATTLE ("/kart") =======================
  // Both run the race room (Code Kart Battle is a Room subclass), so they share these socket handlers.
  function bindRaceGame(nsp, mgr, game, extra) {
    function bindHost(socket, room, joinUrl) {
      socket.data.role = 'host';
      socket.data.code = room.code;
      socket.join('room:' + room.code);
      socket.join('host:' + room.code);
      room.setHostConnected(true);
      return QRCode.toDataURL(joinUrl, { margin: 2, width: 520, errorCorrectionLevel: 'M' });
    }
    const hostRoom = (socket) => (socket.data.role === 'host' ? mgr.get(socket.data.code) : null);
    function playerRoom(socket) {
      if (socket.data.role !== 'player') return null;
      const room = mgr.get(socket.data.code);
      if (!room || !room.players.has(socket.data.playerId)) return null;
      return room;
    }
    function publicSelf(room, p) {
      const car = room.cars[p.carId - 1];
      return { id: p.id, name: p.name, carId: p.carId, color: car.color, carName: car.name };
    }
    function attachPlayer(socket, room, player) {
      socket.data.role = 'player'; socket.data.code = room.code; socket.data.playerId = player.id;
      socket.join('room:' + room.code); socket.join('players:' + room.code);
      socket.emit(EVT.CONNECTION_STATUS, { connected: true, hostConnected: room.hostConnected });
    }
    function allowSteer(socket) {
      const now = Date.now();
      const b = socket.data.bucket || (socket.data.bucket = { tokens: CONFIG.RATE.STEER_BURST, at: now });
      b.tokens = Math.min(CONFIG.RATE.STEER_BURST, b.tokens + ((now - b.at) / 1000) * CONFIG.RATE.STEER_PER_SEC);
      b.at = now;
      if (b.tokens < 1) return false;
      b.tokens -= 1;
      return true;
    }

    mgr.on('out', (code, { target, event, data }) => {
      if (target === 'all') nsp.to('room:' + code).emit(event, data);
      else if (target === 'host') nsp.to('host:' + code).emit(event, data);
      else if (target === 'players') nsp.to('players:' + code).emit(event, data);
      else if (target && target.socket) nsp.to(target.socket).emit(event, data);
    });

    nsp.on('connection', (socket) => {
      hello(socket);

      socket.on(EVT.CREATE_ROOM, async (data, cb) => {
        try {
          if (!isObj(data)) return reply(cb, { ok: false, error: 'Bad request.' });
          let room = null;
          if (DEV_HOST && typeof data.token === 'string' && typeof data.code === 'string') {
            const rr = mgr.get(data.code);
            if (rr && tokenOk(rr.hostToken, data.token)) { room = rr; socket.data.devHost = true; }
          }
          let claims = null;
          if (!room) {
            const a = await hostAuth(socket, game, data);
            if (!a.ok) return reply(cb, a);
            claims = a.claims;
            if (!DEV_HOST) {
              room = [...mgr.rooms.values()].find((x) => x.station && x.station.sub === claims.sub) || null;
              if (room) room.station.token = a.token;
            }
            if (!room) {
              room = mgr.createRoom(isObj(data.settings) ? data.settings : null);
              room.station = DEV_HOST ? null : { sub: claims.sub, token: a.token, label: claims.label, by: claims.by };
            }
          }
          const joinUrl = baseUrlFor(data.origin) + BASE + '/' + game + '/play?room=' + room.code;
          const qr = await bindHost(socket, room, joinUrl);
          reply(cb, { ok: true, token: room.hostToken, joinUrl, qr, room: room.info(), config: { cars: room.cars }, station: room.station ? { label: room.station.label, by: room.station.by } : null });
          socket.emit(EVT.ROOM_CREATED, { code: room.code, joinUrl });
          room.broadcastRoom();
        } catch (e) {
          log.error(game + ':create-room', e);
          reply(cb, { ok: false, error: 'Server error. Try again.' });
        }
      });

      // host actions: bound to the room above AND (station mode) the station must still be open
      const hostAction = (event, fn) => socket.on(event, async (data, cb) => {
        try {
          const room = hostRoom(socket);
          if (!room) return reply(cb, { ok: false, error: 'Not authorised.' });
          if (room.station) {
            const a = await hostAuth(socket, game);
            if (!a.ok || a.claims.sub !== room.station.sub) return reply(cb, a.ok ? { ok: false, error: 'Not authorised.' } : a);
          }
          if (!mgr.get(room.code)) return reply(cb, { ok: false, error: 'Room closed.' });
          reply(cb, fn(room, isObj(data) ? data : {}));
        } catch (e) {
          log.error(event, e);
          reply(cb, { ok: false, error: 'Server error.' });
        }
      });
      hostAction(EVT.START_COUNTDOWN, (rm) => rm.startCountdown());
      hostAction(EVT.CANCEL_COUNTDOWN, (rm) => rm.cancelCountdown());
      hostAction(EVT.PAUSE_RACE, (rm) => rm.pause());
      hostAction(EVT.RESUME_RACE, (rm) => rm.resume());
      hostAction(EVT.ABORT_RACE, (rm) => rm.abort());
      hostAction(EVT.NEW_ROUND, (rm) => rm.newRound());
      hostAction(EVT.RESET_SESSION, (rm) => rm.reset());
      hostAction(EVT.UPDATE_SETTINGS, (rm, d) => rm.updateSettings(d));
      hostAction(EVT.REMOVE_PLAYER, (rm, d) => {
        const res = rm.removePlayer(String(d.playerId || ''), 'removed');
        if (res.ok && res.socketId) {
          const s = nsp.sockets.get(res.socketId);
          if (s) { s.leave('room:' + rm.code); s.leave('players:' + rm.code); s.data.role = null; s.data.playerId = null; }
        }
        return { ok: res.ok, error: res.error };
      });

      socket.on(EVT.ROOM_INFO, (data, cb) => {
        const room = isObj(data) ? mgr.get(data.code) : null;
        if (!room) return reply(cb, { ok: false, code: 'NO_ROOM', error: 'Room not found. Check the code or scan the QR again.' });
        reply(cb, room.joinInfo());
      });

      socket.on(EVT.JOIN_ROOM, (data, cb) => {
        try {
          if (!isObj(data)) return reply(cb, { ok: false, error: 'Bad request.' });
          const room = mgr.get(data.code);
          if (!room) return reply(cb, { ok: false, code: 'NO_ROOM', error: 'Room not found. Check the code or scan the QR again.' });
          if (socket.data.role) return reply(cb, { ok: false, code: 'ALREADY', error: 'This device is already in a room.' });
          const res = room.addPlayer({ name: data.name, carId: data.carId, socketId: socket.id });
          if (!res.ok) return reply(cb, res);
          attachPlayer(socket, room, res.player);
          reply(cb, { ok: true, player: publicSelf(room, res.player), key: res.player.key, room: room.info() });
        } catch (e) {
          log.error(game + ':join-room', e);
          reply(cb, { ok: false, error: 'Server error.' });
        }
      });

      socket.on(EVT.RECONNECT_PLAYER, (data, cb) => {
        try {
          const room = isObj(data) ? mgr.get(data.code) : null;
          if (!room) return reply(cb, { ok: false, code: 'NO_ROOM', error: 'Room not found.' });
          const res = room.reconnectPlayer(data.key, socket.id);
          if (!res.ok) return reply(cb, res);
          if (res.previousSocketId && res.previousSocketId !== socket.id) {
            const old = nsp.sockets.get(res.previousSocketId);
            if (old) { old.data.role = null; old.data.playerId = null; old.emit(EVT.REPLACED, {}); old.leave('room:' + room.code); old.leave('players:' + room.code); }
          }
          attachPlayer(socket, room, res.player);
          reply(cb, Object.assign({ ok: true, player: publicSelf(room, res.player), room: room.info() }, res.you ? { you: res.you } : {}));
        } catch (e) {
          log.error(game + ':reconnect-player', e);
          reply(cb, { ok: false, error: 'Server error.' });
        }
      });

      socket.on(EVT.SELECT_CAR, (data, cb) => {
        const room = playerRoom(socket);
        if (!room) return reply(cb, { ok: false, error: 'Not in a room.' });
        reply(cb, room.selectCar(socket.data.playerId, isObj(data) ? data.carId : null));
      });

      socket.on(EVT.STEER, (data) => {
        const room = playerRoom(socket);
        if (!room || !isObj(data) || !allowSteer(socket)) return;
        room.steer(socket.data.playerId, data.dir);
      });

      if (extra) extra(socket, { playerRoom });

      socket.on('disconnect', () => {
        if (socket.data.role === 'host') {
          const room = mgr.get(socket.data.code);
          if (room) {
            const left = nsp.adapter.rooms.get('host:' + room.code);
            if (!left || left.size === 0) room.setHostConnected(false);
          }
        } else if (socket.data.role === 'player') {
          const room = mgr.get(socket.data.code);
          if (room) room.markDisconnected(socket.data.playerId, socket.id);
        }
      });
    });
  }

  bindRaceGame(io.of('/'), rooms, 'race');

  // Code Kart Battle: phones also answer item-box questions and fire their item (the room checks it is theirs)
  function allowKart(socket) { // a few taps per second is plenty
    const now = Date.now();
    const b = socket.data.kb || (socket.data.kb = { tokens: 6, at: now });
    b.tokens = Math.min(6, b.tokens + ((now - b.at) / 1000) * 3); b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1; return true;
  }
  bindRaceGame(kartNs, karts, 'kart', (socket, h) => {
    socket.on(KEV.ANSWER, (data, cb) => {
      const room = h.playerRoom(socket);
      if (!room || !allowKart(socket)) return reply(cb, { ok: false, error: 'Not in a race.' });
      reply(cb, room.answer(socket.data.playerId, isObj(data) ? data : {}));
    });
    socket.on(KEV.USE, (data, cb) => {
      const room = h.playerRoom(socket);
      if (!room || !allowKart(socket)) return reply(cb, { ok: false, error: 'Not in a race.' });
      reply(cb, room.useItem(socket.data.playerId));
    });
  });

  // ======================= BOSS RAID ("/raid" namespace) =======================
  function allowRaid(socket) { // small token bucket: phones never need more than a few events per second
    const now = Date.now();
    const b = socket.data.rb || (socket.data.rb = { tokens: 10, at: now });
    b.tokens = Math.min(10, b.tokens + ((now - b.at) / 1000) * 5); b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1; return true;
  }
  const raidPlayerView = (room, p) => room.youView(p);

  raidNs.on('connection', (socket) => {
    hello(socket);

    socket.on(REV.CREATE, async (data, cb) => {
      try {
        data = isObj(data) ? data : {};
        const a = await hostAuth(socket, 'raid', data);
        if (!a.ok) return reply(cb, a);
        let room = null;
        if (DEV_HOST) {
          const prev = typeof data.code === 'string' ? raids.get(data.code) : null;
          if (prev && !prev.station) room = prev;
        } else {
          room = raids.findByStation(a.claims.sub);
          if (room) room.station.token = a.token;
        }
        if (!room) {
          room = raids.createRoom();
          room.station = DEV_HOST ? null : { sub: a.claims.sub, token: a.token, label: a.claims.label, by: a.claims.by };
        }
        socket.data.role = 'host'; socket.data.code = room.code;
        socket.join('room:' + room.code); socket.join('host:' + room.code);
        room.setHostConnected(true);
        const joinUrl = baseUrlFor(data.origin) + BASE + '/raid/play?room=' + room.code;
        const qr = await QRCode.toDataURL(joinUrl, { margin: 2, width: 520, errorCorrectionLevel: 'M' });
        reply(cb, {
          ok: true, code: room.code, joinUrl, qr, teams: TEAMS, state: room.state(),
          station: room.station ? { label: room.station.label, by: room.station.by } : null,
        });
      } catch (e) {
        log.error('raid:create', e);
        reply(cb, { ok: false, error: 'Server error. Try again.' });
      }
    });

    const raidHost = (event, fn) => socket.on(event, async (data, cb) => {
      try {
        const room = socket.data.role === 'host' ? raids.get(socket.data.code) : null;
        if (!room) return reply(cb, { ok: false, error: 'Not authorised.' });
        const a = await hostAuth(socket, 'raid');
        if (!a.ok) return reply(cb, a);
        if (room.station && a.claims.sub !== room.station.sub) return reply(cb, { ok: false, error: 'Not authorised.' });
        if (!raids.get(room.code)) return reply(cb, { ok: false, error: 'Room closed.' });
        reply(cb, fn(room, isObj(data) ? data : {}));
      } catch (e) {
        log.error(event, e);
        reply(cb, { ok: false, error: 'Server error.' });
      }
    });
    raidHost(REV.START, (rm) => rm.start());
    raidHost(REV.NEXT, (rm) => rm.next());
    raidHost(REV.PAUSE, (rm) => rm.pause());
    raidHost(REV.END, (rm) => rm.end());
    raidHost(REV.AGAIN, (rm) => rm.again());

    socket.on(REV.INFO, (data, cb) => {
      const room = isObj(data) ? raids.get(data.code) : null;
      if (!room) return reply(cb, { ok: false, code: 'NO_ROOM', error: 'Raid not found. Scan the QR on the big screen again.' });
      reply(cb, room.joinInfo());
    });

    function attachRaidPlayer(room, p) {
      socket.data.role = 'player'; socket.data.code = room.code; socket.data.playerId = p.id;
      socket.join('room:' + room.code); socket.join('players:' + room.code);
    }

    socket.on(REV.JOIN, (data, cb) => {
      try {
        if (!isObj(data) || !allowRaid(socket)) return reply(cb, { ok: false, error: 'Bad request.' });
        const room = raids.get(data.code);
        if (!room) return reply(cb, { ok: false, code: 'NO_ROOM', error: 'Raid not found. Scan the QR on the big screen again.' });
        if (socket.data.role) return reply(cb, { ok: false, code: 'ALREADY', error: 'This device is already in a raid.' });
        const res = room.addPlayer({ name: data.name, socketId: socket.id });
        if (!res.ok) return reply(cb, res);
        attachRaidPlayer(room, res.player);
        reply(cb, Object.assign({ ok: true, key: res.player.key, code: room.code }, raidPlayerView(room, res.player)));
      } catch (e) {
        log.error('raid:join', e);
        reply(cb, { ok: false, error: 'Server error.' });
      }
    });

    socket.on(REV.RECONNECT, (data, cb) => {
      try {
        if (!isObj(data) || !allowRaid(socket)) return reply(cb, { ok: false, error: 'Bad request.' });
        const room = raids.get(data.code);
        if (!room) return reply(cb, { ok: false, code: 'NO_ROOM', error: 'Raid not found.' });
        const res = room.reconnectPlayer(data.key, socket.id);
        if (!res.ok) return reply(cb, res);
        if (res.previousSocketId && res.previousSocketId !== socket.id) {
          const old = raidNs.sockets.get(res.previousSocketId);
          if (old) { old.data.role = null; old.data.playerId = null; old.emit(REV.REPLACED, {}); old.leave('room:' + room.code); old.leave('players:' + room.code); }
        }
        attachRaidPlayer(room, res.player);
        reply(cb, Object.assign({ ok: true, code: room.code }, raidPlayerView(room, res.player)));
      } catch (e) {
        log.error('raid:reconnect', e);
        reply(cb, { ok: false, error: 'Server error.' });
      }
    });

    socket.on(REV.ANSWER, (data, cb) => {
      if (socket.data.role !== 'player' || !allowRaid(socket)) return reply(cb, { ok: false, error: 'Not in a raid.' });
      const room = raids.get(socket.data.code);
      if (!room) return reply(cb, { ok: false, error: 'Not in a raid.' });
      reply(cb, room.answer(socket.data.playerId, isObj(data) ? data : {}));
    });

    socket.on('disconnect', () => {
      const room = raids.get(socket.data.code);
      if (!room) return;
      if (socket.data.role === 'host') {
        const left = raidNs.adapter.rooms.get('host:' + room.code);
        if (!left || left.size === 0) room.setHostConnected(false);
      } else if (socket.data.role === 'player') room.markDisconnected(socket.data.playerId, socket.id);
    });
  });

  // ======================= PARTY GAMES (Hot Potato Code "/potato", Among Bugs "/among") =======================
  // Same shape as Boss Raid: a station host creates (or re-opens) its room; host actions re-check the station; phones
  // join / reconnect with a key and only send their own player actions (the room checks what they are allowed to do).
  function bindPartyGame({ game, nsp, mgr, EV, hostActions, playerActions }) {
    const NO_ROOM = 'Game not found. Scan the QR on the big screen again.';
    mgr.on('out', (code, { target, event, data, volatile }) => {
      let to;
      if (target === 'all') to = nsp.to('room:' + code);
      else if (target === 'host') to = nsp.to('host:' + code);
      else if (target === 'players') to = nsp.to('players:' + code);
      else if (target && target.socket) to = nsp.to(target.socket);
      if (!to) return;
      (volatile ? to.volatile : to).emit(event, data);
    });
    const allow = (socket) => { // phones never need more than a few events per second
      const now = Date.now();
      const b = socket.data.pb || (socket.data.pb = { tokens: 8, at: now });
      b.tokens = Math.min(8, b.tokens + ((now - b.at) / 1000) * 4); b.at = now;
      if (b.tokens < 1) return false;
      b.tokens -= 1; return true;
    };

    nsp.on('connection', (socket) => {
      hello(socket);

      socket.on(EV.CREATE, async (data, cb) => {
        try {
          data = isObj(data) ? data : {};
          const a = await hostAuth(socket, game, data);
          if (!a.ok) return reply(cb, a);
          let room = null;
          if (DEV_HOST) {
            const prev = typeof data.code === 'string' ? mgr.get(data.code) : null;
            if (prev && !prev.station) room = prev;
          } else {
            room = mgr.findByStation(a.claims.sub);
            if (room) room.station.token = a.token;
          }
          if (!room) {
            room = mgr.createRoom();
            room.station = DEV_HOST ? null : { sub: a.claims.sub, token: a.token, label: a.claims.label, by: a.claims.by };
          }
          socket.data.role = 'host'; socket.data.code = room.code;
          socket.join('room:' + room.code); socket.join('host:' + room.code);
          room.setHostConnected(true);
          const joinUrl = baseUrlFor(data.origin) + BASE + '/' + game + '/play?room=' + room.code;
          const qr = await QRCode.toDataURL(joinUrl, { margin: 2, width: 520, errorCorrectionLevel: 'M' });
          reply(cb, {
            ok: true, code: room.code, joinUrl, qr, state: room.publicView(),
            station: room.station ? { label: room.station.label, by: room.station.by } : null,
          });
        } catch (e) {
          log.error(game + ':create', e);
          reply(cb, { ok: false, error: 'Server error. Try again.' });
        }
      });

      for (const [event, fn] of Object.entries(hostActions)) {
        socket.on(event, async (data, cb) => {
          try {
            const room = socket.data.role === 'host' ? mgr.get(socket.data.code) : null;
            if (!room) return reply(cb, { ok: false, error: 'Not authorised.' });
            const a = await hostAuth(socket, game);
            if (!a.ok) return reply(cb, a);
            if (room.station && a.claims.sub !== room.station.sub) return reply(cb, { ok: false, error: 'Not authorised.' });
            if (!mgr.get(room.code)) return reply(cb, { ok: false, error: 'Room closed.' });
            reply(cb, fn(room, isObj(data) ? data : {}));
          } catch (e) {
            log.error(event, e);
            reply(cb, { ok: false, error: 'Server error.' });
          }
        });
      }

      socket.on(EV.INFO, (data, cb) => {
        const room = isObj(data) ? mgr.get(data.code) : null;
        if (!room) return reply(cb, { ok: false, code: 'NO_ROOM', error: NO_ROOM });
        reply(cb, room.joinInfo());
      });

      function attach(room, p) {
        socket.data.role = 'player'; socket.data.code = room.code; socket.data.playerId = p.id;
        socket.join('room:' + room.code); socket.join('players:' + room.code);
      }

      socket.on(EV.JOIN, (data, cb) => {
        try {
          if (!isObj(data) || !allow(socket)) return reply(cb, { ok: false, error: 'Bad request.' });
          const room = mgr.get(data.code);
          if (!room) return reply(cb, { ok: false, code: 'NO_ROOM', error: NO_ROOM });
          if (socket.data.role) return reply(cb, { ok: false, code: 'ALREADY', error: 'This device is already in a game.' });
          const res = room.addPlayer({ name: data.name, socketId: socket.id });
          if (!res.ok) return reply(cb, res);
          attach(room, res.player);
          reply(cb, Object.assign({ ok: true, key: res.player.key, code: room.code }, room.youView(res.player)));
        } catch (e) {
          log.error(game + ':join', e);
          reply(cb, { ok: false, error: 'Server error.' });
        }
      });

      socket.on(EV.RECONNECT, (data, cb) => {
        try {
          if (!isObj(data) || !allow(socket)) return reply(cb, { ok: false, error: 'Bad request.' });
          const room = mgr.get(data.code);
          if (!room) return reply(cb, { ok: false, code: 'NO_ROOM', error: 'Game not found.' });
          const res = room.reconnectPlayer(data.key, socket.id);
          if (!res.ok) return reply(cb, res);
          if (res.previousSocketId && res.previousSocketId !== socket.id) {
            const old = nsp.sockets.get(res.previousSocketId);
            if (old) { old.data.role = null; old.data.playerId = null; old.emit(EV.REPLACED, {}); old.leave('room:' + room.code); old.leave('players:' + room.code); }
          }
          attach(room, res.player);
          reply(cb, Object.assign({ ok: true, code: room.code }, room.youView(res.player)));
        } catch (e) {
          log.error(game + ':reconnect', e);
          reply(cb, { ok: false, error: 'Server error.' });
        }
      });

      for (const [event, fn] of Object.entries(playerActions)) {
        socket.on(event, (data, cb) => {
          try {
            if (socket.data.role !== 'player' || !allow(socket)) return reply(cb, { ok: false, error: 'Not in a game.' });
            const room = mgr.get(socket.data.code);
            if (!room) return reply(cb, { ok: false, error: 'Not in a game.' });
            reply(cb, fn(room, socket.data.playerId, isObj(data) ? data : {}));
          } catch (e) {
            log.error(event, e);
            reply(cb, { ok: false, error: 'Server error.' });
          }
        });
      }

      socket.on('disconnect', () => {
        const room = mgr.get(socket.data.code);
        if (!room) return;
        if (socket.data.role === 'host') {
          const left = nsp.adapter.rooms.get('host:' + room.code);
          if (!left || left.size === 0) room.setHostConnected(false);
        } else if (socket.data.role === 'player') room.markDisconnected(socket.data.playerId, socket.id);
      });
    });
  }

  bindPartyGame({
    game: 'potato', nsp: potatoNs, mgr: potatoes, EV: PEV,
    hostActions: { [PEV.START]: (rm) => rm.start(), [PEV.PAUSE]: (rm) => rm.pause(), [PEV.END]: (rm) => rm.end(), [PEV.AGAIN]: (rm) => rm.again() },
    playerActions: { [PEV.ANSWER]: (rm, pid, d) => rm.answer(pid, d) },
  });
  bindPartyGame({
    game: 'among', nsp: amongNs, mgr: amongs, EV: AEV,
    hostActions: { [AEV.START]: (rm) => rm.start(), [AEV.PAUSE]: (rm) => rm.pause(), [AEV.END]: (rm) => rm.end(), [AEV.AGAIN]: (rm) => rm.again() },
    playerActions: {
      [AEV.MOVE]: (rm, pid, d) => rm.move(pid, d),
      [AEV.TASK]: (rm, pid) => rm.openTask(pid),
      [AEV.ANSWER]: (rm, pid, d) => rm.answer(pid, d),
      [AEV.FAKE]: (rm, pid) => rm.fakeFix(pid),
      [AEV.SWAP]: (rm, pid) => rm.swapLine(pid),
      [AEV.SABOTAGE]: (rm, pid, d) => rm.sabotage(pid, d),
      [AEV.MEETING]: (rm, pid, d) => rm.callMeeting(pid, d),
      [AEV.VOTE]: (rm, pid, d) => rm.vote(pid, d),
    },
  });

  // ---------- loops ----------
  const timers = [];
  function start() {
    let last = process.hrtime.bigint();
    timers.push(setInterval(() => {
      const now = process.hrtime.bigint();
      const dt = Math.min(0.1, Number(now - last) / 1e9);
      last = now;
      try { rooms.tickAll(dt); } catch (e) { log.error('tick error', e); }
      try { karts.tickAll(dt); } catch (e) { log.error('kart tick error', e); }
    }, Math.round(1000 / CONFIG.SIM_HZ)));
    let lastR = process.hrtime.bigint();
    timers.push(setInterval(() => {
      const now = process.hrtime.bigint();
      const dt = Math.min(0.5, Number(now - lastR) / 1e9);
      lastR = now;
      try { raids.tickAll(dt); } catch (e) { log.error('raid tick error', e); }
      for (const pg of party) { try { pg.mgr.tickAll(dt); } catch (e) { log.error(pg.game + ' tick error', e); } }
    }, 100));
    timers.push(setInterval(() => { rooms.cleanup(); raids.cleanup(); karts.cleanup(); party.forEach((pg) => pg.mgr.cleanup()); }, 60000));
    timers.push(setInterval(sweepStations, o.sweepMs || 30000));
  }
  /** Every 30 s: is each station that owns a room still open? (Stop on the platform ends the room.) */
  async function sweepStations() {
    if (DEV_HOST) return;
    const seen = new Map();
    const all = [...rooms.rooms.values(), ...raids.rooms.values(), ...karts.rooms.values()];
    for (const pg of party) all.push(...pg.mgr.rooms.values());
    for (const room of all) if (room.station) seen.set(room.station.sub, room.station.token);
    for (const [sub, token] of seen) {
      try {
        const v = station.verifyToken(token, KEY);
        if (!v.ok) { endStation(sub, v.reason === 'EXPIRED' ? 'expired' : 'closed'); continue; }
        const s = await status.check(sub, token);
        if (s.known && !s.open) endStation(sub, 'closed');
      } catch (e) { log.error('station sweep', e); }
    }
  }
  function stop() { timers.splice(0).forEach(clearInterval); io.close(); server.close(); }

  return { app, server, io, rooms, raids, karts, potatoes, amongs, status, start, stop, sweepStations, endStation, lanIPs, config: { BASE, DEV_HOST, HOST_SECRET, PROD, PUBLIC_ORIGIN } };
}

module.exports = { createGamesServer, normBase, lanIPs };
