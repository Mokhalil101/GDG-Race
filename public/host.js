/* GDG RACE - Host display. Phaser 3 draws the track and cars; plain DOM draws lobby, HUD and results. */
(function () {
  'use strict';
  var TRACK = GDG.TRACK, CARS = GDG.CARS, EVT = GDG.EVT, STATUS = GDG.STATUS, fmtTime = GDG.fmtTime;
  var $ = function (id) { return document.getElementById(id); };
  // the server lives under a sub-path (e.g. /games); this page is <base>/race/
  var BASE = location.pathname.replace(/\/race(\/.*)?$/, '');
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function hexNum(h) { return parseInt(h.replace('#', ''), 16); }
  function carColor(n) { return CARS[(n || 1) - 1].color; }

  // ---------- stage scaling: fixed 1920x1080 stage scaled to the window (projector friendly) ----------
  var stage = $('stage');
  function fit() {
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stage.style.transform = 'translate(-50%, -50%) scale(' + s + ')';
  }
  window.addEventListener('resize', fit); fit();

  // ---------- full screen ----------
  // Browsers only allow fullscreen from a user action, so the first click / key press on the host page enters it.
  // Esc leaves it and we respect that (no re-entering). F or a double-click toggles it.
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

  // hide the mouse pointer on the projector after 3 s of inactivity (fullscreen only)
  var cursorTimer = null;
  function wakeCursor() {
    document.body.classList.remove('idle'); clearTimeout(cursorTimer);
    cursorTimer = setTimeout(function () { if (document.fullscreenElement) document.body.classList.add('idle'); }, 3000);
  }
  window.addEventListener('mousemove', wakeCursor); wakeCursor();

  // ---------- branding (SRS 3.6): drop the official logo at public/assets/logo.png ----------
  function renderBrand(node) {
    node.innerHTML = '<span class="dots"><i></i><i></i><i></i><i></i></span><span>GDG ASSIUT</span>';
    var img = new Image();
    img.onload = function () { node.innerHTML = ''; node.appendChild(img); };
    img.alt = 'GDG Assiut';
    img.src = BASE + '/assets/logo.png';
  }
  ['brand-lobby', 'brand-hud', 'brand-results'].forEach(function (id) { renderBrand($(id)); });

  // ---------- sound (WebAudio synth, no asset files; SRS 5.8) ----------
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
    lap: function () { this.tone(784, 0.1, 'triangle', 0.12); this.tone(1046, 0.16, 'triangle', 0.12, 0.1); },
    join: function () { this.tone(660, 0.1, 'triangle', 0.1); this.tone(880, 0.14, 'triangle', 0.1, 0.1); },
    fanfare: function () { [523, 659, 784, 1046, 784, 1046, 1318].forEach(function (f, i) { audio.tone(f, 0.22, 'triangle', 0.13, i * 0.14); }); },
  };
  ['click', 'keydown', 'touchstart'].forEach(function (ev) { window.addEventListener(ev, function () { audio.ensure(); }, { passive: true }); });
  function renderMute() { $('mute-label').textContent = audio.muted ? 'off' : 'on'; }
  renderMute();

  // ---------- state ----------
  var socket = io({ path: BASE + '/socket.io', transports: ['websocket', 'polling'] });
  var mode = null; // 'station' (normal) or 'dev' (no station key on the server)
  var room = null, joinUrl = '', qr = '', snapshot = null, board = null, scene = null, prevStatus = null;
  var abortArmed = null;

  function nameOf(id) {
    if (!room) return '';
    for (var i = 0; i < room.players.length; i++) if (room.players[i].id === id) return room.players[i].name;
    return '';
  }
  function playerOf(id) {
    if (!room) return null;
    for (var i = 0; i < room.players.length; i++) if (room.players[i].id === id) return room.players[i];
    return null;
  }

  // ---------- Phaser scene (sunny cartoon stadium) ----------
  var INK = '#1B1340', INKN = 0x1b1340, CREAM = '#FFF6E0', FONT = '"Baloo 2", "Segoe UI", system-ui, sans-serif';
  var GDG4 = [GDG.COLORS.gBlue, GDG.COLORS.gRed, GDG.COLORS.gYellow, GDG.COLORS.gGreen].map(hexNum);
  var RM = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var TEX = 2; // textures are drawn at 2x and shown at 0.5 scale, so they stay crisp on big screens

  function rnd(i, m) { return (((Math.sin(i * 91.7) * 43758.5453) % 1) + 1) % 1 * m; }
  function rrect(ctx, x, y, w, h, r) {
    var rr = Array.isArray(r) ? r : [r, r, r, r]; // tl tr br bl
    ctx.beginPath();
    ctx.moveTo(x + rr[0], y); ctx.lineTo(x + w - rr[1], y); ctx.quadraticCurveTo(x + w, y, x + w, y + rr[1]);
    ctx.lineTo(x + w, y + h - rr[2]); ctx.quadraticCurveTo(x + w, y + h, x + w - rr[2], y + h);
    ctx.lineTo(x + rr[3], y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - rr[3]);
    ctx.lineTo(x, y + rr[0]); ctx.quadraticCurveTo(x, y, x + rr[0], y); ctx.closePath();
  }
  // stadium outline at radius r around the track's centre line (TRACK.R = centre line)
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

  function paintStadium(ctx) {
    var T = TRACK, half = T.half, R = T.R, i, x, y;
    // striped grass
    for (x = 0, i = 0; x < 1920; x += 96, i++) { ctx.fillStyle = i % 2 ? '#4FB85E' : '#5CC46A'; ctx.fillRect(x, 0, 96, 1080); }
    // bushes
    [[70, 1010, 46], [140, 1052, 38], [30, 930, 34], [1580, 770, 40], [1640, 800, 30], [1880, 760, 34]].forEach(function (b) {
      ctx.fillStyle = 'rgba(27,19,64,.25)'; ctx.beginPath(); ctx.ellipse(b[0], b[1] + b[2] * 0.7, b[2], b[2] * 0.35, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2E9C48'; ctx.strokeStyle = INK; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(b[0] - b[2] * 0.45, b[1] + 4, b[2] * 0.62, 0, Math.PI * 2); ctx.arc(b[0] + b[2] * 0.45, b[1] + 4, b[2] * 0.62, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(b[0], b[1] - b[2] * 0.2, b[2] * 0.7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.beginPath(); ctx.arc(b[0] - b[2] * 0.2, b[1] - b[2] * 0.4, b[2] * 0.22, 0, Math.PI * 2); ctx.fill();
    });

    // grandstand with crowd
    ctx.fillStyle = '#2B2F45'; ctx.fillRect(0, 0, 1920, 132);
    ctx.fillStyle = '#3A3F5C'; for (y = 46; y < 132; y += 40) ctx.fillRect(0, y, 1920, 6);
    var shirt = ['#4285F4', '#EA4335', '#FBBC04', '#34A853', '#FFF6E0', '#FF8FB1', '#A142F4'];
    for (var row = 0; row < 3; row++) for (var col = 0; col < 96; col++) {
      var k = row * 96 + col;
      ctx.fillStyle = shirt[Math.floor(rnd(k, shirt.length))];
      ctx.beginPath(); ctx.arc(14 + col * 20 + (row % 2) * 10, 28 + row * 38 - (rnd(k + 3, 1) > 0.8 ? 4 : 0), 9, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = CREAM; ctx.fillRect(0, 124, 1920, 8);
    ctx.fillStyle = INK; ctx.fillRect(0, 132, 1920, 7);

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
    ctx.save(); ctx.translate(T.cx, T.cy - 14); ctx.rotate(-4 * Math.PI / 180);
    outlinedText(ctx, 'GDG RACE', 0, 0, 120, CREAM, 14, 12);
    ctx.font = '800 26px ' + FONT; var tw = ctx.measureText('CODE TO VICTORY').width + 44;
    ctx.fillStyle = INK; rrect(ctx, -tw / 2, 66, tw, 40, 20); ctx.fill();
    ctx.fillStyle = CREAM; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('CODE TO VICTORY', 0, 89);
    ctx.restore();

    // start / finish chequer (s = 0 is on the bottom straight, heading +x)
    var y0 = T.cy + R - half, rows = 14, sq = T.W / rows, x0 = T.cx - sq;
    for (var r2 = 0; r2 < rows; r2++) for (var c2 = 0; c2 < 2; c2++) { ctx.fillStyle = (r2 + c2) % 2 ? INK : '#fff'; ctx.fillRect(x0 + c2 * sq, y0 + r2 * sq, sq, sq); }
    ctx.fillStyle = INK; ctx.fillRect(x0 - 4, y0, 4, T.W); ctx.fillRect(x0 + 2 * sq, y0, 4, T.W);
    // flag pole (the flag itself is animated by Phaser)
    ctx.fillStyle = INK; rrect(ctx, T.cx - 44, y0 + T.W + 30, 9, 100, 4); ctx.fill();
    ctx.beginPath(); ctx.arc(T.cx - 39.5, y0 + T.W + 30, 8, 0, Math.PI * 2); ctx.fillStyle = '#FBBC04'; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = INK; ctx.stroke();
  }

  function paintCar(ctx, color, n) {
    // 64x44 at 1x, facing +x. Body 52x28 (physics car is 46x26).
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

  function paintCone(ctx) {
    var s = TEX; ctx.save(); ctx.scale(s, s); ctx.lineJoin = 'round';
    ctx.fillStyle = 'rgba(27,19,64,.3)'; rrect(ctx, 4, 8, 32, 32, 9); ctx.fill();
    ctx.fillStyle = '#F4511E'; ctx.strokeStyle = INK; ctx.lineWidth = 3.5; rrect(ctx, 4, 4, 32, 32, 9); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(20, 20, 11, 0, Math.PI * 2); ctx.fillStyle = '#FF9A5C'; ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(20, 20, 7, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 2.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(20, 20, 3.5, 0, Math.PI * 2); ctx.fillStyle = '#FF7043'; ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  function paintFlag(ctx) {
    var s = TEX; ctx.save(); ctx.scale(s, s);
    var w = 64, h = 42, q = 10.5;
    ctx.save(); rrect(ctx, 2, 2, w, h, 4); ctx.clip();
    for (var r = 0; r < 4; r++) for (var c = 0; c < 7; c++) { ctx.fillStyle = (r + c) % 2 ? INK : '#fff'; ctx.fillRect(2 + c * q, 2 + r * q, q, q); }
    ctx.restore(); ctx.strokeStyle = INK; ctx.lineWidth = 3.5; rrect(ctx, 2, 2, w, h, 4); ctx.stroke();
    ctx.restore();
  }

  function canvasTexture(scene, key, w, h, paint) {
    if (scene.textures.exists(key)) scene.textures.remove(key);
    var t = scene.textures.createCanvas(key, w, h);
    paint(t.getContext());
    t.refresh();
    return t;
  }

  var RaceScene = new Phaser.Class({
    Extends: Phaser.Scene,
    initialize: function RaceScene() { Phaser.Scene.call(this, { key: 'race' }); },

    create: function () {
      this.cars = {};
      this.lastTrail = 0;
      this.drawTrack();
      this.makeCarTextures();
      this.makeObstacles();
      this.makeCrowd();
      scene = this;
      if (snapshot) this.applyState(snapshot);
      this.syncObstacles();
    },

    drawTrack: function () {
      var half = TRACK.half;
      canvasTexture(this, 'stadium', 1920, 1080, paintStadium);
      this.add.image(0, 0, 'stadium').setOrigin(0, 0).setDepth(0);
      // checkpoints in GDG colours (flash when a car crosses)
      this.cp = TRACK.checkpoints.map(function (s3, idx) {
        var gg = this.add.graphics().setDepth(1), p1 = TRACK.pointAt(s3, half), p2 = TRACK.pointAt(s3, -half);
        gg.lineStyle(8, GDG4[idx], 1); gg.lineBetween(p1.x, p1.y, p2.x, p2.y); gg.setAlpha(0);
        return gg;
      }, this);
      // waving chequered flag next to the finish line
      canvasTexture(this, 'flag', 68 * TEX, 46 * TEX, paintFlag);
      var fy = TRACK.cy + TRACK.R + half + 30;
      this.flag = this.add.image(TRACK.cx - 36, fy + 22, 'flag').setOrigin(0, 0.5).setScale(1 / TEX).setDepth(2);
      if (!RM) this.tweens.add({ targets: this.flag, scaleX: 0.78 / TEX, angle: -5, duration: 420, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    },

    makeCarTextures: function () {
      CARS.forEach(function (car) {
        canvasTexture(this, 'car' + car.id, 64 * TEX, 44 * TEX, function (ctx) { paintCar(ctx, car.color, car.id); });
      }, this);
      canvasTexture(this, 'cone', 40 * TEX, 44 * TEX, paintCone);
    },

    makeObstacles: function () {
      this.obst = TRACK.obstacles.map(function (o) {
        var p = TRACK.pointAt(o.s, o.d);
        var c = this.add.image(p.x, p.y, 'cone').setScale(1 / TEX).setDepth(3).setAngle(rnd(o.s, 40) - 20);
        return { c: c, x: p.x, y: p.y };
      }, this);
    },

    syncObstacles: function () {
      var on = !room || room.settings.obstacles;
      this.obst.forEach(function (o) { o.c.setVisible(on); });
    },

    makeCrowd: function () {
      // a few excited fans hopping in the grandstand
      if (RM) return;
      var shirt = [0x4285f4, 0xea4335, 0xfbbc04, 0x34a853, 0xfff6e0, 0xff8fb1, 0xa142f4];
      for (var i = 0; i < 46; i++) {
        var col = Math.floor(rnd(i + 500, 96)), row = Math.floor(rnd(i + 900, 3));
        var x = 14 + col * 20 + (row % 2) * 10, y = 28 + row * 38;
        var fan = this.add.circle(x, y, 9, shirt[i % shirt.length]).setDepth(1);
        this.tweens.add({ targets: fan, y: y - 9, duration: 220 + rnd(i, 200), yoyo: true, repeat: -1, repeatDelay: 300 + rnd(i + 7, 1400), delay: rnd(i + 11, 1500), ease: 'Quad.easeOut' });
      }
    },

    makeCar: function (data) {
      var depth = 5, sprite = this.add.image(data.x, data.y, 'car' + data.n).setDepth(depth).setRotation(data.a).setScale(1 / TEX);
      var text = this.add.text(0, 1, '', { fontFamily: FONT, fontSize: '19px', fontStyle: '800', color: INK, padding: { top: 4, bottom: 0 } }).setOrigin(0.5).setResolution(2);
      var bg = this.add.graphics();
      var tag = this.add.container(data.x, data.y - 40, [bg, text]).setDepth(12);
      var e = { sprite: sprite, tag: tag, tagBg: bg, tagText: text, tagW: 40, n: data.n, x: data.x, y: data.y, a: data.a, tx: data.x, ty: data.y, ta: data.a, name: null };
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
        seen[car.id] = true;
      });
      Object.keys(this.cars).forEach(function (id) {
        if (!seen[id]) { var e = self.cars[id]; e.sprite.destroy(); e.tag.destroy(); delete self.cars[id]; }
      });
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
        if (ev.type === 'collision') { self.spark(ev.x, ev.y, 0xffffff); self.spark(ev.x, ev.y, 0xfbbc04); if (!RM) self.cameras.main.shake(120, 0.002); audio.crash(); }
        else if (ev.type === 'checkpoint') { var g = self.cp[ev.idx - 1]; if (g) { g.setAlpha(1); self.tweens.add({ targets: g, alpha: 0, duration: 600 }); } }
        else if (ev.type === 'lap' && car) { self.floatText(car.x, car.y - 60, 'LAP ' + (ev.lap + 1) + '!', '#FBBC04'); audio.lap(); }
        else if (ev.type === 'finish' && car) { self.floatText(car.x, car.y - 60, 'FINISH! P' + ev.pos, '#34A853'); self.spark(car.x, car.y, 0x34a853); self.spark(car.x, car.y, 0xfbbc04); audio.lap(); }
        else if (ev.type === 'obstacle') {
          var o = self.obst[ev.idx];
          if (o) { self.spark(o.x, o.y, 0xff7043); if (!RM) self.tweens.add({ targets: o.c, scale: 1.35 / TEX, duration: 110, yoyo: true }); }
        }
      });
    },

    spark: function (x, y, color) {
      for (var i = 0; i < 10; i++) {
        var c = this.add.circle(x, y, Phaser.Math.Between(4, 7), color).setStrokeStyle(2.5, INKN).setDepth(20);
        var ang = Math.random() * Math.PI * 2, dist = Phaser.Math.Between(28, 72);
        this.tweens.add({ targets: c, x: x + Math.cos(ang) * dist, y: y + Math.sin(ang) * dist, alpha: 0, scale: 0.3, duration: Phaser.Math.Between(300, 560), onComplete: function () { this.targets[0].destroy(); } });
      }
    },

    floatText: function (x, y, text, color) {
      var t = this.add.text(x, y, text, { fontFamily: FONT, fontSize: '38px', fontStyle: '800', color: color, stroke: INK, strokeThickness: 9, padding: { top: 6 } })
        .setOrigin(0.5).setDepth(30).setResolution(2).setShadow(0, 5, INK, 0, true, true);
      if (RM) { this.time.delayedCall(1100, function () { t.destroy(); }); return; }
      t.setScale(0.6);
      this.tweens.add({ targets: t, scale: 1, duration: 180, ease: 'Back.easeOut' });
      this.tweens.add({ targets: t, y: y - 70, alpha: 0, delay: 500, duration: 800, onComplete: function () { t.destroy(); } });
    },

    update: function (time, delta) {
      var k = 1 - Math.exp(-(delta / 1000) * 18), now = time, self = this;
      Object.keys(this.cars).forEach(function (id) {
        var e = self.cars[id];
        e.x += (e.tx - e.x) * k; e.y += (e.ty - e.y) * k;
        var da = Phaser.Math.Angle.Wrap(e.ta - e.a); e.a += da * k;
        e.sprite.setPosition(e.x, e.y).setRotation(e.a);
        // name tag trails behind the car, so six cars in one start row never have overlapping labels
        var back = 36 + e.tagW / 2;
        e.tag.setPosition(e.x - Math.cos(e.a) * back, e.y - Math.sin(e.a) * back);
        var alpha = e.fin || e.dnf ? 0.45 : e.off ? 0.55 : 1;
        e.sprite.setAlpha(alpha); e.tag.setAlpha(e.fin || e.dnf ? 0.6 : 1);
        if (e.slow && !e.fin && !RM) e.sprite.setScale((1 + Math.sin(now / 40) * 0.06) / TEX); else e.sprite.setScale(1 / TEX);
        if (e.spd > 40 && !e.fin && now - self.lastTrail > 70 && snapshot && snapshot.status === 'racing') {
          var t = self.add.circle(e.x - Math.cos(e.a) * 30, e.y - Math.sin(e.a) * 30, 5, 0xfff6e0, 0.55).setDepth(4);
          self.tweens.add({ targets: t, alpha: 0, scale: 2, duration: 420, onComplete: function () { t.destroy(); } });
        }
      });
      if (now - this.lastTrail > 70) this.lastTrail = now;
    },
  });

  // Boot Phaser once Baloo 2 is ready (the stadium, car numbers and name tags are drawn with it); never wait more than 2.5 s.
  function bootGame() {
    if (bootGame.done) return; bootGame.done = true;
    new Phaser.Game({
      type: Phaser.AUTO, width: 1920, height: 1080, parent: 'game', backgroundColor: '#5CC46A',
      scale: { mode: Phaser.Scale.NONE }, scene: [RaceScene], fps: { target: 60 }, render: { antialias: true },
    });
  }
  (function () {
    var wait = [];
    try { if (document.fonts && document.fonts.load) wait = [document.fonts.load('800 40px "Baloo 2"'), document.fonts.load('700 20px "Baloo 2"')]; } catch (e) { /* no font API */ }
    Promise.race([Promise.all(wait), new Promise(function (r) { setTimeout(r, 2500); })]).then(bootGame, bootGame);
  })();

  // ---------- toasts ----------
  function toast(text, bad) {
    var t = el('div', 'toast' + (bad ? ' bad' : ''), text);
    $('toasts').appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }

  // ---------- rendering ----------
  function show(id, on) { $(id).classList.toggle('hidden', !on); }

  function renderAll() {
    var st = room ? room.status : null;
    show('screen-login', !room);
    show('screen-lobby', st === STATUS.LOBBY);
    show('screen-countdown', st === STATUS.COUNTDOWN);
    show('screen-hud', st === STATUS.RACING || st === STATUS.PAUSED);
    show('screen-results', st === STATUS.FINISHED || st === STATUS.ABORTED);
    show('controls', !!room);
    if (!room) return;
    renderControls(); renderLobby(); renderHud();
    if (st === STATUS.FINISHED || st === STATUS.ABORTED) renderResults();
    if (st === STATUS.FINISHED && prevStatus !== STATUS.FINISHED) { confetti(); audio.fanfare(); }
    if (st !== STATUS.COUNTDOWN) $('cd-number').textContent = '';
    prevStatus = st;
    if (scene) { scene.refreshNames(); scene.syncObstacles(); }
  }

  function renderControls() {
    var st = room.status, vis = {
      start: st === STATUS.LOBBY, cancel: st === STATUS.COUNTDOWN, pause: st === STATUS.RACING,
      resume: st === STATUS.PAUSED, abort: st === STATUS.RACING || st === STATUS.PAUSED,
      reset: true, mute: true, fullscreen: true,
    };
    document.querySelectorAll('#controls [data-act]').forEach(function (b) { b.classList.toggle('hidden', !vis[b.dataset.act]); });
    // the lobby has its own big start button
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
        box.appendChild(nm); box.appendChild(el('div', 'sub', p.connected ? p.carName + ' car' : 'disconnected…'));
        d.appendChild(box);
        var x = el('button', 'x', '✕'); x.title = 'Remove player'; x.dataset.id = p.id; d.appendChild(x);
      } else { d.appendChild(el('span', 'ghost')); d.appendChild(el('span', null, 'Waiting for racer ' + (i + 1) + '…')); }
      slots.appendChild(d);
    }
    var connected = room.players.filter(function (p) { return p.connected; }).length;
    $('btn-start').disabled = connected === 0;
    $('lobby-hint').textContent = connected === 0 ? 'Waiting for players… (scan the QR code)' : connected + ' ready · press Space or the button to start';
    $('laps-val').textContent = room.settings.laps;
    var pen = [0.2, 0.35, 0.55].reduce(function (b, v) { return Math.abs(v - room.settings.collisionPenalty) < Math.abs(b - room.settings.collisionPenalty) ? v : b; });
    $('penalty').value = String(pen);
    $('obstacles').value = room.settings.obstacles ? '1' : '0';
  }

  function renderHud() {
    var paused = room.status === STATUS.PAUSED;
    show('pause-banner', paused);
    var s = $('hud-status'); s.textContent = paused ? 'PAUSED' : 'RACING'; s.classList.toggle('paused', paused);
    if (board) $('hud-lap').textContent = (board.rows.length ? board.rows[0].lap : 1) + '/' + board.laps;
  }

  function renderBoard() {
    var ol = $('board'); ol.innerHTML = '';
    board.rows.forEach(function (r) {
      var li = el('li', (r.finished ? 'fin ' : '') + (r.connected ? '' : 'off'));
      li.style.setProperty('--c', r.color);
      li.appendChild(el('span', 'p', r.pos));
      li.appendChild(el('span', 'n', r.carId));
      var nm = el('span', 'nm', r.name); nm.dir = 'auto'; li.appendChild(nm);
      li.appendChild(el('span', 'lp', r.finished ? fmtTime(r.finishTime) : r.dnf ? 'DNF' : 'LAP ' + r.lap + '/' + board.laps));
      ol.appendChild(li);
    });
    if (room) renderHud();
  }

  function renderResults() {
    var aborted = room.status === STATUS.ABORTED, res = aborted ? [] : room.results || [];
    var fin = res.filter(function (r) { return r.resultStatus === 'Finished'; });
    $('results-title').textContent = aborted ? 'RACE ABORTED' : fin.length ? fin[0].name + ' WINS!' : 'NO FINISHERS';
    $('results-title').dir = 'auto';
    $('btn-new').textContent = aborted ? 'Back to lobby' : 'Race again!';
    var pod = $('podium'); pod.innerHTML = '';
    [[1, 'p2', '2'], [0, 'p1', '1'], [2, 'p3', '3']].forEach(function (cfg) {
      var r = fin[cfg[0]]; if (!r) return;
      var d = el('div', 'pod ' + cfg[1] + (fin.length === 1 ? ' solo' : ''));
      if (cfg[0] === 0) d.insertAdjacentHTML('beforeend', TROPHY);
      var nm = el('div', 'nm', r.name); nm.dir = 'auto'; d.appendChild(nm);
      d.appendChild(toyCar(r.color, r.carId));
      var block = el('div', 'block');
      block.appendChild(el('div', 'medal', cfg[2]));
      block.appendChild(el('div', 'tm', fmtTime(r.finishTime)));
      d.appendChild(block);
      pod.appendChild(d);
    });
    // everyone off the podium goes in the bottom bar
    var ol = $('results-list'); ol.innerHTML = '';
    res.forEach(function (r) {
      if (r.resultStatus === 'Finished' && fin.indexOf(r) < 3) return;
      var li = el('li'); li.style.setProperty('--c', r.color);
      li.appendChild(el('span', 'ps', r.finishPosition));
      li.appendChild(el('span', 'sw'));
      var nm = el('span', 'nm', r.name); nm.dir = 'auto'; li.appendChild(nm);
      li.appendChild(el('span', 'tm' + (r.resultStatus === 'DNF' ? ' dnf' : ''), r.resultStatus === 'DNF' ? 'DNF · ' + r.completedLaps + ' laps' : fmtTime(r.finishTime)));
      ol.appendChild(li);
    });
  }

  var TROPHY = '<svg class="trophy" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10v5a5 5 0 0 1-10 0z" fill="#FBBC04" stroke="#1B1340" stroke-width="1.3" stroke-linejoin="round"/>' +
    '<path d="M7 5H4a3 3 0 0 0 3 4.5M17 5h3a3 3 0 0 1-3 4.5" fill="none" stroke="#1B1340" stroke-width="1.3"/><path d="M10 13h4l1 4H9z" fill="#FBBC04" stroke="#1B1340" stroke-width="1.3" stroke-linejoin="round"/>' +
    '<rect x="7.5" y="17" width="9" height="3.5" rx="1" fill="#EA4335" stroke="#1B1340" stroke-width="1.3"/><path d="M9.5 5v3" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/></svg>';

  /** Cartoon top-down car in DOM (styles: .toy in style.css). */
  function toyCar(color, n) {
    var t = el('span', 'toy'); t.style.setProperty('--c', color); t.setAttribute('aria-hidden', 'true');
    t.appendChild(el('i', 'wf t')); t.appendChild(el('i', 'wf b'));
    var b = el('b', 'body'); b.appendChild(el('em', null, n)); t.appendChild(b);
    return t;
  }

  function confetti() {
    if (RM) return;
    var colors = [GDG.COLORS.gBlue, GDG.COLORS.gRed, GDG.COLORS.gYellow, GDG.COLORS.gGreen, '#FFFFFF', '#A142F4'];
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
  function save(token, code) { try { sessionStorage.setItem('gdg_host', JSON.stringify({ token: token, code: code })); } catch (e) { /* private mode */ } }
  function load() { try { return JSON.parse(sessionStorage.getItem('gdg_host') || 'null'); } catch (e) { return null; } }

  // the "Hold on!" screen: no station, a closed station, or (dev only) the host key form
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
        try { sessionStorage.removeItem('gdg_host'); sessionStorage.removeItem('gdg_secret'); } catch (e) { /* ignore */ }
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
    try { sessionStorage.removeItem('gdg_host'); } catch (e) { /* ignore */ }
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
  socket.on(EVT.PLAYER_JOINED, function (p) { toast(p.name + (p.reconnected ? ' reconnected' : ' joined') + '  ·  ' + p.carName + ' car'); audio.join(); });
  socket.on(EVT.PLAYER_LEFT, function (p) { toast(p.name + (p.reason === 'removed' ? ' was removed' : ' disconnected'), true); });
  socket.on(EVT.PLAYER_FINISHED, function (p) { toast(p.name + ' finished P' + p.position + '  ·  ' + fmtTime(p.time)); });
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
