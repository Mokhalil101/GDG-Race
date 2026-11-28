'use strict';
/**
 * GDG Games server entry point (GDG Race, Boss Raid, Code Kart Battle, Hot Potato Code, Among Bugs, and the static Code-Man / CodeBreaker builds).
 * Env:
 *   PORT (3000), NODE_ENV, BASE_PATH (/games), PUBLIC_URL (public origin used in QR codes, e.g. https://gdg.example)
 *   GAMES_STATION_KEY   HS256 key shared with the platform (Games:StationSigningKey). REQUIRED in production.
 *   PLATFORM_API_URL    platform backend, e.g. http://backend:8080 (station status checks). REQUIRED in production.
 *   STATIONS_URL        "Registration Team? sign in" link on the Hold on page (default: PUBLIC_URL + /)
 *   CODEMAN_DIR / CODEBREAKER_DIR  static builds (default: the sibling ../Code-Man and ../CodeBreaker folders)
 *   HOST_SECRET         dev only: host key used when there is no GAMES_STATION_KEY and NODE_ENV != production
 *   FORCE_HTTPS=1       redirect http -> https behind a TLS proxy
 */
const { createGamesServer } = require('./app');

const PROD = process.env.NODE_ENV === 'production';
const KEY = process.env.GAMES_STATION_KEY || '';
const API = process.env.PLATFORM_API_URL || '';

if (PROD && !KEY) { console.error('GAMES_STATION_KEY must be set when NODE_ENV=production.'); process.exit(1); }
if (PROD && !API) { console.error('PLATFORM_API_URL must be set when NODE_ENV=production.'); process.exit(1); }
if (KEY && Buffer.byteLength(KEY) < 32) console.warn('[warn] GAMES_STATION_KEY is shorter than 32 bytes; the platform will refuse it.');
if (!KEY) {
  const bar = '!'.repeat(78);
  console.warn('\n' + bar + '\n  DEVELOPMENT MODE: GAMES_STATION_KEY is not set.\n  Game pages are NOT gated by stations and hosts log in with the dev HOST_SECRET' +
    (process.env.HOST_SECRET ? ' (from env).' : ' "gdg-race".') + '\n  Never run like this at an event.\n' + bar + '\n');
}
if (KEY && !API) console.warn('[warn] PLATFORM_API_URL is not set: station status is NOT checked with the platform (dev only).');

const g = createGamesServer({
  port: Number(process.env.PORT) || 3000,
  production: PROD,
  basePath: process.env.BASE_PATH != null ? process.env.BASE_PATH : '/games',
  publicUrl: process.env.PUBLIC_URL || '',
  stationKey: KEY,
  platformApiUrl: API,
  hostSecret: process.env.HOST_SECRET || '',
  signInUrl: process.env.STATIONS_URL,
  codeManDir: process.env.CODEMAN_DIR,
  codeBreakerDir: process.env.CODEBREAKER_DIR,
  forceHttps: process.env.FORCE_HTTPS === '1',
});
g.start();

const PORT = Number(process.env.PORT) || 3000;
g.server.listen(PORT, () => {
  const base = g.config.BASE;
  console.log('\n  GDG Games server');
  console.log('  GDG Race    :  http://localhost:' + PORT + base + '/race/');
  console.log('  Boss Raid   :  http://localhost:' + PORT + base + '/raid/');
  console.log('  Code Kart   :  http://localhost:' + PORT + base + '/kart/');
  console.log('  Hot Potato  :  http://localhost:' + PORT + base + '/potato/');
  console.log('  Among Bugs  :  http://localhost:' + PORT + base + '/among/');
  console.log('  Code-Man    :  http://localhost:' + PORT + base + '/code-man/');
  console.log('  CodeBreaker :  http://localhost:' + PORT + base + '/codebreaker/');
  console.log('  Stations    :  ' + (g.config.DEV_HOST ? 'OFF (dev host key)' : 'ON - open games via ' + base + '/launch?t=<station token>'));
  const ips = g.lanIPs();
  if (ips.length) console.log('  On your Wi-Fi (used in QR): http://' + ips[0] + ':' + PORT + base + '/');
  if (g.config.PUBLIC_ORIGIN) console.log('  PUBLIC_URL  :  ' + g.config.PUBLIC_ORIGIN + base + '  (used in QR codes)');
  console.log('');
});

module.exports = g;
