'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { signToken } = require('../server/station');
const { KEY, startServer, get, sio } = require('./helpers');

const SUB = '11111111-2222-4333-8444-555555555555';
const tok = (game, extra, opt) => signToken(Object.assign({ sub: SUB, game, evt: 'e', day: 1, label: 'Booth 1', by: 'Mona' }, extra), KEY, opt);
const cookie = (t) => 'gdg_station=' + t;

test('gating: game pages without a station -> 403 Hold on; phones and shared assets are open', async (t) => {
  const s = await startServer();
  t.after(s.close);
  for (const p of ['/games/raid/', '/games/race/', '/games/code-man/', '/games/code-man/index.html', '/games/codebreaker/', '/games/codebreaker/data/questions.json', '/games/', '/games/kart/']) {
    const r = await get(s.base, p);
    assert.equal(r.status, 403, p);
    const html = await r.text();
    assert.match(html, /Hold on!/, p);
    assert.match(html, /Registration Team/, p);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  for (const p of ['/games/raid/play?room=ABCD', '/games/race/play', '/games/raid.css', '/games/style.css', '/games/station.css', '/games/raid-play.js', '/games/shared/game.js', '/games/socket.io/socket.io.js']) {
    const r = await get(s.base, p);
    assert.equal(r.status, 200, p);
  }
  // the web app manifest is fetched by browsers without cookies: public on purpose
  assert.equal((await get(s.base, '/games/code-man/manifest.webmanifest')).status, 200);
  // pages are not reachable as plain static files
  assert.equal((await get(s.base, '/games/raid-host.html')).status, 404);
  assert.equal((await get(s.base, '/games/host.html')).status, 404);
  // sub-path redirects
  assert.equal((await get(s.base, '/games/code-man')).headers.get('location'), '/games/code-man/');
  assert.equal((await get(s.base, '/')).headers.get('location'), '/games/');
});

test('gating: cookie must match the game and the station must be open', async (t) => {
  const s = await startServer();
  t.after(s.close);
  s.platform.set(SUB, true);
  const raid = cookie(tok('raid'));
  assert.equal((await get(s.base, '/games/raid/', raid)).status, 200);
  assert.equal((await get(s.base, '/games/race/', raid)).status, 403, 'raid station cannot open the race');
  assert.equal((await get(s.base, '/games/', raid)).headers.get('location'), '/games/raid/');
  const cm = cookie(tok('code-man'));
  const page = await get(s.base, '/games/code-man/', cm);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /CODE MAN/);
  assert.equal((await get(s.base, '/games/code-man/manifest.webmanifest', cm)).status, 200);
  assert.equal((await get(s.base, '/games/code-man/package.json', cm)).status, 404);
  assert.equal((await get(s.base, '/games/code-man/tests/a.js', cm)).status, 404);
  const cb = cookie(tok('codebreaker'));
  assert.equal((await get(s.base, '/games/codebreaker/data/questions.json', cb)).status, 200);
  assert.equal((await get(s.base, '/games/codebreaker/node_modules/x/index.js', cb)).status, 404);
  // bad signature / expired cookies
  assert.equal((await get(s.base, '/games/raid/', cookie(signToken({ sub: SUB, game: 'raid' }, KEY + 'nope')))).status, 403);
  const old = await get(s.base, '/games/raid/', cookie(tok('raid', {}, { now: Date.now() - 48 * 3600e3 })));
  assert.equal(old.status, 403);
  assert.match(await old.text(), /expired/);
  // the platform closes the station: page shows "closed" and the cookie is cleared
  s.g.status.cache.clear();
  s.platform.set(SUB, false);
  const closed = await get(s.base, '/games/raid/', raid);
  assert.equal(closed.status, 403);
  assert.match(await closed.text(), /closed by the Registration Team/);
  assert.match(closed.headers.get('set-cookie'), /gdg_station=;.*Max-Age=0/);
});

test('launch: verifies, asks the platform, sets the cookie and redirects', async (t) => {
  const s = await startServer();
  t.after(s.close);
  s.platform.set(SUB, true);
  const t1 = tok('raid');
  const r = await get(s.base, '/games/launch?t=' + t1);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/games/raid/');
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /^gdg_station=/);
  assert.match(sc, /Path=\/games/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  assert.doesNotMatch(sc, /Secure/, 'not Secure outside production');
  assert.equal(s.calls.at(-1).url, 'http://platform.test/api/game-stations/' + SUB + '/status');
  assert.equal(s.calls.at(-1).auth, 'Bearer ' + t1);

  assert.equal((await get(s.base, '/games/launch?t=garbage')).status, 403);
  assert.equal((await get(s.base, '/games/launch?t=' + signToken({ sub: SUB, game: 'raid' }, 'other-key-0123456789-0123456789-xx'))).status, 403);
  assert.equal((await get(s.base, '/games/launch?t=' + tok('raid', { aud: 'nope' }))).status, 403);
  const unknown = await get(s.base, '/games/launch?t=' + tok('raid', { sub: '99999999-0000-4000-8000-000000000000' }));
  assert.equal(unknown.status, 403, 'platform says 401 -> closed');
  assert.match(await unknown.text(), /closed/);
});

