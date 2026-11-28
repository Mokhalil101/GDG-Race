'use strict';
/**
 * Test helpers: a games server on a random port with a fake platform, and a tiny Socket.IO v4 client over `ws`
 * (ws ships with socket.io/engine.io already; no socket.io-client dependency needed).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { createGamesServer } = require('../server/app');

const KEY = 'test-station-key-0123456789-abcdefghijklmnop';

function tmpGame(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdg-static-'));
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  return dir;
}

/** Starts a server. `platform` = Map(sub -> open:boolean) consulted by the fake status endpoint. */
async function startServer(opts = {}) {
  const platform = opts.platform || new Map();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init && init.headers && init.headers.Authorization });
    const m = /\/api\/game-stations\/([^/]+)\/status$/.exec(url);
    if (!m || !platform.has(decodeURIComponent(m[1]))) return { ok: false, status: 401, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ open: platform.get(decodeURIComponent(m[1])) }) };
  };
  const g = createGamesServer(Object.assign({
    stationKey: KEY, platformApiUrl: 'http://platform.test', fetchImpl, production: false,
    codeManDir: tmpGame({ 'index.html': '<!doctype html><title>CODE MAN</title><link rel="manifest" href="manifest.webmanifest">', 'manifest.webmanifest': '{"start_url":"./index.html"}', 'package.json': '{}', 'tests/a.js': '1' }),
    codeBreakerDir: tmpGame({ 'index.html': '<!doctype html><title>CODEBREAKER</title>', 'data/questions.json': '[]', 'node_modules/x/index.js': 'x' }),
    logger: { error() {}, warn() {}, log() {} },
  }, opts.server));
  await new Promise((r) => g.server.listen(0, '127.0.0.1', r));
  const port = g.server.address().port;
  const base = 'http://127.0.0.1:' + port;
  return { g, port, base, platform, calls, close: () => new Promise((r) => { g.io.close(); g.server.close(() => r()); g.server.closeAllConnections && g.server.closeAllConnections(); }) };
}

function get(base, p, cookie) {
  return fetch(base + p, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
}

/** Minimal Socket.IO v4 client: connect(namespace), emit(event, data) -> Promise(ack), on(event, fn), close(). */
function sio(port, { ns = '/', cookie, basePath = '/games' } = {}) {
  const ws = new WebSocket('ws://127.0.0.1:' + port + basePath + '/socket.io/?EIO=4&transport=websocket', { headers: cookie ? { Cookie: cookie } : {} });
  const nsPrefix = ns === '/' ? '' : ns + ',';
  let ackId = 0;
  const acks = new Map(), handlers = new Map(), received = [];
  let resolveConnect;
  const connected = new Promise((r) => { resolveConnect = r; });
  ws.on('message', (buf) => {
    const s = buf.toString();
    if (s === '2') return ws.send('3');
    if (s[0] === '0') return ws.send('40' + nsPrefix);
    if (s.startsWith('40' + nsPrefix)) return resolveConnect();
    if (s.startsWith('42' + nsPrefix)) {
      const [ev, data] = JSON.parse(s.slice(2 + nsPrefix.length));
      received.push({ ev, data });
      (handlers.get(ev) || []).forEach((fn) => fn(data));
      return;
    }
    if (s.startsWith('43' + nsPrefix)) {
      const rest = s.slice(2 + nsPrefix.length);
      const i = rest.indexOf('[');
      const id = Number(rest.slice(0, i));
      const cb = acks.get(id); acks.delete(id);
      if (cb) cb(JSON.parse(rest.slice(i))[0]);
    }
  });
  return {
    ready: connected,
    received,
    emit(ev, data) {
      return new Promise((resolve) => { const id = ackId++; acks.set(id, resolve); ws.send('42' + nsPrefix + id + JSON.stringify([ev, data || {}])); });
    },
    on(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(fn); },
    waitFor(ev, ms = 2000) {
      const hit = received.find((r) => r.ev === ev);
      if (hit) return Promise.resolve(hit.data);
      return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('timeout waiting for ' + ev)), ms); this.on(ev, (d) => { clearTimeout(t); resolve(d); }); });
    },
    close() { ws.terminate(); },
  };
}

module.exports = { KEY, startServer, get, sio, tmpGame };
