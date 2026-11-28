/* CODE KART BATTLE - Host display. Same stage, lobby and results as GDG Race (host.js); Phaser draws the kart track,
   rainbow ? boxes, items and effects; the DOM draws the RACERS · ITEMS panel and the live feed. */
(function () {
  'use strict';
  var TRACK = GDG.TRACK, EVT = GDG.EVT, STATUS = GDG.STATUS, fmtTime = GDG.fmtTime;
  var CARS = KART.CARS, ITEMS = KART.ITEMS, BOXES = KART.BOXES, RULES = KART.RULES;
  var $ = function (id) { return document.getElementById(id); };
  // the server lives under a sub-path (e.g. /games); this page is <base>/kart/
  var BASE = location.pathname.replace(/\/kart(\/.*)?$/, '');
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  // ---------- stage scaling: fixed 1920x1080 stage scaled to the window ----------
  var stage = $('stage');
  function fit() {
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stage.style.transform = 'translate(-50%, -50%) scale(' + s + ')';
  }
  window.addEventListener('resize', fit); fit();

  // ---------- full screen (first click / key press; Esc is respected; F or double-click toggles) ----------
  var fsDeclined = false;
  function enterFullscreen() {
    var d = document.documentElement;
    if (document.fullscreenElement || !d.requestFullscreen) return;
    try { var p = d.requestFullscreen({ navigationUI: 'hide' }); if (p && p.catch) p.catch(function () { /* refused */ }); } catch (e) { /* unsupported */ }
  }
  function autoFullscreen() { if (!fsDeclined) enterFullscreen(); }
  function toggleFullscreen() {
    if (document.fullscreenElement) { fsDeclined = true; document.exitFullscreen(); } else { fsDeclined = false; enterFullscreen(); }
  }
  document.addEventListener('fullscreenchange', function () {
    if (!document.fullscreenElement) fsDeclined = true;
    fit(); setTimeout(fit, 120); wakeCursor();
  });
  window.addEventListener('pointerdown', autoFullscreen, { once: true });
  window.addEventListener('keydown', autoFullscreen, { once: true });
  window.addEventListener('dblclick', function (e) { if (!e.target.closest('button, input, select')) toggleFullscreen(); });
  var cursorTimer = null;
  function wakeCursor() {
    document.body.classList.remove('idle'); clearTimeout(cursorTimer);
    cursorTimer = setTimeout(function () { if (document.fullscreenElement) document.body.classList.add('idle'); }, 3000);
  }
  window.addEventListener('mousemove', wakeCursor); wakeCursor();

  // ---------- branding ----------
  function renderBrand(node) {
    node.innerHTML = '<span class="dots"><i></i><i></i><i></i><i></i></span><span>GDG ASSIUT</span>';
    var img = new Image();
    img.onload = function () { node.innerHTML = ''; node.appendChild(img); };
    img.alt = 'GDG Assiut';
    img.src = BASE + '/assets/logo.png';
  }
  ['brand-lobby', 'brand-hud', 'brand-results'].forEach(function (id) { renderBrand($(id)); });

  // lobby legend: the four items
  (function () {
    var box = $('lobby-items');
    KART.ITEM_IDS.forEach(function (k) { var s = el('span', 'k-pill', ITEMS[k].name); s.style.setProperty('--c', ITEMS[k].color); box.appendChild(s); });
  })();

  // ---------- sound (WebAudio synth) ----------
  var audio = {
    ctx: null, muted: localStorage.getItem('gdg_muted') === '1',
    ensure: function () {
      if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* no audio */ } }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },
    tone: function (freq, dur, type, vol, delay) {
      if (this.muted || !this.ctx) return;
      var t = this.ctx.currentTime + (delay || 0), o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = type || 'square'; o.frequency.value = freq;
      g.gain.setValueAtTime(vol || 0.1, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(this.ctx.destination); o.start(t); o.stop(t + dur + 0.02);
    },
    noise: function (dur, vol) {
      if (this.muted || !this.ctx) return;
      var n = Math.floor(this.ctx.sampleRate * dur), b = this.ctx.createBuffer(1, n, this.ctx.sampleRate), d = b.getChannelData(0);
      for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      var s = this.ctx.createBufferSource(), g = this.ctx.createGain();
      g.gain.value = vol || 0.2; s.buffer = b; s.connect(g); g.connect(this.ctx.destination); s.start();
    },
    count: function (v) { this.tone(v <= 3 ? 700 : 440, 0.14, 'square', 0.12); },
    go: function () { this.tone(1000, 0.6, 'square', 0.12); this.tone(1500, 0.6, 'sawtooth', 0.06); },
    crash: function () { this.noise(0.18, 0.28); this.tone(110, 0.18, 'sawtooth', 0.14); },
    boom: function () { this.noise(0.45, 0.4); this.tone(70, 0.4, 'sawtooth', 0.18); },
    pickup: function () { [660, 880, 1100].forEach(function (f, i) { audio.tone(f, 0.08, 'triangle', 0.1, i * 0.05); }); },
    item: function () { this.tone(988, 0.08, 'square', 0.08); this.tone(1318, 0.2, 'square', 0.08, 0.08); },
    wrong: function () { this.tone(300, 0.12, 'sawtooth', 0.1); this.tone(200, 0.3, 'sawtooth', 0.1, 0.12); },
    turbo: function () { for (var i = 0; i < 6; i++) audio.tone(300 + i * 120, 0.08, 'sawtooth', 0.07, i * 0.04); },
    shield: function () { this.tone(520, 0.3, 'sine', 0.12); this.tone(780, 0.3, 'sine', 0.08, 0.06); },
    lap: function () { this.tone(784, 0.1, 'triangle', 0.12); this.tone(1046, 0.16, 'triangle', 0.12, 0.1); },
    join: function () { this.tone(660, 0.1, 'triangle', 0.1); this.tone(880, 0.14, 'triangle', 0.1, 0.1); },
    fanfare: function () { [523, 659, 784, 1046, 784, 1046, 1318].forEach(function (f, i) { audio.tone(f, 0.22, 'triangle', 0.13, i * 0.14); }); },
  };
  ['click', 'keydown', 'touchstart'].forEach(function (ev) { window.addEventListener(ev, function () { audio.ensure(); }, { passive: true }); });
  function renderMute() { $('mute-label').textContent = audio.muted ? 'off' : 'on'; }
  renderMute();

  // ---------- state ----------
  var socket = io('/kart', { path: BASE + '/socket.io', transports: ['websocket', 'polling'] });
  var mode = null;
  var room = null, joinUrl = '', qr = '', snapshot = null, board = null, scene = null, prevStatus = null;
  var abortArmed = null;

  function playerOf(id) {
    if (!room) return null;
    for (var i = 0; i < room.players.length; i++) if (room.players[i].id === id) return room.players[i];
    return null;
  }
  function nameOf(id) { var p = playerOf(id); return p ? p.name : ''; }

  // ---------- canvas painting ----------
  var INK = '#1B1340', INKN = 0x1b1340, CREAM = '#FFF6E0', FONT = '"Baloo 2", "Segoe UI", system-ui, sans-serif';
  var RM = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var TEX = 2;
  var GDG4 = ['#4285F4', '#EA4335', '#FBBC04', '#34A853'];

  function rnd(i, m) { return (((Math.sin(i * 91.7) * 43758.5453) % 1) + 1) % 1 * m; }
  function rrect(ctx, x, y, w, h, r) {
    var rr = Array.isArray(r) ? r : [r, r, r, r];
    ctx.beginPath();
    ctx.moveTo(x + rr[0], y); ctx.lineTo(x + w - rr[1], y); ctx.quadraticCurveTo(x + w, y, x + w, y + rr[1]);
    ctx.lineTo(x + w, y + h - rr[2]); ctx.quadraticCurveTo(x + w, y + h, x + w - rr[2], y + h);
    ctx.lineTo(x + rr[3], y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - rr[3]);
    ctx.lineTo(x, y + rr[0]); ctx.quadraticCurveTo(x, y, x + rr[0], y); ctx.closePath();
  }
  function stadium(ctx, r, dy) {
    var x1 = TRACK.cx - TRACK.Ls / 2, x2 = TRACK.cx + TRACK.Ls / 2, y = TRACK.cy + (dy || 0);
    ctx.beginPath(); ctx.moveTo(x1, y - r); ctx.lineTo(x2, y - r);
    ctx.arc(x2, y, r, -Math.PI / 2, Math.PI / 2); ctx.lineTo(x1, y + r);
    ctx.arc(x1, y, r, Math.PI / 2, Math.PI * 1.5); ctx.closePath();
  }
  function outlinedText(ctx, text, x, y, size, fill, stroke, drop) {
    ctx.font = '800 ' + size + 'px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    ctx.lineWidth = stroke; ctx.strokeStyle = INK;
    if (drop) { ctx.fillStyle = INK; ctx.strokeText(text, x, y + drop); ctx.fillText(text, x, y + drop); }
    ctx.strokeText(text, x, y); ctx.fillStyle = fill; ctx.fillText(text, x, y);
  }

  function paintTrack(ctx) {
    var T = TRACK, half = T.half, R = T.R, i, x;
    for (x = 0, i = 0; x < 1920; x += 96, i++) { ctx.fillStyle = i % 2 ? '#4FB85E' : '#5CC46A'; ctx.fillRect(x, 0, 96, 1080); }
    [[70, 1010, 46], [140, 1052, 38], [30, 930, 34], [1590, 1010, 34], [1290, 1040, 30], [40, 300, 30]].forEach(function (b) {
      ctx.fillStyle = 'rgba(27,19,64,.25)'; ctx.beginPath(); ctx.ellipse(b[0], b[1] + b[2] * 0.7, b[2], b[2] * 0.35, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2E9C48'; ctx.strokeStyle = INK; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(b[0] - b[2] * 0.45, b[1] + 4, b[2] * 0.62, 0, Math.PI * 2); ctx.arc(b[0] + b[2] * 0.45, b[1] + 4, b[2] * 0.62, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(b[0], b[1] - b[2] * 0.2, b[2] * 0.7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.beginPath(); ctx.arc(b[0] - b[2] * 0.2, b[1] - b[2] * 0.4, b[2] * 0.22, 0, Math.PI * 2); ctx.fill();
    });
    // track: shadow, outer kerb, asphalt, inner kerb, infield
    ctx.fillStyle = 'rgba(27,19,64,.3)'; stadium(ctx, R + half + 24, 14); ctx.fill();
    ctx.fillStyle = INK; stadium(ctx, R + half + 24); ctx.fill();
    ctx.fillStyle = '#fff'; stadium(ctx, R + half + 19); ctx.fill();
    ctx.save(); ctx.strokeStyle = '#EA4335'; ctx.lineWidth = 16; ctx.setLineDash([28, 28]); stadium(ctx, R + half + 11); ctx.stroke(); ctx.restore();
    ctx.fillStyle = INK; stadium(ctx, R + half + 4); ctx.fill();
    ctx.fillStyle = '#4A4F63'; stadium(ctx, R + half); ctx.fill();
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = half; stadium(ctx, R + half / 2); ctx.stroke(); ctx.restore();
    ctx.save(); ctx.strokeStyle = 'rgba(255,246,224,.55)'; ctx.lineWidth = 5; ctx.setLineDash([34, 30]); stadium(ctx, R); ctx.stroke(); ctx.restore();
    ctx.fillStyle = INK; stadium(ctx, R - half); ctx.fill();
    ctx.fillStyle = '#fff'; stadium(ctx, R - half - 4); ctx.fill();
    ctx.save(); ctx.strokeStyle = '#EA4335'; ctx.lineWidth = 16; ctx.setLineDash([24, 24]); stadium(ctx, R - half - 12); ctx.stroke(); ctx.restore();
    ctx.fillStyle = INK; stadium(ctx, R - half - 20); ctx.fill();
    ctx.save(); stadium(ctx, R - half - 25); ctx.clip();
    for (x = 0, i = 0; x < 1920; x += 64, i++) { ctx.fillStyle = i % 2 ? '#4FB85E' : '#5CC46A'; ctx.fillRect(x, 0, 64, 1080); }
    ctx.restore();
    // infield title
    ctx.save(); ctx.translate(T.cx, T.cy - 6); ctx.rotate(-4 * Math.PI / 180);
    outlinedText(ctx, 'KART', 0, -56, 112, '#FBBC04', 14, 12);
    outlinedText(ctx, 'BATTLE!', 0, 50, 112, CREAM, 14, 12);
    ctx.restore();
    // start / finish chequer
    var y0 = T.cy + R - half, rows = 14, sq = T.W / rows, x0 = T.cx - sq;
    for (var r2 = 0; r2 < rows; r2++) for (var c2 = 0; c2 < 2; c2++) { ctx.fillStyle = (r2 + c2) % 2 ? INK : '#fff'; ctx.fillRect(x0 + c2 * sq, y0 + r2 * sq, sq, sq); }
    ctx.fillStyle = INK; ctx.fillRect(x0 - 4, y0, 4, T.W); ctx.fillRect(x0 + 2 * sq, y0, 4, T.W);
    ctx.fillStyle = INK; rrect(ctx, T.cx - 44, y0 + T.W + 30, 9, 100, 4); ctx.fill();
    ctx.beginPath(); ctx.arc(T.cx - 39.5, y0 + T.W + 30, 8, 0, Math.PI * 2); ctx.fillStyle = '#FBBC04'; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = INK; ctx.stroke();
  }

  function paintCar(ctx, color, n) {
    var s = TEX; ctx.save(); ctx.scale(s, s);
    var bx = 6, by = 7, bw = 52, bh = 28, rad = [10, 14, 14, 10];
    ctx.fillStyle = 'rgba(27,19,64,.35)'; rrect(ctx, bx, by + 5, bw, bh, rad); ctx.fill();
    ctx.fillStyle = INK;
    [[11, 3], [11, 32], [38, 3], [38, 32]].forEach(function (w) { rrect(ctx, w[0], w[1], 14, 8, 3); ctx.fill(); });
    ctx.save(); rrect(ctx, bx, by, bw, bh, rad); ctx.clip();
    ctx.fillStyle = color; ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fillRect(bx, by + bh - 6, bw, 6);
    ctx.fillStyle = 'rgba(255,255,255,.3)'; ctx.fillRect(bx, by, bw, 5);
    ctx.restore();
    ctx.lineWidth = 3.5; ctx.strokeStyle = INK; rrect(ctx, bx, by, bw, bh, rad); ctx.stroke();
    ctx.fillStyle = '#C7ECFF'; rrect(ctx, 34, 12, 11, 18, 4); ctx.fill(); ctx.lineWidth = 2.6; ctx.stroke();
    ctx.beginPath(); ctx.arc(19, 21, 8.5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 2.4; ctx.stroke();
    ctx.fillStyle = INK; ctx.font = '800 12px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(n), 19, 22.5);
    ctx.restore();
  }

  /** Rainbow "?" item box, 54x54 at 1x (46 px box + shadow). Quarters in the four Google colours, like the mockup. */
  function paintBox(ctx) {
    var s = TEX; ctx.save(); ctx.scale(s, s);
    var x = 4, y = 2, w = 46, r = 12, cx = x + w / 2, cy = y + w / 2;
    ctx.fillStyle = 'rgba(27,19,64,.5)'; rrect(ctx, x, y + 5, w, w, r); ctx.fill();
    ctx.save(); rrect(ctx, x, y, w, w, r); ctx.clip();
    for (var q = 0; q < 4; q++) {
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, 40, -Math.PI / 2 + q * Math.PI / 2, q * Math.PI / 2); ctx.closePath();
      ctx.fillStyle = GDG4[q]; ctx.fill();
    }
    ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(255,255,255,.5)'; rrect(ctx, x, y, w, w, r); ctx.stroke();
    ctx.restore();
    ctx.lineWidth = 4; ctx.strokeStyle = INK; rrect(ctx, x, y, w, w, r); ctx.stroke();
    ctx.font = '800 30px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    ctx.lineWidth = 5; ctx.strokeStyle = INK; ctx.strokeText('?', cx, cy + 3); ctx.fillStyle = '#fff'; ctx.fillText('?', cx, cy + 3);
    ctx.restore();
  }

  /** Firewall: a red brick wall with flames, 64x34 at 1x, long side = x. */
  function paintWall(ctx) {
    var s = TEX; ctx.save(); ctx.scale(s, s);
    // flames
    [[10, 0], [24, -2], [38, 0], [52, -1]].forEach(function (f, i) {
      ctx.beginPath(); ctx.moveTo(f[0] - 7, 14); ctx.quadraticCurveTo(f[0] - 6, 4 + f[1], f[0], 2 + f[1]); ctx.quadraticCurveTo(f[0] + 6, 6 + f[1], f[0] + 7, 14); ctx.closePath();
      ctx.fillStyle = i % 2 ? '#FBBC04' : '#FF8A1F'; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = INK; ctx.stroke();
    });
    ctx.fillStyle = 'rgba(27,19,64,.4)'; rrect(ctx, 3, 15, 58, 18, 4); ctx.fill();
    ctx.fillStyle = '#EA4335'; rrect(ctx, 3, 11, 58, 18, 4); ctx.fill();
    ctx.strokeStyle = '#FFD1C9'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(4, 20); ctx.lineTo(60, 20); ctx.stroke();
    [17, 31, 45].forEach(function (bx) { ctx.beginPath(); ctx.moveTo(bx, 12); ctx.lineTo(bx, 20); ctx.stroke(); });
    [10, 24, 38, 52].forEach(function (bx) { ctx.beginPath(); ctx.moveTo(bx, 20); ctx.lineTo(bx, 28); ctx.stroke(); });
    ctx.lineWidth = 3; ctx.strokeStyle = INK; rrect(ctx, 3, 11, 58, 18, 4); ctx.stroke();
    ctx.restore();
  }

  /** Bug Bomb explosion: the starburst from the mockup, 150x150 at 1x. */
  function paintBoom(ctx) {
    var s = TEX * 1.5; ctx.save(); ctx.scale(s, s); ctx.lineJoin = 'round';
    var outer = new Path2D('M50 4l9 20 20-12-6 22 22 4-18 14 16 16-22-2 2 22-17-14-12 18-5-21-21 8 10-20-20-8 21-8-12-19 21 5z');
    var inner = new Path2D('M50 26l5 12 12-5-4 12 12 4-11 7 8 10-13-2 0 13-9-9-8 10-2-13-13 4 6-12-12-6 13-4-6-12 12 4z');
    ctx.fillStyle = '#FBBC04'; ctx.fill(outer); ctx.lineWidth = 4; ctx.strokeStyle = INK; ctx.stroke(outer);
    ctx.fillStyle = '#EA4335'; ctx.fill(inner);
    ctx.restore();
  }

  /** Turbo flame, 48x24 at 1x, drawn behind the kart (origin left). */
  function paintFlame(ctx) {
    var s = TEX; ctx.save(); ctx.scale(s, s);
    var g = ctx.createLinearGradient(2, 0, 46, 0); g.addColorStop(0, '#FBBC04'); g.addColorStop(1, '#EA4335');
    rrect(ctx, 2, 3, 44, 18, [2, 9, 9, 2]); ctx.fillStyle = g; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = INK; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.55)'; rrect(ctx, 5, 7, 18, 5, 2.5); ctx.fill();
    ctx.restore();
  }

  /** Bug bomb projectile (round bug-bomb with a fuse), 30x30 at 1x. */
  function paintBomb(ctx) {
    var s = TEX; ctx.save(); ctx.scale(s, s);
    ctx.beginPath(); ctx.arc(13, 17, 10, 0, Math.PI * 2); ctx.fillStyle = INK; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = CREAM; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(19, 10); ctx.lineTo(24, 5); ctx.lineWidth = 3; ctx.strokeStyle = '#FBBC04'; ctx.lineCap = 'round'; ctx.stroke();
    ctx.beginPath(); ctx.arc(25.5, 4, 3, 0, Math.PI * 2); ctx.fillStyle = '#EA4335'; ctx.fill();
    ctx.beginPath(); ctx.arc(9.5, 13.5, 2.5, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.fill();
    ctx.restore();
  }

  function canvasTexture(sc, key, w, h, paint) {
    if (sc.textures.exists(key)) sc.textures.remove(key);
    var t = sc.textures.createCanvas(key, w, h);
    paint(t.getContext());
    t.refresh();
    return t;
  }

  var KartScene = new Phaser.Class({
    Extends: Phaser.Scene,
    initialize: function KartScene() { Phaser.Scene.call(this, { key: 'kart' }); },

    create: function () {
      this.cars = {}; this.walls = {};
      this.lastTrail = 0;
      canvasTexture(this, 'track', 1920, 1080, paintTrack);
      this.add.image(0, 0, 'track').setOrigin(0, 0).setDepth(0);
      CARS.forEach(function (car) { canvasTexture(this, 'car' + car.id, 64 * TEX, 44 * TEX, function (ctx) { paintCar(ctx, car.color, car.id); }); }, this);
      canvasTexture(this, 'box', 54 * TEX, 54 * TEX, paintBox);
      canvasTexture(this, 'wall', 64 * TEX, 34 * TEX, paintWall);
      canvasTexture(this, 'boom', 150 * TEX, 150 * TEX, paintBoom);
      canvasTexture(this, 'flame', 48 * TEX, 24 * TEX, paintFlame);
      canvasTexture(this, 'bomb', 30 * TEX, 30 * TEX, paintBomb);
      this.cones = TRACK.obstacles.map(function (o) {
        var p = TRACK.pointAt(o.s, o.d);
        var c = this.add.circle(p.x, p.y, 14, 0xf4511e).setStrokeStyle(3.5, INKN).setDepth(3);
        return c;
      }, this);
      this.makeBoxes();
      scene = this;
      if (snapshot) this.applyState(snapshot);
      this.syncCones();
    },

    makeBoxes: function () {
      var self = this;
      this.boxes = BOXES.map(function (b, i) {
        var p = TRACK.pointAt(b.s, b.d);
        var img = self.add.image(p.x, p.y, 'box').setScale(1 / TEX).setDepth(4).setAngle(12);
        if (!RM) self.tweens.add({ targets: img, angle: -8, y: p.y - 5, duration: 800 + i * 70, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
        return { img: img, x: p.x, y: p.y, on: true };
      });
    },

    syncCones: function () {
      var on = !!(room && room.settings.obstacles);
      this.cones.forEach(function (c) { c.setVisible(on); });
    },

    setBox: function (i, on) {
      var b = this.boxes[i]; if (!b || b.on === !!on) return;
      b.on = !!on;
      if (on) { b.img.setVisible(true).setScale(0.2 / TEX); if (!RM) this.tweens.add({ targets: b.img, scale: 1 / TEX, duration: 300, ease: 'Back.easeOut' }); else b.img.setScale(1 / TEX); }
      else { this.rainbowBurst(b.x, b.y); b.img.setVisible(false); }
    },

    makeCar: function (data) {
      var sprite = this.add.image(data.x, data.y, 'car' + data.n).setDepth(6).setRotation(data.a).setScale(1 / TEX);
      var flame = this.add.image(data.x, data.y, 'flame').setOrigin(0, 0.5).setScale(1 / TEX).setDepth(5).setVisible(false);
      var shield = this.add.container(data.x, data.y, [
        this.add.circle(0, 0, 44, 0x4285f4, 0.28).setStrokeStyle(5, 0x4285f4),
        this.add.circle(0, 0, 44).setStrokeStyle(2.5, INKN, 0.6),
        this.add.ellipse(-18, -22, 18, 9, 0xffffff, 0.7).setAngle(-35),
      ]).setDepth(7).setVisible(false);
      var star = function (x, y, c) { return this.add.star(x, y, 5, 4.5, 10, c).setStrokeStyle(2.5, INKN); }.bind(this);
      var stars = this.add.container(data.x, data.y, [star(-20, 2, 0xfbbc04), star(0, -6, 0xffffff), star(20, 2, 0xfbbc04)]).setDepth(13).setVisible(false);
      var ask = this.add.image(data.x, data.y, 'box').setScale(0.6 / TEX).setDepth(13).setVisible(false);
      var text = this.add.text(0, 1, '', { fontFamily: FONT, fontSize: '19px', fontStyle: '800', color: INK, padding: { top: 4, bottom: 0 } }).setOrigin(0.5).setResolution(2);
      var bg = this.add.graphics();
      var tag = this.add.container(data.x, data.y - 40, [bg, text]).setDepth(12);
      var e = { sprite: sprite, flame: flame, shield: shield, stars: stars, ask: ask, tag: tag, tagBg: bg, tagText: text, tagW: 40,
        n: data.n, x: data.x, y: data.y, a: data.a, tx: data.x, ty: data.y, ta: data.a, spinA: 0, name: null };
      this.cars[data.id] = e;
      return e;
    },

    drawTag: function (e) {
      var w = Math.max(28, Math.ceil(e.tagText.width)) + 18, h = 26;
      e.tagW = w;
      e.tagBg.clear();
      e.tagBg.fillStyle(INKN, 0.35); e.tagBg.fillRoundedRect(-w / 2, -h / 2 + 3, w, h, h / 2);
      e.tagBg.fillStyle(0xfff6e0, 1); e.tagBg.fillRoundedRect(-w / 2, -h / 2, w, h, h / 2);
      e.tagBg.lineStyle(3, INKN, 1); e.tagBg.strokeRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    },

    applyState: function (s) {
      var seen = {}, self = this;
      s.cars.forEach(function (car) {
        var e = self.cars[car.id] || self.makeCar(car);
        if (e.n !== car.n) { e.n = car.n; e.sprite.setTexture('car' + car.n); }
        e.tx = car.x; e.ty = car.y; e.ta = car.a; e.fin = car.fin; e.off = car.off; e.slow = car.slow; e.spd = car.spd; e.dnf = car.dnf;
        e.spin = car.spin; e.boost = car.boost; e.shieldOn = car.shield; e.asking = car.ask;
        seen[car.id] = true;
      });
      Object.keys(this.cars).forEach(function (id) {
        if (!seen[id]) { var e = self.cars[id]; [e.sprite, e.flame, e.shield, e.stars, e.ask, e.tag].forEach(function (o) { o.destroy(); }); delete self.cars[id]; }
      });
      if (s.boxes) s.boxes.forEach(function (on, i) { self.setBox(i, on); });
      var wseen = {};
      (s.walls || []).forEach(function (w) {
        wseen[w.id] = true;
        var img = self.walls[w.id];
        if (!img) {
          img = self.walls[w.id] = self.add.image(w.x, w.y, 'wall').setScale(0.2 / TEX).setDepth(4).setRotation(w.a + Math.PI / 2);
          if (!RM) self.tweens.add({ targets: img, scale: 1 / TEX, duration: 260, ease: 'Back.easeOut' }); else img.setScale(1 / TEX);
        }
        img.setAlpha(w.left < 1.5 ? 0.4 + 0.4 * Math.abs(Math.sin(Date.now() / 120)) : 1);
      });
      Object.keys(this.walls).forEach(function (id) { if (!wseen[id]) { self.walls[id].destroy(); delete self.walls[id]; } });
    },

    refreshNames: function () {
      var self = this;
      Object.keys(this.cars).forEach(function (id) {
        var e = self.cars[id], nm = nameOf(id);
        if (e.name !== nm) { e.name = nm; e.tagText.setText(nm); e.tag.setVisible(!!nm); self.drawTag(e); }
      });
    },

    fx: function (events) {
      var self = this;
      events.forEach(function (ev) {
        var car = ev.id && self.cars[ev.id];
        if (ev.type === 'collision') { self.spark(ev.x, ev.y, 0xffffff); self.spark(ev.x, ev.y, 0xfbbc04); audio.crash(); }
        else if (ev.type === 'lap' && car) { self.floatText(car.x, car.y - 60, 'LAP ' + (ev.lap + 1) + '!', '#FBBC04'); audio.lap(); }
        else if (ev.type === 'finish' && car) { self.floatText(car.x, car.y - 60, 'FINISH! P' + ev.pos, '#34A853'); self.spark(car.x, car.y, 0x34a853); audio.lap(); }
        else if (ev.type === 'pickup') { audio.pickup(); }
        else if (ev.type === 'gotItem' && car) { self.floatText(car.x, car.y - 64, ITEMS[ev.item].name.toUpperCase() + '!', '#FFF6E0'); audio.item(); }
        else if (ev.type === 'wrong' && car) { self.floatText(car.x, car.y - 64, 'SPIN OUT!', '#FF8FB1'); audio.wrong(); }
        else if (ev.type === 'timeout' && car) { self.floatText(car.x, car.y - 64, 'TOO SLOW', '#C9CED6', 28); }
        else if ((ev.type === 'turbo' || ev.type === 'streakTurbo') && car) { self.floatText(car.x, car.y - 64, ev.type === 'streakTurbo' ? '3 IN A ROW · TURBO!' : 'TURBO!', '#FBBC04'); audio.turbo(); }
        else if (ev.type === 'shield' && car) { self.floatText(car.x, car.y - 64, 'SHIELD!', '#9EC2FF'); audio.shield(); }
        else if (ev.type === 'blocked' && car) { self.ring(car.x, car.y, 0x4285f4); self.floatText(car.x, car.y - 64, 'BLOCKED!', '#9EC2FF'); audio.shield(); }
        else if (ev.type === 'bomb' && car) {
          var t = ev.target && self.cars[ev.target];
          if (t) self.throwBomb(car, t, !ev.blocked); else self.floatText(car.x, car.y - 64, 'FIZZLE…', '#C9CED6', 28);
        }
        else if (ev.type === 'wallHit') { self.spark(ev.x, ev.y, 0xea4335); self.spark(ev.x, ev.y, 0xfbbc04); if (!RM) self.cameras.main.shake(140, 0.003); audio.boom(); }
        else if (ev.type === 'obstacle') { var c = self.cones[ev.idx]; if (c) self.spark(c.x, c.y, 0xff7043); }
      });
    },

    throwBomb: function (from, to, hit) {
      var self = this, b = this.add.image(from.x, from.y, 'bomb').setScale(1 / TEX).setDepth(25);
      var done = function () {
        b.destroy();
        if (hit) self.boom(to.x, to.y); else self.ring(to.x, to.y, 0x4285f4);
      };
      if (RM) { done(); return; }
      this.tweens.add({ targets: b, x: to.x, y: to.y, angle: 540, duration: 380, ease: 'Quad.easeIn', onComplete: done });
      this.tweens.add({ targets: b, scale: 1.6 / TEX, duration: 190, yoyo: true });
    },

    boom: function (x, y) {
      var img = this.add.image(x, y, 'boom').setScale(0.4 / TEX).setDepth(26);
      var t = this.add.text(x, y, 'BUG BOMB!', { fontFamily: FONT, fontSize: '40px', fontStyle: '800', color: CREAM, stroke: INK, strokeThickness: 8, padding: { top: 6 } })
        .setOrigin(0.5).setDepth(27).setResolution(2).setAngle(-8);
      audio.boom();
      if (!RM) this.cameras.main.shake(220, 0.005);
      this.tweens.add({ targets: img, scale: 1.45 / TEX, duration: 160, ease: 'Back.easeOut' });
      this.tweens.add({ targets: img, scale: 1.62 / TEX, duration: 300, delay: 160, yoyo: true, repeat: 1 });
      this.tweens.add({ targets: [img, t], alpha: 0, delay: 1100, duration: 350, onComplete: function () { img.destroy(); t.destroy(); } });
      this.spark(x, y, 0xfbbc04); this.spark(x, y, 0xea4335);
    },

    ring: function (x, y, color) {
      var c = this.add.circle(x, y, 30).setStrokeStyle(6, color).setDepth(26);
      this.tweens.add({ targets: c, scale: 2.2, alpha: 0, duration: 520, onComplete: function () { c.destroy(); } });
    },

    rainbowBurst: function (x, y) {
      var cols = [0x4285f4, 0xea4335, 0xfbbc04, 0x34a853];
      for (var i = 0; i < 12; i++) {
        var c = this.add.rectangle(x, y, 10, 10, cols[i % 4]).setStrokeStyle(2.5, INKN).setDepth(20).setAngle(i * 30);
        var ang = (i / 12) * Math.PI * 2, dist = Phaser.Math.Between(34, 70);
        this.tweens.add({ targets: c, x: x + Math.cos(ang) * dist, y: y + Math.sin(ang) * dist, angle: 300, alpha: 0, duration: 520, onComplete: function () { this.targets[0].destroy(); } });
      }
    },

    spark: function (x, y, color) {
      for (var i = 0; i < 10; i++) {
        var c = this.add.circle(x, y, Phaser.Math.Between(4, 7), color).setStrokeStyle(2.5, INKN).setDepth(20);
        var ang = Math.random() * Math.PI * 2, dist = Phaser.Math.Between(28, 72);
        this.tweens.add({ targets: c, x: x + Math.cos(ang) * dist, y: y + Math.sin(ang) * dist, alpha: 0, scale: 0.3, duration: Phaser.Math.Between(300, 560), onComplete: function () { this.targets[0].destroy(); } });
      }
    },

    floatText: function (x, y, text, color, size) {
      var t = this.add.text(x, y, text, { fontFamily: FONT, fontSize: (size || 36) + 'px', fontStyle: '800', color: color, stroke: INK, strokeThickness: 9, padding: { top: 6 } })
        .setOrigin(0.5).setDepth(30).setResolution(2).setShadow(0, 5, INK, 0, true, true);
      if (RM) { this.time.delayedCall(1100, function () { t.destroy(); }); return; }
      t.setScale(0.6);
      this.tweens.add({ targets: t, scale: 1, duration: 180, ease: 'Back.easeOut' });
      this.tweens.add({ targets: t, y: y - 70, alpha: 0, delay: 600, duration: 800, onComplete: function () { t.destroy(); } });
    },

    update: function (time, delta) {
      var dt = delta / 1000, k = 1 - Math.exp(-dt * 18), now = time, self = this;
      Object.keys(this.cars).forEach(function (id) {
        var e = self.cars[id];
        e.x += (e.tx - e.x) * k; e.y += (e.ty - e.y) * k;
        var da = Phaser.Math.Angle.Wrap(e.ta - e.a); e.a += da * k;
        // spin-out: whirl the kart, then settle back to the track heading
        if (e.spin && !RM) e.spinA += dt * 14; else e.spinA = Phaser.Math.Angle.Wrap(e.spinA) * (1 - Math.min(1, dt * 10));
        e.sprite.setPosition(e.x, e.y).setRotation(e.a + e.spinA);
        var back = 36 + e.tagW / 2 + (e.boost && !e.fin ? 58 : 0); // the tag trails behind the turbo flame
        e.tag.setPosition(e.x - Math.cos(e.a) * back, e.y - Math.sin(e.a) * back);
        var alpha = e.fin || e.dnf ? 0.45 : e.off ? 0.55 : 1;
        e.sprite.setAlpha(alpha); e.tag.setAlpha(e.fin || e.dnf ? 0.6 : 1);
        // turbo flames behind the kart
        e.flame.setVisible(!!e.boost && !e.fin);
        if (e.boost) {
          e.flame.setPosition(e.x - Math.cos(e.a) * 24, e.y - Math.sin(e.a) * 24).setRotation(e.a + Math.PI);
          e.flame.setScale((1.5 + (RM ? 0 : Math.sin(now / 30) * 0.45)) / TEX, 1.35 / TEX);
        }
        // shield bubble
        e.shield.setVisible(!!e.shieldOn).setPosition(e.x, e.y);
        if (e.shieldOn) e.shield.setAlpha(RM ? 0.9 : 0.7 + 0.3 * Math.sin(now / 160));
        // spin-out stars
        e.stars.setVisible(!!e.spin).setPosition(e.x, e.y - 36);
        if (e.spin && !RM) e.stars.setRotation(Math.sin(now / 90) * 0.5).each(function (c) { c.setAngle(now / 4); });
        // answering a box on the phone: little ? box over the kart
        e.ask.setVisible(!!e.asking).setPosition(e.x, e.y - 40 + (RM ? 0 : Math.sin(now / 150) * 4));
        if (e.spd > 40 && !e.fin && now - self.lastTrail > 70 && snapshot && snapshot.status === 'racing') {
          var t = self.add.circle(e.x - Math.cos(e.a) * 30, e.y - Math.sin(e.a) * 30, 5, e.boost ? 0xfbbc04 : 0xfff6e0, 0.55).setDepth(4);
          self.tweens.add({ targets: t, alpha: 0, scale: 2, duration: 420, onComplete: function () { t.destroy(); } });
        }
      });
      if (now - this.lastTrail > 70) this.lastTrail = now;
    },
  });

  function bootGame() {
    if (bootGame.done) return; bootGame.done = true;
    new Phaser.Game({
      type: Phaser.AUTO, width: 1920, height: 1080, parent: 'game', backgroundColor: '#5CC46A',
      scale: { mode: Phaser.Scale.NONE }, scene: [KartScene], fps: { target: 60 }, render: { antialias: true },
    });
  }
  (function () {
    var wait = [];
    try { if (document.fonts && document.fonts.load) wait = [document.fonts.load('800 40px "Baloo 2"'), document.fonts.load('700 20px "Baloo 2"')]; } catch (e) { /* no font API */ }
    Promise.race([Promise.all(wait), new Promise(function (r) { setTimeout(r, 2500); })]).then(bootGame, bootGame);
  })();

  // ---------- toasts + live feed ----------
  function toast(text, bad) {
    var t = el('div', 'toast' + (bad ? ' bad' : ''), text);
    $('toasts').appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }

  var feed = [];
  function pushFeed(text, kind) {
    feed.unshift({ text: text, kind: kind, at: Date.now() });
    feed = feed.slice(0, RULES.FEED_MAX);
    renderFeed();
  }
  function renderFeed() {
    var box = $('feed'); box.innerHTML = '';
    feed.forEach(function (f, i) {
      var d = el('div', 'k-feed-item ' + f.kind + (i === 0 ? ' new' : ''), f.text); d.dir = 'auto';
      d.style.opacity = String(1 - i * 0.14);
      box.appendChild(d);
    });
  }
  function feedEvents(events) {
    events.forEach(function (ev) {
      var who = nameOf(ev.id);
      if (!who) return;
      if (ev.type === 'bomb') {
        if (!ev.target) pushFeed(who + '’s Bug Bomb fizzled', 'muted');
        else if (ev.blocked) pushFeed(nameOf(ev.target) + '’s Shield blocked ' + who + '’s Bug Bomb!', 'blue');
        else pushFeed(who + ' hit ' + nameOf(ev.target) + ' with a Bug Bomb!', 'red');
      }
      else if (ev.type === 'gotItem') pushFeed(who + ' answered right · ' + ITEMS[ev.item].name + '!', 'blue');
      else if (ev.type === 'streakTurbo') pushFeed(who + ': 3 right in a row · TURBO', 'yellow');
      else if (ev.type === 'wrong') pushFeed(who + ' answered wrong · spin out!', 'ink');
      else if (ev.type === 'turbo') pushFeed(who + ' fired a Turbo!', 'yellow');
      else if (ev.type === 'shield') pushFeed(who + ' raised a Shield', 'sky');
      else if (ev.type === 'wall') pushFeed(who + ' dropped a Firewall', 'purple');
      else if (ev.type === 'wallHit') pushFeed(who + ' crashed into ' + (nameOf(ev.by) || 'a') + '’s Firewall!', 'purple');
      else if (ev.type === 'blocked' && ev.what === 'firewall') pushFeed(who + '’s Shield smashed a Firewall', 'blue');
      else if (ev.type === 'finish') pushFeed(who + ' finished P' + ev.pos + '!', 'green');
    });
  }

  // ---------- rendering ----------
  function show(id, on) { $(id).classList.toggle('hidden', !on); }

  function renderAll() {
    var st = room ? room.status : null;
    show('screen-login', !room);
    show('screen-lobby', st === STATUS.LOBBY);
    show('screen-countdown', st === STATUS.COUNTDOWN);
    show('screen-hud', st === STATUS.RACING || st === STATUS.PAUSED || st === STATUS.COUNTDOWN);
    show('screen-results', st === STATUS.FINISHED || st === STATUS.ABORTED);
    show('controls', !!room);
    if (!room) return;
    renderControls(); renderLobby(); renderHud();
    if (st === STATUS.FINISHED || st === STATUS.ABORTED) renderResults();
    if (st === STATUS.FINISHED && prevStatus !== STATUS.FINISHED) { confetti(); audio.fanfare(); }
    if (st === STATUS.LOBBY || st === STATUS.COUNTDOWN) { feed = []; renderFeed(); }
    if (st !== STATUS.COUNTDOWN) $('cd-number').textContent = '';
    prevStatus = st;
    if (scene) { scene.refreshNames(); scene.syncCones(); }
  }

  function renderControls() {
    var st = room.status, vis = {
      start: st === STATUS.LOBBY, cancel: st === STATUS.COUNTDOWN, pause: st === STATUS.RACING,
      resume: st === STATUS.PAUSED, abort: st === STATUS.RACING || st === STATUS.PAUSED,
      reset: true, mute: true, fullscreen: true,
    };
    document.querySelectorAll('#controls [data-act]').forEach(function (b) { b.classList.toggle('hidden', !vis[b.dataset.act]); });
    document.querySelector('#controls [data-act="start"]').classList.add('hidden');
  }

  function renderLobby() {
    $('qr').src = qr; $('room-code').textContent = room.code; $('join-url').textContent = joinUrl;
    $('lobby-count').textContent = room.players.length; $('lobby-max').textContent = room.maxPlayers;
    var slots = $('slots'); slots.innerHTML = '';
    var list = room.players.slice().sort(function (a, b) { return a.joinedAt - b.joinedAt; });
    for (var i = 0; i < room.maxPlayers; i++) {
      var p = list[i], d = el('div', 'slot' + (p ? ' filled' : '') + (p && !p.connected ? ' off' : ''));
      if (p) {
        d.appendChild(toyCar(p.color, p.carId));
        var box = el('div', 'who'); var nm = el('div', 'nm', p.name); nm.dir = 'auto';
        box.appendChild(nm); box.appendChild(el('div', 'sub', p.connected ? p.carName + ' kart' : 'disconnected…'));
        d.appendChild(box);
        var x = el('button', 'x', '✕'); x.title = 'Remove player'; x.dataset.id = p.id; d.appendChild(x);
      } else { d.appendChild(el('span', 'ghost')); d.appendChild(el('span', null, 'Racer ' + (i + 1) + '…')); }
      slots.appendChild(d);
    }
    var connected = room.players.filter(function (p) { return p.connected; }).length;
    $('btn-start').disabled = connected === 0;
    $('lobby-hint').textContent = connected === 0 ? 'Waiting for players… (2-8, scan the QR code)' : connected === 1 ? '1 ready · more racers = more chaos!' : connected + ' ready · press Space to start';
    $('laps-val').textContent = room.settings.laps;
    var pen = [0.2, 0.35, 0.55].reduce(function (b, v) { return Math.abs(v - room.settings.collisionPenalty) < Math.abs(b - room.settings.collisionPenalty) ? v : b; });
    $('penalty').value = String(pen);
    $('obstacles').value = room.settings.obstacles ? '1' : '0';
  }

  function renderHud() {
    var paused = room.status === STATUS.PAUSED;
    show('pause-banner', paused);
    if (board) $('hud-lap').textContent = (board.rows.length ? board.rows[0].lap : 1) + '/' + board.laps;
    else $('hud-lap').textContent = '1/' + room.settings.laps;
  }

  function itemPill(r) {
    if (r.finished) return { text: r.finishTime != null ? fmtTime(r.finishTime) : 'FIN', cls: 'fin' };
    if (r.dnf) return { text: 'DNF', cls: 'none' };
    if (r.ask) return { text: '? answering', cls: 'ask' };
    if (r.spin) return { text: 'spin out!', cls: 'spin' };
    if (r.item) return { text: ITEMS[r.item].short, cls: 'item', color: ITEMS[r.item].color };
    return { text: '—', cls: 'none' };
  }

  function renderBoard() {
    var ol = $('board'); ol.innerHTML = '';
    board.rows.forEach(function (r) {
      var li = el('li', (r.finished ? 'fin ' : '') + (r.connected ? '' : 'off'));
      li.style.setProperty('--c', r.color);
      li.appendChild(el('span', 'p', r.pos));
      li.appendChild(el('span', 'n', r.carId));
      var nm = el('span', 'nm', r.name); nm.dir = 'auto'; li.appendChild(nm);
      if (r.shield) li.appendChild(el('span', 'k-fx shield', 'S'));
      if (r.boost) li.appendChild(el('span', 'k-fx boost', '»'));
      var pill = itemPill(r), it = el('span', 'k-item ' + pill.cls, pill.text);
      if (pill.color) it.style.setProperty('--ic', pill.color);
      li.appendChild(it);
      ol.appendChild(li);
    });
    if (room) renderHud();
  }

  function renderResults() {
    var aborted = room.status === STATUS.ABORTED, res = aborted ? [] : room.results || [];
    var fin = res.filter(function (r) { return r.resultStatus === 'Finished'; });
    $('results-title').textContent = aborted ? 'RACE ABORTED' : fin.length ? fin[0].name + ' WINS!' : 'NO FINISHERS';
    $('results-title').dir = 'auto';
    $('btn-new').textContent = aborted ? 'Back to lobby' : 'Battle again!';
    var pod = $('podium'); pod.innerHTML = '';
    [[1, 'p2', '2'], [0, 'p1', '1'], [2, 'p3', '3']].forEach(function (cfg) {
      var r = fin[cfg[0]]; if (!r) return;
      var d = el('div', 'pod ' + cfg[1] + (fin.length === 1 ? ' solo' : ''));
      if (cfg[0] === 0) d.insertAdjacentHTML('beforeend', TROPHY);
      var nm = el('div', 'nm', r.name); nm.dir = 'auto'; d.appendChild(nm);
      d.appendChild(statLine(r));
      d.appendChild(toyCar(r.color, r.carId));
      var block = el('div', 'block');
      block.appendChild(el('div', 'medal', cfg[2]));
      block.appendChild(el('div', 'tm', fmtTime(r.finishTime)));
      d.appendChild(block);
      pod.appendChild(d);
    });
    var ol = $('results-list'); ol.innerHTML = '';
    res.forEach(function (r) {
      if (r.resultStatus === 'Finished' && fin.indexOf(r) < 3) return;
      var li = el('li'); li.style.setProperty('--c', r.color);
      li.appendChild(el('span', 'ps', r.finishPosition));
      li.appendChild(el('span', 'sw'));
      var nm = el('span', 'nm', r.name); nm.dir = 'auto'; li.appendChild(nm);
      li.appendChild(el('span', 'tm' + (r.resultStatus === 'DNF' ? ' dnf' : ''), r.resultStatus === 'DNF' ? 'DNF · ' + r.completedLaps + ' laps' : fmtTime(r.finishTime)));
      li.appendChild(el('span', 'k-st', (r.right || 0) + ' right · ' + hits(r.hits)));
      ol.appendChild(li);
    });
  }
  function statLine(r) {
    var d = el('div', 'k-stats');
    d.appendChild(el('span', null, (r.right || 0) + ' right'));
    d.appendChild(el('span', null, hits(r.hits)));
    return d;
  }
  function hits(n) { n = n || 0; return n + (n === 1 ? ' hit' : ' hits'); }

  var TROPHY = '<svg class="trophy" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10v5a5 5 0 0 1-10 0z" fill="#FBBC04" stroke="#1B1340" stroke-width="1.3" stroke-linejoin="round"/>' +
    '<path d="M7 5H4a3 3 0 0 0 3 4.5M17 5h3a3 3 0 0 1-3 4.5" fill="none" stroke="#1B1340" stroke-width="1.3"/><path d="M10 13h4l1 4H9z" fill="#FBBC04" stroke="#1B1340" stroke-width="1.3" stroke-linejoin="round"/>' +
    '<rect x="7.5" y="17" width="9" height="3.5" rx="1" fill="#EA4335" stroke="#1B1340" stroke-width="1.3"/><path d="M9.5 5v3" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/></svg>';

  function toyCar(color, n) {
    var t = el('span', 'toy'); t.style.setProperty('--c', color); t.setAttribute('aria-hidden', 'true');
    t.appendChild(el('i', 'wf t')); t.appendChild(el('i', 'wf b'));
    var b = el('b', 'body'); b.appendChild(el('em', null, n)); t.appendChild(b);
    return t;
  }

  function confetti() {
    if (RM) return;
    var colors = GDG4.concat(['#FFFFFF', '#A142F4']);
    for (var i = 0; i < 90; i++) {
      var c = el('div', 'confetti');
      c.style.left = Math.random() * 1920 + 'px'; c.style.background = colors[i % colors.length];
      c.style.animationDuration = (2.5 + Math.random() * 3) + 's'; c.style.animationDelay = (Math.random() * 1.5) + 's';
      c.style.transform = 'rotate(' + Math.random() * 360 + 'deg)';
      stage.appendChild(c);
      setTimeout(function (n) { n.remove(); }, 8000, c);
    }
  }

  // ---------- socket wiring ----------
  var SAVE_KEY = 'gdg_kart_host';
  function save(token, code) { try { sessionStorage.setItem(SAVE_KEY, JSON.stringify({ token: token, code: code })); } catch (e) { /* private mode */ } }
  function load() { try { return JSON.parse(sessionStorage.getItem(SAVE_KEY) || 'null'); } catch (e) { return null; } }

  var HOLD = {
    locked: ['Hold on!', 'Games start at the game stations.', 'Find someone from the <b>Registration Team</b> (green badge) and they\'ll open a game for you.'],
    closed: ['Station closed', 'This station was closed by the Registration Team.', 'Thanks for playing! The room has ended. Ask the <b>Registration Team</b> to open the station again for another round.'],
    expired: ['Hold on!', 'This station has expired.', 'Station links only work on the day they were opened. Ask the <b>Registration Team</b> (green badge) to open it again.'],
    connecting: ['Hold on!', 'Connecting to the game station…', 'One moment while the big screen gets ready.'],
    dev: ['Hold on!', 'Local development server.', 'This server has no station key, so it uses the dev host key instead. Never run it like this at an event.'],
  };
  var stationClosed = false;
  function holdOn(kind) {
    var h = HOLD[kind] || HOLD.locked;
    $('holdon').dataset.variant = kind;
    $('holdon-title').textContent = h[0]; $('holdon-lead').textContent = h[1]; $('holdon-body').innerHTML = h[2];
    show('login-form', kind === 'dev');
  }
  holdOn('connecting');

  function attach(secret) {
    if (stationClosed) return;
    var payload = { origin: location.origin }, saved = load();
    if (mode === 'dev') {
      if (saved) { payload.token = saved.token; payload.code = saved.code; }
      var sec = secret || sessionStorage.getItem('gdg_secret');
      if (sec) payload.secret = sec;
      if (!payload.token && !payload.secret) { room = null; holdOn('dev'); renderAll(); return; }
    }
    socket.emit(EVT.CREATE_ROOM, payload, function (res) {
      if (!res || !res.ok) {
        try { sessionStorage.removeItem(SAVE_KEY); sessionStorage.removeItem('gdg_secret'); } catch (e) { /* ignore */ }
        room = null;
        if (res && res.code === 'STATION_CLOSED') { stationClosed = true; holdOn(res.variant === 'expired' ? 'expired' : 'closed'); }
        else holdOn(mode === 'dev' ? 'dev' : 'locked');
        renderAll();
        $('login-error').textContent = (res && res.code !== 'STATION_CLOSED' && res.error) || '';
        return;
      }
      $('login-error').textContent = '';
      save(res.token, res.room.code);
      joinUrl = res.joinUrl; qr = res.qr; room = res.room;
      renderAll();
    });
  }

  socket.on('hello', function (h) {
    mode = h && h.mode === 'dev' ? 'dev' : 'station';
    if (h && h.signInUrl) { $('holdon-link').href = h.signInUrl; show('holdon-link', true); }
    attach();
  });
  socket.on('station-closed', function (d) {
    stationClosed = true; room = null;
    try { sessionStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
    holdOn(d && d.reason === 'expired' ? 'expired' : 'closed'); renderAll();
  });
  socket.on('connect', function () { show('conn', false); });
  socket.on('disconnect', function () { show('conn', !stationClosed); });

  $('login-form').addEventListener('submit', function (ev) {
    ev.preventDefault(); audio.ensure();
    var v = $('secret').value; if (!v) return;
    try { sessionStorage.setItem('gdg_secret', v); } catch (e) { /* ignore */ }
    attach(v);
  });

  socket.on(EVT.ROOM_UPDATE, function (info) { room = info; renderAll(); });
  socket.on(EVT.GAME_STATE, function (s) {
    snapshot = s;
    if (scene) { scene.applyState(s); scene.refreshNames(); if (s.events && s.events.length) scene.fx(s.events); }
    if (s.events && s.events.length) feedEvents(s.events);
    $('hud-time').textContent = fmtTime(s.raceTime);
  });
  socket.on(EVT.LEADERBOARD_UPDATE, function (b) { board = b; renderBoard(); });
  socket.on(EVT.COUNTDOWN_UPDATE, function (c) {
    var n = $('cd-number'); n.textContent = c.value; n.classList.toggle('low', c.value <= 3);
    n.style.animation = 'none'; void n.offsetWidth; n.style.animation = '';
    $('cd-sub').textContent = c.value <= 3 ? 'GET SET…' : 'GET READY';
    audio.count(c.value);
  });
  socket.on(EVT.RACE_STARTED, function () {
    var g = $('go-flash'); g.classList.remove('hidden'); g.style.animation = 'none'; void g.offsetWidth; g.style.animation = '';
    setTimeout(function () { g.classList.add('hidden'); }, 1200);
    audio.go();
  });
  socket.on(EVT.PLAYER_JOINED, function (p) { toast(p.name + (p.reconnected ? ' reconnected' : ' joined') + '  ·  ' + p.carName + ' kart'); audio.join(); });
  socket.on(EVT.PLAYER_LEFT, function (p) { toast(p.name + (p.reason === 'removed' ? ' was removed' : ' disconnected'), true); });
  socket.on(EVT.KICKED, function () { /* room closed under us */ });

  // ---------- host controls ----------
  function emit(event, payload) {
    socket.emit(event, payload || {}, function (res) { if (res && !res.ok) toast(res.error || 'Not allowed right now', true); });
  }
  function confirmDanger(key, msg, fn) {
    if (abortArmed === key) { abortArmed = null; fn(); return; }
    abortArmed = key; toast(msg); setTimeout(function () { if (abortArmed === key) abortArmed = null; }, 3000);
  }
  function act(a) {
    if (!room) return;
    var st = room.status;
    if (a === 'start') emit(EVT.START_COUNTDOWN);
    else if (a === 'cancel') emit(EVT.CANCEL_COUNTDOWN);
    else if (a === 'pause') emit(EVT.PAUSE_RACE);
    else if (a === 'resume') emit(EVT.RESUME_RACE);
    else if (a === 'abort') { if (st === STATUS.RACING || st === STATUS.PAUSED) confirmDanger('abort', 'Press Abort again to stop the race', function () { emit(EVT.ABORT_RACE); }); }
    else if (a === 'new') { if (st === STATUS.FINISHED || st === STATUS.ABORTED) emit(EVT.NEW_ROUND); }
    else if (a === 'reset') {
      if (st === STATUS.LOBBY) emit(EVT.RESET_SESSION);
      else confirmDanger('reset', 'Press Reset again to return to the lobby', function () { emit(EVT.RESET_SESSION); });
    }
    else if (a === 'mute') { audio.muted = !audio.muted; try { localStorage.setItem('gdg_muted', audio.muted ? '1' : '0'); } catch (e) { /* ignore */ } renderMute(); }
    else if (a === 'fullscreen') toggleFullscreen();
  }
  $('controls').addEventListener('click', function (ev) { var b = ev.target.closest('[data-act]'); if (b) act(b.dataset.act); });
  $('btn-start').addEventListener('click', function () { act('start'); });
  $('btn-new').addEventListener('click', function () { act('new'); });
  $('slots').addEventListener('click', function (ev) {
    var b = ev.target.closest('.x'); if (b) emit(EVT.REMOVE_PLAYER, { playerId: b.dataset.id });
  });
  $('laps-minus').addEventListener('click', function () { emit(EVT.UPDATE_SETTINGS, { laps: room.settings.laps - 1 }); });
  $('laps-plus').addEventListener('click', function () { emit(EVT.UPDATE_SETTINGS, { laps: room.settings.laps + 1 }); });
  $('penalty').addEventListener('change', function (e) { emit(EVT.UPDATE_SETTINGS, { collisionPenalty: Number(e.target.value) }); });
  $('obstacles').addEventListener('change', function (e) { emit(EVT.UPDATE_SETTINGS, { obstacles: e.target.value === '1' }); });

  window.addEventListener('keydown', function (ev) {
    var tag = (ev.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    var k = ev.key.toLowerCase();
    if (k === ' ' || k === 'enter') { if (room && room.status === STATUS.LOBBY) { ev.preventDefault(); act('start'); } else if (k === 'enter' && room && (room.status === STATUS.FINISHED || room.status === STATUS.ABORTED)) act('new'); }
    else if (k === 'p') act(room && room.status === STATUS.PAUSED ? 'resume' : 'pause');
    else if (k === 'a') act('abort');
    else if (k === 'r') act('reset');
    else if (k === 'n') act('new');
    else if (k === 'm') act('mute');
    else if (k === 'f') act('fullscreen');
    else if (k === 'escape' && room && room.status === STATUS.COUNTDOWN) act('cancel');
  });

  renderAll();
})();