test('launch: production cookie is Secure', async (t) => {
  const s = await startServer({ server: { production: true } });
  t.after(s.close);
  s.platform.set(SUB, true);
  const r = await get(s.base, '/games/launch?t=' + tok('race'));
  assert.equal(r.headers.get('location'), '/games/race/');
  assert.match(r.headers.get('set-cookie'), /Secure/);
});

test('sockets: host events need the station cookie for that game; phones can only join existing rooms', async (t) => {
  const s = await startServer();
  t.after(s.close);
  s.platform.set(SUB, true);

  const anon = sio(s.port, { ns: '/raid' }); await anon.ready;
  const nope = await anon.emit('raid:create', { origin: 'http://x' });
  assert.equal(nope.ok, false); assert.equal(nope.code, 'STATION');
  assert.equal((await anon.emit('raid:start')).ok, false);
  const join0 = await anon.emit('raid:join', { code: 'ZZZZ', name: 'Ali' });
  assert.equal(join0.code, 'NO_ROOM');

  const wrong = sio(s.port, { ns: '/raid', cookie: cookie(tok('race')) }); await wrong.ready;
  assert.equal((await wrong.emit('raid:create', {})).ok, false, 'race station cannot host a raid');

  const host = sio(s.port, { ns: '/raid', cookie: cookie(tok('raid')) }); await host.ready;
  const room = await host.emit('raid:create', { origin: 'http://x' });
  assert.equal(room.ok, true);
  assert.match(room.joinUrl, /\/games\/raid\/play\?room=[A-Z]{4}$/);
  assert.match(room.qr, /^data:image\/png;base64,/);
  // a second device on the same station mirrors the same room
  const host2 = sio(s.port, { ns: '/raid', cookie: cookie(tok('raid')) }); await host2.ready;
  assert.equal((await host2.emit('raid:create', {})).code, room.code);

  const phone = sio(s.port, { ns: '/raid' }); await phone.ready;
  const j = await phone.emit('raid:join', { code: room.code, name: 'Ali' });
  assert.equal(j.ok, true);
  assert.equal(typeof j.key, 'string');
  assert.equal((await phone.emit('raid:start')).ok, false, 'phones cannot use host events');
  assert.equal((await host.emit('raid:start')).ok, true);

  // race namespace too
  const rh = sio(s.port, { cookie: cookie(tok('race')) }); await rh.ready;
  const rr = await rh.emit('create-room', { origin: 'http://x' });
  assert.equal(rr.ok, true);
  assert.match(rr.joinUrl, /\/games\/race\/play\?room=/);
  const ra = sio(s.port); await ra.ready;
  assert.equal((await ra.emit('create-room', { secret: 'gdg-race' })).ok, false, 'no HOST_SECRET when a station key is set');

  // the platform closes the station -> the sweep ends the rooms and tells the big screens
  s.g.status.cache.clear();
  s.platform.set(SUB, false);
  await s.g.sweepStations();
  const msg = await host.waitFor('station-closed');
  assert.equal(msg.reason, 'closed');
  await phone.waitFor('raid:kicked');
  assert.equal(s.g.raids.rooms.size, 0);
  assert.equal(s.g.rooms.rooms.size, 0);
  assert.equal((await host.emit('raid:start')).ok, false);
  [anon, wrong, host, host2, phone, rh, ra].forEach((c) => c.close());
});

test('dev mode (no key, not production): pages open, host uses the dev HOST_SECRET', async (t) => {
  const s = await startServer({ server: { stationKey: '', platformApiUrl: '' } });
  t.after(s.close);
  assert.equal(s.g.config.DEV_HOST, true);
  assert.equal((await get(s.base, '/games/raid/')).status, 200);
  const h = sio(s.port, { ns: '/raid' }); await h.ready;
  assert.equal((await h.emit('raid:create', { secret: 'wrong' })).ok, false);
  assert.equal((await h.emit('raid:create', { secret: 'gdg-race' })).ok, true);
  h.close();
});

test('production never falls back to HOST_SECRET', async (t) => {
  const s = await startServer({ server: { stationKey: '', platformApiUrl: '', production: true, hostSecret: 'abc' } });
  t.after(s.close);
  assert.equal(s.g.config.DEV_HOST, false);
  assert.equal((await get(s.base, '/games/raid/')).status, 403);
  const h = sio(s.port, { ns: '/raid' }); await h.ready;
  assert.equal((await h.emit('raid:create', { secret: 'abc' })).ok, false);
  h.close();
});
