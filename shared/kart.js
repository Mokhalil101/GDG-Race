/**
 * CODE KART BATTLE - shared constants. GDG Race + rainbow "?" item boxes.
 * Loaded by the Node server (require) AND by the browser (<script src="../shared/kart.js">, exposes window.KART).
 * Needs shared/game.js (TRACK) first in the browser.
 */
(function (root, factory) {
  var G = typeof module === 'object' && module.exports ? require('./game') : root.GDG;
  var api = factory(G);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KART = api;
})(typeof self !== 'undefined' ? self : this, function (G) {
  'use strict';
  var P = G.TRACK.P;

  // Eight karts: the six GDG Race colours + pink + orange (2-8 players).
  var CARS = G.CARS.concat([
    { id: 7, name: 'Pink', color: '#FF8FB1' },
    { id: 8, name: 'Orange', color: '#FF8A1F' },
  ]);

  var ITEMS = {
    bomb: { id: 'bomb', name: 'Bug Bomb', short: 'Bug bomb', color: '#FFC9C2', hint: 'Hits the kart ahead of you' },
    turbo: { id: 'turbo', name: 'Turbo', short: 'Turbo', color: '#FBBC04', hint: 'A burst of speed' },
    shield: { id: 'shield', name: 'Shield', short: 'Shield', color: '#C7DDFF', hint: 'Blocks the next Bug Bomb or Firewall' },
    firewall: { id: 'firewall', name: 'Firewall', short: 'Firewall', color: '#E6D2FF', hint: 'Blocks the lane behind you' },
  };
  var ITEM_IDS = ['bomb', 'turbo', 'shield', 'firewall'];

  /**
   * Item odds by race position (balance: the leader gets defensive items, the back of the pack gets the strong ones).
   * f = 0 for P1 ... 1 for last place; weights are interpolated linearly between the three rows.
   */
  var ODDS = {
    front: { bomb: 0, turbo: 15, shield: 45, firewall: 40 },
    middle: { bomb: 35, turbo: 25, shield: 20, firewall: 20 },
    back: { bomb: 40, turbo: 45, shield: 15, firewall: 0 },
  };
  function oddsAt(f) {
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    var a = f <= 0.5 ? ODDS.front : ODDS.middle, b = f <= 0.5 ? ODDS.middle : ODDS.back, t = f <= 0.5 ? f * 2 : (f - 0.5) * 2;
    var out = {};
    ITEM_IDS.forEach(function (k) { out[k] = a[k] + (b[k] - a[k]) * t; });
    return out;
  }

  var RULES = {
    MAX_PLAYERS: 8,
    QUESTION_SEC: 5,         // answer on the phone while the kart drives straight
    SPIN_SEC: 2,             // wrong answer / Bug Bomb
    SPIN_FACTOR: 0.2,        // speed while spinning
    WALL_SPIN_SEC: 1.4,      // driving into a Firewall
    TURBO_SEC: 2.5, TURBO_FACTOR: 1.5,
    SHIELD_SEC: 12,          // a shield lasts until it blocks a hit or this runs out
    FIREWALL_SEC: 10, FIREWALL_BACK: 80, FIREWALL_HALF_W: 26, FIREWALL_HALF_L: 10,
    STREAK_TURBO: 3,         // 3 right in a row -> automatic Turbo
    BOX_RESPAWN_SEC: 4,
    BOX_R: 16,
    FEED_MAX: 3,
  };

  // item boxes: 4 rows across the track, 3 lanes each (s = centre-line distance, d = lateral offset)
  var BOXES = [];
  [0.17, 0.41, 0.64, 0.89].forEach(function (f, row) {
    [-52, 0, 52].forEach(function (d, lane) {
      BOXES.push({ i: row * 3 + lane, s: Math.round(f * P), d: d });
    });
  });

  var EV = {
    QUESTION: 'kart:question', ANSWER: 'kart:answer', USE: 'kart:use', YOU: 'kart:you', STATION_CLOSED: 'station-closed',
  };

  /** 8 karts in two rows of four across the start line. */
  function gridSlot(carId) {
    var i = Math.max(0, carId - 1), row = Math.floor(i / 4), col = i % 4;
    return { d: (1.5 - col) * 38, totalS: -40 - row * 64 };
  }

  return { CARS: CARS, ITEMS: ITEMS, ITEM_IDS: ITEM_IDS, ODDS: ODDS, oddsAt: oddsAt, RULES: RULES, BOXES: BOXES, EV: EV, gridSlot: gridSlot };
});
