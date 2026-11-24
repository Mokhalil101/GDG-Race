/**
 * GDG RACE - shared constants, track geometry and helpers.
 * Loaded by the Node server (require) AND by the browser (<script src="/shared/game.js">, exposes window.GDG).
 * SRS refs: 3.2 colours, 3.4 cars, 6.3 track, 8.2 events, 8.5 performance targets, 10.6 centralised config.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GDG = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- Palette (SRS 3.2) ----------
  var COLORS = {
    navy: '#080B1A', blue900: '#111A35', gBlue: '#4285F4', gRed: '#EA4335', gYellow: '#FBBC04',
    gGreen: '#34A853', cyan: '#00E5FF', purple: '#A855F7', white: '#FFFFFF', gray: '#A7B0C0',
  };

  // ---------- Cars (SRS 3.4) - id is also the visible car number ----------
  var CARS = [
    { id: 1, name: 'Blue', color: COLORS.gBlue },
    { id: 2, name: 'Red', color: COLORS.gRed },
    { id: 3, name: 'Yellow', color: COLORS.gYellow },
    { id: 4, name: 'Green', color: COLORS.gGreen },
    { id: 5, name: 'Cyan', color: COLORS.cyan },
    { id: 6, name: 'Purple', color: COLORS.purple },
  ];

  // ---------- Room / race status (SRS 6.8) ----------
  var STATUS = {
    LOBBY: 'lobby', COUNTDOWN: 'countdown', RACING: 'racing', PAUSED: 'paused',
    FINISHED: 'finished', ABORTED: 'aborted',
  };

  // ---------- Socket event names (SRS 8.2 + a few helpers) ----------
  var EVT = {
    CREATE_ROOM: 'create-room', ROOM_CREATED: 'room-created', ROOM_INFO: 'room-info',
    JOIN_ROOM: 'join-room', PLAYER_JOINED: 'player-joined', PLAYER_LEFT: 'player-left',
    SELECT_CAR: 'select-car', CAR_SELECTED: 'car-selected',
    START_COUNTDOWN: 'start-countdown', CANCEL_COUNTDOWN: 'cancel-countdown', COUNTDOWN_UPDATE: 'countdown-update',
    RACE_STARTED: 'race-started', STEER: 'steer', GAME_STATE: 'game-state',
    LEADERBOARD_UPDATE: 'leaderboard-update', PLAYER_FINISHED: 'player-finished', RACE_FINISHED: 'race-finished',
    RECONNECT_PLAYER: 'reconnect-player', CONNECTION_STATUS: 'connection-status',
    PAUSE_RACE: 'pause-race', RESUME_RACE: 'resume-race', ABORT_RACE: 'abort-race',
    // helpers (not in the SRS table but required by FR-009/010/011/012)
    ROOM_UPDATE: 'room-update', REMOVE_PLAYER: 'remove-player', RESET_SESSION: 'reset-session',
    NEW_ROUND: 'new-round', UPDATE_SETTINGS: 'update-settings', REPLACED: 'replaced', KICKED: 'kicked',
  };

  // ---------- Central configuration (SRS 10.6) ----------
  var CONFIG = {
    MAX_PLAYERS: 6,
    COUNTDOWN_SECONDS: 10,
    SIM_HZ: 30,               // server simulation rate (SRS 8.5)
    BROADCAST_HZ: 20,         // game-state while racing (SRS 8.5: 15-30)
    IDLE_BROADCAST_HZ: 4,     // game-state in lobby / countdown / paused
    LEADERBOARD_HZ: 5,
    LOBBY_DISCONNECT_GRACE_SEC: 30,
    DEFAULTS: { laps: 3, collisionPenalty: 0.35, raceTimeoutSec: 180, finishGraceSec: 25, obstacles: true },
    LIMITS: { laps: [1, 10], collisionPenalty: [0, 0.8], raceTimeoutSec: [30, 900], finishGraceSec: [5, 120] },
    CAR: { LENGTH: 46, WIDTH: 26 },
    PHYS: {
      MAX_SPEED: 250,         // px/s along the car's own lane
      ACCEL: 260, BRAKE: 600,
      LAT_SPEED: 130, LAT_ACCEL: 900,
      WALL_FACTOR: 0.75,      // speed factor while scraping the wall
      DISCONNECT_FACTOR: 0.6, // "safe behaviour" of a disconnected car (SRS 12.1)
      GHOST_FACTOR: 0.5,      // victory-lap speed of finished cars
      COLLISION_SLOW_SEC: 0.6,
      OBSTACLE_SLOW_SEC: 0.8, OBSTACLE_FACTOR: 0.45,
      INSIDE_BONUS: 0.5,      // 0 = lane never matters, 1 = full geometric advantage in corners
      STEER_TIMEOUT_SEC: 0.6, // steering auto-releases if the phone goes silent
    },
    NAME: { MIN: 1, MAX: 16 },
    RATE: { STEER_BURST: 40, STEER_PER_SEC: 30 },
  };

  // ---------- Track: one stadium-shaped neon circuit (SRS 6.3) ----------
  // Coordinates are in a 1920x1080 world. The car travels counter-clockwise.
  // s = distance along the centre line (0 = start/finish line on the bottom straight)
  // d = lateral offset from the centre line, + = LEFT of travel direction (inside the corner).
  var TRACK = (function () {
    var cx = 800, cy = 570, Ls = 720, R = 250, W = 190;
    var half = W / 2;
    var A = Ls / 2, B = Math.PI * R, C = Ls, D = Math.PI * R;
    var P = 2 * Ls + 2 * Math.PI * R;

    function centerAt(s) {
      s = ((s % P) + P) % P;
      var a;
      if (s < A) return { x: cx + s, y: cy + R, hx: 1, hy: 0, arc: false };
      s -= A;
      if (s < B) {
        a = Math.PI / 2 - s / R;
        return { x: cx + Ls / 2 + R * Math.cos(a), y: cy + R * Math.sin(a), hx: Math.sin(a), hy: -Math.cos(a), arc: true };
      }
      s -= B;
      if (s < C) return { x: cx + Ls / 2 - s, y: cy - R, hx: -1, hy: 0, arc: false };
      s -= C;
      if (s < D) {
        a = -Math.PI / 2 - s / R;
        return { x: cx - Ls / 2 + R * Math.cos(a), y: cy + R * Math.sin(a), hx: Math.sin(a), hy: -Math.cos(a), arc: true };
      }
      s -= D;
      return { x: cx - Ls / 2 + s, y: cy + R, hx: 1, hy: 0, arc: false };
    }

    /** World position + heading angle (radians, screen coords) of lane offset d at distance s. */
    function pointAt(s, d) {
      var c = centerAt(s);
      return { x: c.x + d * c.hy, y: c.y - d * c.hx, a: Math.atan2(c.hy, c.hx) };
    }

    /** How much centre-line distance one unit of driven distance covers (inside lane is shorter in corners). */
    function progressFactor(s, d, bonus) {
      var c = centerAt(s);
      if (!c.arc) return 1;
      var geo = R / (R - d);
      return 1 + bonus * (geo - 1);
    }

    var usable = half - CONFIG.CAR.WIDTH / 2 - 3; // max |d| for a car centre
    var obstacles = [
      [0.12, -30], [0.22, 36], [0.34, -46], [0.46, 18], [0.57, -22], [0.69, 46], [0.81, -40], [0.92, 26],
    ].map(function (o) { return { s: Math.round(o[0] * P), d: o[1], r: 14 }; });

    return {
      cx: cx, cy: cy, Ls: Ls, R: R, W: W, half: half, P: P, usable: usable,
      centerAt: centerAt, pointAt: pointAt, progressFactor: progressFactor,
      obstacles: obstacles,
      checkpoints: [P * 0.25, P * 0.5, P * 0.75], // + the finish line at s = 0
    };
  })();

  // ---------- Helpers ----------
  /** Strip anything but letters/digits/space/_ . - (Arabic letters are fine), collapse spaces, cap length (SEC-010). */
  function sanitizeName(raw) {
    if (typeof raw !== 'string') return '';
    var s = raw.normalize('NFKC').replace(/[^\p{L}\p{N} _.\-]/gu, '').replace(/\s+/g, ' ').trim();
    return s.slice(0, CONFIG.NAME.MAX);
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function fmtTime(sec) {
    if (sec == null || !isFinite(sec)) return '--:--.-';
    var m = Math.floor(sec / 60), s = sec - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }

  return {
    COLORS: COLORS, CARS: CARS, STATUS: STATUS, EVT: EVT, CONFIG: CONFIG, TRACK: TRACK,
    sanitizeName: sanitizeName, clamp: clamp, fmtTime: fmtTime,
  };
});
