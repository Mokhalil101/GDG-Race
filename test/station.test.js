'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifyToken, signToken, parseCookies, StationStatus } = require('../server/station');

const KEY = 'test-station-key-0123456789-abcdefghijklmnop';
const claims = (extra) => Object.assign({ sub: '7f1c2d3e-0000-4000-8000-000000000001', game: 'raid', evt: 'e-1', day: 1, label: 'Booth 2', by: 'Mona' }, extra);

test('token: a valid token verifies and returns its claims', () => {
  const t = signToken(claims(), KEY);
  const r = verifyToken(t, KEY, { game: 'raid' });
  assert.equal(r.ok, true);
  assert.equal(r.claims.label, 'Booth 2');
  assert.equal(r.claims.iss, 'gdg-platform');
  assert.equal(r.claims.aud, 'gdg-games');
});

test('token: expired is rejected (with clock skew allowance)', () => {
  const now = Date.now();
  const t = signToken(claims(), KEY, { now: now - 3 * 3600e3, ttlSec: 3600 });
  assert.deepEqual(verifyToken(t, KEY, { now }), { ok: false, reason: 'EXPIRED' });
  const edge = signToken(claims(), KEY, { now: now - 3610e3, ttlSec: 3600 }); // expired 10 s ago: inside 30 s skew
  assert.equal(verifyToken(edge, KEY, { now }).ok, true);
});

test('token: bad signature / wrong key / tampered payload are rejected', () => {
  const t = signToken(claims(), KEY);
  assert.equal(verifyToken(t, KEY + 'x').reason, 'SIGNATURE');
  const [h, p, s] = t.split('.');
  const forged = Buffer.from(JSON.stringify(Object.assign(JSON.parse(Buffer.from(p, 'base64url')), { game: 'race' }))).toString('base64url');
  assert.equal(verifyToken(h + '.' + forged + '.' + s, KEY).reason, 'SIGNATURE');
  assert.equal(verifyToken(h + '.' + p + '.' + s.slice(0, -2) + 'AA', KEY).reason, 'SIGNATURE');
  assert.equal(verifyToken('not-a-jwt', KEY).reason, 'MALFORMED');
  assert.equal(verifyToken(null, KEY).reason, 'MALFORMED');
});

test('token: alg none / other algs are rejected', () => {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = enc(Object.assign({ iss: 'gdg-platform', aud: 'gdg-games', exp: Math.floor(Date.now() / 1000) + 600 }, claims()));
  assert.equal(verifyToken(enc({ alg: 'none' }) + '.' + body + '.x', KEY).reason, 'ALG');
  const head = enc({ alg: 'HS512', typ: 'JWT' });
  const sig = crypto.createHmac('sha512', KEY).update(head + '.' + body).digest('base64url');
  assert.equal(verifyToken(head + '.' + body + '.' + sig, KEY).reason, 'ALG');
});

test('token: wrong audience / issuer are rejected', () => {
  assert.equal(verifyToken(signToken(claims({ aud: 'gdg-platform' }), KEY), KEY).reason, 'AUDIENCE');
  assert.equal(verifyToken(signToken(claims({ iss: 'someone-else' }), KEY), KEY).reason, 'ISSUER');
  assert.equal(verifyToken(signToken(claims({ aud: ['x', 'gdg-games'] }), KEY), KEY).ok, true);
});

test('token: wrong / unknown game is rejected', () => {
  const t = signToken(claims({ game: 'race' }), KEY);
  assert.equal(verifyToken(t, KEY, { game: 'raid' }).reason, 'GAME');
  assert.equal(verifyToken(t, KEY, { game: 'race' }).ok, true);
  assert.equal(verifyToken(signToken(claims({ game: 'chess' }), KEY), KEY).reason, 'GAME');
});

test('token: not yet valid (nbf in the future) is rejected', () => {
  const now = Date.now();
  const t = signToken(claims(), KEY, { now: now + 3600e3 });
  assert.equal(verifyToken(t, KEY, { now }).reason, 'NOT_YET');
});

test('cookies: parsing', () => {
  assert.deepEqual(parseCookies('a=1; gdg_station=x.y.z; b=%20q'), { a: '1', gdg_station: 'x.y.z', b: ' q' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('status: caches for the TTL, sends the bearer token, closed is sticky', async () => {
  let calls = 0, open = true, now = 0, auth = null, url = null;
  const fetchImpl = async (u, init) => { calls++; url = u; auth = init.headers.Authorization; return { ok: true, status: 200, json: async () => ({ open, game: 'raid' }) }; };
  const s = new StationStatus({ apiUrl: 'http://platform/', fetchImpl, ttlMs: 30000, now: () => now });
  assert.equal((await s.check('abc', 'TOKEN')).open, true);
  assert.equal(url, 'http://platform/api/game-stations/abc/status');
  assert.equal(auth, 'Bearer TOKEN');
  now = 10000; await s.check('abc', 'TOKEN');
  assert.equal(calls, 1, 'served from cache');
  open = false; now = 31000;
  assert.equal((await s.check('abc', 'TOKEN')).open, false);
  assert.equal(calls, 2);
  open = true; now = 90000;
  assert.equal((await s.check('abc', 'TOKEN')).open, false, 'a closed station stays closed');
});

test('status: 401 = closed; network error keeps the last answer, fails closed without one', async () => {
  let mode = 'ok', now = 0;
  const fetchImpl = async () => {
    if (mode === 'down') throw new Error('ECONNREFUSED');
    if (mode === '401') return { ok: false, status: 401, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ open: true }) };
  };
  const s = new StationStatus({ apiUrl: 'http://p', fetchImpl, now: () => now });
  mode = 'down';
  const first = await s.check('n1', 't');
  assert.deepEqual([first.open, first.known], [false, false]);
  mode = 'ok'; now = 1;
  assert.equal((await s.check('n1', 't', { force: true })).open, true);
  mode = 'down'; now = 60000;
  assert.equal((await s.check('n1', 't')).open, true, 'platform blip keeps the last known state');
  mode = '401'; now = 120000;
  const r = await s.check('n1', 't');
  assert.deepEqual([r.open, r.known], [false, true]);
});
