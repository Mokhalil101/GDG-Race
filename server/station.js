'use strict';
/**
 * Game stations (see the frozen platform <-> games contract).
 *  - verifyToken(): HS256 JWT check with Node's crypto (no JWT dependency): signature, alg, iss, aud, nbf, exp, game.
 *  - StationStatus: asks the platform `GET {PLATFORM_API_URL}/api/game-stations/{sub}/status` with the token as a
 *    Bearer, caches the answer for ~30 s per station and de-duplicates concurrent look-ups.
 *  - cookie helpers for `gdg_station`.
 */
const crypto = require('crypto');

const ISSUER = 'gdg-platform';
const AUDIENCE = 'gdg-games';
const COOKIE = 'gdg_station';
const GAMES = ['code-man', 'codebreaker', 'race', 'kart', 'among', 'raid', 'potato'];
const CLOCK_SKEW_SEC = 30;

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/**
 * @returns {{ok:true, claims:object} | {ok:false, reason:string}}
 * reason: MALFORMED | ALG | SIGNATURE | ISSUER | AUDIENCE | NOT_YET | EXPIRED | GAME | CLAIMS
 */
function verifyToken(token, key, { game = null, now = Date.now() } = {}) {
  if (!key) return { ok: false, reason: 'NO_KEY' };
  if (typeof token !== 'string' || token.length > 4096) return { ok: false, reason: 'MALFORMED' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: 'MALFORMED' };
  let header, claims;
  try { header = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); } catch (e) { return { ok: false, reason: 'MALFORMED' }; }
  if (!header || header.alg !== 'HS256' || (header.typ && header.typ !== 'JWT')) return { ok: false, reason: 'ALG' };
  const expected = crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(parts[0] + '.' + parts[1]).digest();
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: 'SIGNATURE' };
  if (!claims || typeof claims !== 'object') return { ok: false, reason: 'CLAIMS' };
  if (claims.iss !== ISSUER) return { ok: false, reason: 'ISSUER' };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(AUDIENCE)) return { ok: false, reason: 'AUDIENCE' };
  const t = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || t >= claims.exp + CLOCK_SKEW_SEC) return { ok: false, reason: 'EXPIRED' };
  if (typeof claims.nbf === 'number' && t + CLOCK_SKEW_SEC < claims.nbf) return { ok: false, reason: 'NOT_YET' };
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 64) return { ok: false, reason: 'CLAIMS' };
  if (!GAMES.includes(claims.game)) return { ok: false, reason: 'GAME' };
  if (game && claims.game !== game) return { ok: false, reason: 'GAME' };
  return { ok: true, claims };
}

/** Signs a station token. Used by the tests and the local dev minting script; the platform signs the real ones. */
function signToken(claims, key, { now = Date.now(), ttlSec = 3600 } = {}) {
  const iat = Math.floor(now / 1000);
  const body = Object.assign({ iss: ISSUER, aud: AUDIENCE, jti: crypto.randomBytes(8).toString('hex'), iat, nbf: iat, exp: iat + ttlSec }, claims);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'HS256', typ: 'JWT' }) + '.' + enc(body);
  return head + '.' + crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(head).digest('base64url');
}

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function stationCookie(token, { basePath, secure, maxAgeSec }) {
  return COOKIE + '=' + token + '; Path=' + (basePath || '/') + '; HttpOnly; SameSite=Lax' +
    (secure ? '; Secure' : '') + '; Max-Age=' + Math.max(0, Math.floor(maxAgeSec));
}
function clearStationCookie({ basePath, secure }) {
  return COOKIE + '=; Path=' + (basePath || '/') + '; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '') + '; Max-Age=0';
}

/**
 * Station status, cached per station id.
 * check() resolves to { open: bool, known: bool, label?, closesAt?, error? }.
 *  - 200 + open:true  -> open
 *  - 200 + open:false, 401, 403, 404 -> closed (definitive)
 *  - network error / 5xx -> keep the last known answer; with none, report closed + known:false (fail closed)
 */
class StationStatus {
  constructor({ apiUrl, fetchImpl = globalThis.fetch, ttlMs = 30000, timeoutMs = 4000, now = () => Date.now() } = {}) {
    this.apiUrl = (apiUrl || '').replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.cache = new Map(); // sub -> { value, at, inflight }
  }

  /** Remember that a station was just closed (e.g. seen by another check) so pages stop at once. */
  markClosed(sub) { this.cache.set(sub, { value: { open: false, known: true }, at: this.now(), inflight: null }); }

  async check(sub, token, { force = false } = {}) {
    if (!this.apiUrl) return { open: true, known: true, unchecked: true }; // dev only (index.js refuses this in production)
    let e = this.cache.get(sub);
    if (e && e.value && !e.value.open && e.value.known) return e.value; // closed stays closed
    if (e && e.value && !force && this.now() - e.at < this.ttlMs) return e.value;
    if (e && e.inflight) return e.inflight;
    if (!e) { e = { value: null, at: 0, inflight: null }; this.cache.set(sub, e); }
    e.inflight = this._fetch(sub, token).then((value) => {
      if (value.known || !e.value) { e.value = value; e.at = this.now(); }
      e.inflight = null;
      return e.value;
    });
    return e.inflight;
  }

  async _fetch(sub, token) {
    const url = this.apiUrl + '/api/game-stations/' + encodeURIComponent(sub) + '/status';
    let timer;
    try {
      const ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      const res = await this.fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, signal: ctrl.signal });
      if (res.status === 401 || res.status === 403 || res.status === 404) return { open: false, known: true };
      if (!res.ok) return { open: false, known: false, error: 'HTTP ' + res.status };
      const body = await res.json();
      return { open: body && body.open === true, known: true, label: body && body.label, closesAt: body && body.closesAt };
    } catch (err) {
      return { open: false, known: false, error: String(err && err.message || err) };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = {
  ISSUER, AUDIENCE, COOKIE, GAMES, verifyToken, signToken, parseCookies, stationCookie, clearStationCookie, StationStatus,
};
