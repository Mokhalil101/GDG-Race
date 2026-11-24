/* GDG RACE - Host display. Phaser 3 draws the track and cars; plain DOM draws lobby, HUD and results. */
(function () {
  'use strict';
  var TRACK = GDG.TRACK, CARS = GDG.CARS, EVT = GDG.EVT, STATUS = GDG.STATUS, fmtTime = GDG.fmtTime;
  var $ = function (id) { return document.getElementById(id); };
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
    img.src = '/assets/logo.png';
  }
  ['brand-login', 'brand-lobby', 'brand-hud', 'brand-results'].forEach(function (id) { renderBrand($(id)); });

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
  var socket = io({ transports: ['websocket', 'polling'] });
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

  // ---------- Phaser scene ----------
  var GDG4 = [GDG.COLORS.gBlue, GDG.COLORS.gRed, GDG.COLORS.gYellow, GDG.COLORS.gGreen].map(hexNum);

  var RaceScene = new Phaser.Class({
    Extends: Phaser.Scene,
    initialize: function RaceScene() { Phaser.Scene.call(this, { key: 'race' }); },

    create: function () {
      this.cars = {};
      this.lastTrail = 0;
      this.drawTrack();
      this.makeCarTextures();
      this.makeObstacles();
      this.makeLights();
      scene = this;
      if (snapshot) this.applyState(snapshot);
      this.syncObstacles();
    },

    drawTrack: function () {
      var P = TRACK.P, W = TRACK.W, half = TRACK.half, g = this.add.graphics().setDepth(0), i, k;
      g.lineStyle(1, 0x00e5ff, 0.045);
      for (i = 0; i <= 1920; i += 60) g.lineBetween(i, 0, i, 1080);
      for (i = 0; i <= 1080; i += 60) g.lineBetween(0, i, 1920, i);

      var N = 260, center = [], inner = [], outer = [];
      for (i = 0; i < N; i++) {
        var s = (i / N) * P, c = TRACK.pointAt(s, 0), a = TRACK.pointAt(s, half), b = TRACK.pointAt(s, -half);
        center.push(new Phaser.Math.Vector2(c.x, c.y));
        inner.push(new Phaser.Math.Vector2(a.x, a.y));
        outer.push(new Phaser.Math.Vector2(b.x, b.y));
      }
      [[W + 70, 0.035], [W + 44, 0.05], [W + 20, 0.09]].forEach(function (h) { g.lineStyle(h[0], 0x00e5ff, h[1]); g.strokePoints(center, true, true); });
      g.lineStyle(W, 0x111a35, 1); g.strokePoints(center, true, true);
      g.lineStyle(W - 14, 0x0d1430, 1); g.strokePoints(center, true, true);
      // lane markings (4 lanes)
      g.lineStyle(3, 0xffffff, 0.2);
      [0, half / 2, -half / 2].forEach(function (d) {
        for (var s2 = 0; s2 < P; s2 += 46) { var p1 = TRACK.pointAt(s2, d), p2 = TRACK.pointAt(s2 + 20, d); g.lineBetween(p1.x, p1.y, p2.x, p2.y); }
      });
      // neon borders
      [inner, outer].forEach(function (edge) {
        g.lineStyle(20, 0x00e5ff, 0.1); g.strokePoints(edge, true, true);
        g.lineStyle(9, 0x00e5ff, 0.35); g.strokePoints(edge, true, true);
        g.lineStyle(4, 0xa8f7ff, 1); g.strokePoints(edge, true, true);
      });
      // GDG-coloured kerb dashes just outside the borders
      for (k = 0; k * 48 < P; k++) {
        g.lineStyle(6, GDG4[k % 4], 0.9);
        [half + 9, -half - 9].forEach(function (d) {
          var q1 = TRACK.pointAt(k * 48, d), q2 = TRACK.pointAt(k * 48 + 24, d); g.lineBetween(q1.x, q1.y, q2.x, q2.y);
        });
      }
      // start / finish checker (s = 0 is on the bottom straight, heading +x)
      var x0 = TRACK.cx - 12, y0 = TRACK.cy + TRACK.R - half, rows = Math.round(W / 10);
      for (var r = 0; r < rows; r++) for (var cc = 0; cc < 2; cc++) {
        g.fillStyle((r + cc) % 2 ? 0x05060f : 0xffffff, 1); g.fillRect(x0 + cc * 12, y0 + r * 10, 12, 10);
      }
      // checkpoints in GDG colours (flash when a car crosses)
      this.cp = TRACK.checkpoints.map(function (s3, idx) {
        var gg = this.add.graphics().setDepth(1), p1 = TRACK.pointAt(s3, half), p2 = TRACK.pointAt(s3, -half);
        gg.lineStyle(8, GDG4[idx], 1); gg.lineBetween(p1.x, p1.y, p2.x, p2.y); gg.setAlpha(0.55);
        return gg;
      }, this);
      // infield decoration
      this.add.text(TRACK.cx, TRACK.cy - 26, 'GDG RACE', { fontFamily: 'Orbitron, Rajdhani, sans-serif', fontSize: '120px', fontStyle: '800', color: '#ffffff' }).setOrigin(0.5).setAlpha(0.07).setDepth(0);
      this.add.text(TRACK.cx, TRACK.cy + 70, 'CODE TO VICTORY', { fontFamily: 'Orbitron, Rajdhani, sans-serif', fontSize: '40px', color: '#FBBC04' }).setOrigin(0.5).setAlpha(0.18).setDepth(0);
      for (i = 0; i < 4; i++) this.add.circle(TRACK.cx - 54 + i * 36, TRACK.cy + 130, 11, GDG4[i]).setAlpha(0.35);
    },

    makeCarTextures: function () {
      CARS.forEach(function (car) {
        var col = hexNum(car.color), g = this.make.graphics({ x: 0, y: 0, add: false });
        g.fillStyle(col, 0.16); g.fillRoundedRect(3, 3, 66, 38, 15);
        g.fillStyle(col, 0.28); g.fillRoundedRect(8, 7, 56, 30, 12);
        g.fillStyle(0x000000, 0.45); g.fillRect(9, 9, 4, 26);             // rear wing
        g.fillStyle(col, 1); g.fillRoundedRect(13, 9, 46, 26, 8);          // body
        g.fillStyle(0xffffff, 0.35); g.fillRoundedRect(44, 11, 13, 22, 5); // bonnet shine
        g.fillStyle(0x0a0f24, 0.95); g.fillRoundedRect(27, 13, 17, 18, 5); // cockpit
        g.fillStyle(0xffffff, 1); g.fillRect(56, 11, 4, 6); g.fillRect(56, 27, 4, 6); // headlights
        g.fillStyle(0xff3030, 1); g.fillRect(13, 11, 3, 6); g.fillRect(13, 27, 3, 6); // tail lights
        g.generateTexture('car' + car.id, 72, 44);
        g.destroy();
      }, this);
    },

    makeObstacles: function () {
      this.obst = TRACK.obstacles.map(function (o) {
        var p = TRACK.pointAt(o.s, o.d);
        var c = this.add.circle(p.x, p.y, o.r, 0xea4335, 0.9).setStrokeStyle(3, 0xfbbc04).setDepth(3);
        var halo = this.add.circle(p.x, p.y, o.r + 8, 0xea4335, 0.18).setDepth(2);
        this.tweens.add({ targets: halo, scale: 1.5, alpha: 0.02, duration: 900, yoyo: true, repeat: -1 });
        return { c: c, halo: halo, x: p.x, y: p.y };
      }, this);
    },

    syncObstacles: function () {
      var on = !room || room.settings.obstacles;
      this.obst.forEach(function (o) { o.c.setVisible(on); o.halo.setVisible(on); });
    },

    makeLights: function () {
      this.lights2 = [];
      for (var i = 0; i < 28; i++) {
        var c = this.add.circle(0, 0, 5, i % 2 ? 0x00e5ff : 0xa855f7, 0.95).setDepth(2).setBlendMode(Phaser.BlendModes.ADD);
        this.lights2.push({ c: c, k: i });
      }
    },

    makeCar: function (data) {
      var depth = 5, sprite = this.add.image(data.x, data.y, 'car' + data.n).setDepth(depth).setRotation(data.a);
      var num = this.add.text(data.x, data.y, String(data.n), { fontFamily: 'Orbitron, sans-serif', fontSize: '15px', fontStyle: '800', color: '#ffffff' }).setOrigin(0.5).setDepth(depth + 1);
      var label = this.add.text(data.x, data.y - 40, '', { fontFamily: 'Rajdhani, Segoe UI, sans-serif', fontSize: '22px', fontStyle: '700', color: '#ffffff', stroke: '#080B1A', strokeThickness: 5 }).setOrigin(0.5).setDepth(12);
      label.setShadow(0, 0, carColor(data.n), 10, true, true);
      var e = { sprite: sprite, num: num, label: label, n: data.n, x: data.x, y: data.y, a: data.a, tx: data.x, ty: data.y, ta: data.a, name: null };
      this.cars[data.id] = e;
      return e;
    },

    applyState: function (s) {
      var seen = {}, self = this;
      s.cars.forEach(function (car) {
        var e = self.cars[car.id] || self.makeCar(car);
        if (e.n !== car.n) { e.n = car.n; e.sprite.setTexture('car' + car.n); e.label.setShadow(0, 0, carColor(car.n), 10, true, true); e.num.setText(String(car.n)); }
        e.tx = car.x; e.ty = car.y; e.ta = car.a; e.fin = car.fin; e.off = car.off; e.slow = car.slow; e.spd = car.spd; e.dnf = car.dnf;
        seen[car.id] = true;
      });
      Object.keys(this.cars).forEach(function (id) {
        if (!seen[id]) { var e = self.cars[id]; e.sprite.destroy(); e.num.destroy(); e.label.destroy(); delete self.cars[id]; }
      });
    },

    refreshNames: function () {
      var self = this;
      Object.keys(this.cars).forEach(function (id) {
        var e = self.cars[id], nm = nameOf(id);
        if (e.name !== nm) { e.name = nm; e.label.setText(nm); }
      });
    },

    fx: function (events) {
      var self = this;
      events.forEach(function (ev) {
        var car = ev.id && self.cars[ev.id];
        if (ev.type === 'collision') { self.spark(ev.x, ev.y, 0xffffff); self.spark(ev.x, ev.y, 0xfbbc04); self.cameras.main.shake(120, 0.0022); audio.crash(); }
        else if (ev.type === 'checkpoint') { var g = self.cp[ev.idx - 1]; if (g) { g.setAlpha(1); self.tweens.add({ targets: g, alpha: 0.55, duration: 500 }); } }
        else if (ev.type === 'lap' && car) { self.floatText(car.x, car.y - 60, 'LAP ' + (ev.lap + 1), '#00E5FF'); audio.lap(); }
        else if (ev.type === 'finish' && car) { self.floatText(car.x, car.y - 60, 'FINISH  P' + ev.pos, '#FBBC04'); self.spark(car.x, car.y, 0x34a853); audio.lap(); }
        else if (ev.type === 'obstacle') {
          var o = self.obst[ev.idx]; if (o) { self.spark(o.x, o.y, 0xea4335); }
        }
      });
    },

    spark: function (x, y, color) {
      for (var i = 0; i < 14; i++) {
        var c = this.add.circle(x, y, Phaser.Math.Between(2, 4), color).setDepth(20).setBlendMode(Phaser.BlendModes.ADD);
        var ang = Math.random() * Math.PI * 2, dist = Phaser.Math.Between(25, 75);
        this.tweens.add({ targets: c, x: x + Math.cos(ang) * dist, y: y + Math.sin(ang) * dist, alpha: 0, scale: 0.2, duration: Phaser.Math.Between(250, 520), onComplete: function () { this.targets[0].destroy(); } });
      }
    },

    floatText: function (x, y, text, color) {
      var t = this.add.text(x, y, text, { fontFamily: 'Orbitron, sans-serif', fontSize: '30px', fontStyle: '800', color: color, stroke: '#080B1A', strokeThickness: 6 }).setOrigin(0.5).setDepth(30);
      this.tweens.add({ targets: t, y: y - 60, alpha: 0, duration: 1100, onComplete: function () { t.destroy(); } });
    },

    update: function (time, delta) {
      var k = 1 - Math.exp(-(delta / 1000) * 18), now = time, self = this;
      Object.keys(this.cars).forEach(function (id) {
        var e = self.cars[id];
        e.x += (e.tx - e.x) * k; e.y += (e.ty - e.y) * k;
        var da = Phaser.Math.Angle.Wrap(e.ta - e.a); e.a += da * k;
        e.sprite.setPosition(e.x, e.y).setRotation(e.a);
        e.num.setPosition(e.x + Math.cos(e.a) * 4, e.y + Math.sin(e.a) * 4).setRotation(e.a);
        // name trails behind the car, so six cars in one start row never have overlapping labels
        var back = 34 + e.label.width / 2;
        e.label.setPosition(e.x - Math.cos(e.a) * back, e.y - Math.sin(e.a) * back);
        var alpha = e.fin || e.dnf ? 0.4 : e.off ? 0.55 : 1;
        e.sprite.setAlpha(alpha); e.num.setAlpha(alpha); e.label.setAlpha(e.fin || e.dnf ? 0.55 : 1);
        if (e.slow && !e.fin) e.sprite.setScale(1 + Math.sin(now / 40) * 0.04); else e.sprite.setScale(1);
        if (e.spd > 40 && !e.fin && now - self.lastTrail > 55 && snapshot && snapshot.status === 'racing') {
          var t = self.add.circle(e.x - Math.cos(e.a) * 20, e.y - Math.sin(e.a) * 20, 6, hexNum(carColor(e.n)), 0.45).setDepth(4).setBlendMode(Phaser.BlendModes.ADD);
          self.tweens.add({ targets: t, alpha: 0, scale: 0.2, duration: 450, onComplete: function () { t.destroy(); } });
        }
      });
      if (now - this.lastTrail > 55) this.lastTrail = now;
      var P = TRACK.P, half = TRACK.half;
      this.lights2.forEach(function (l) {
        var side = l.k % 2 ? half : -half, s = (now / 1000 * 140 + (l.k >> 1) * (P / 14)) % P, p = TRACK.pointAt(s, side);
        l.c.setPosition(p.x, p.y);
      });
    },
  });

  new Phaser.Game({
    type: Phaser.AUTO, width: 1920, height: 1080, parent: 'game', backgroundColor: '#080B1A',
    scale: { mode: Phaser.Scale.NONE }, scene: [RaceScene], fps: { target: 60 }, render: { antialias: true },
  });

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
        d.style.setProperty('--c', p.color);
        d.appendChild(el('div', 'num', p.carId));
        var box = el('div'); var nm = el('div', 'nm', p.name); nm.dir = 'auto';
        box.appendChild(nm); box.appendChild(el('div', 'sub', p.connected ? p.carName + ' car' : 'disconnected…'));
        d.appendChild(box);
        var x = el('button', 'x', '✕'); x.title = 'Remove player'; x.dataset.id = p.id; d.appendChild(x);
      } else d.appendChild(el('span', null, 'Waiting for player ' + (i + 1) + '…'));
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
    $('btn-new').textContent = aborted ? 'Back to lobby' : 'New round';
    var pod = $('podium'); pod.innerHTML = '';
    [[1, 'p2', '2nd'], [0, 'p1', '1st'], [2, 'p3', '3rd']].forEach(function (cfg) {
      var r = fin[cfg[0]]; if (!r) return;
      var d = el('div', 'pod ' + cfg[1]); d.style.setProperty('--c', r.color);
      d.appendChild(el('div', 'medal', cfg[2]));
      var nm = el('div', 'nm', r.name); nm.dir = 'auto'; d.appendChild(nm);
      d.appendChild(el('div', 'tm', fmtTime(r.finishTime)));
      pod.appendChild(d);
    });
    var ol = $('results-list'); ol.innerHTML = '';
    res.forEach(function (r) {
      var li = el('li'); li.style.setProperty('--c', r.color);
      li.appendChild(el('span', null, r.finishPosition));
      li.appendChild(el('span', null, '#' + r.carId));
      var nm = el('span', null, r.name); nm.dir = 'auto'; li.appendChild(nm);
      li.appendChild(el('span', r.resultStatus === 'DNF' ? 'dnf' : null, r.resultStatus === 'DNF' ? 'DNF · ' + r.completedLaps + ' laps' : fmtTime(r.finishTime)));
      ol.appendChild(li);
    });
  }

  function confetti() {
    var colors = [GDG.COLORS.gBlue, GDG.COLORS.gRed, GDG.COLORS.gYellow, GDG.COLORS.gGreen, GDG.COLORS.cyan, GDG.COLORS.purple];
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

  function attach(secret) {
    var payload = { origin: location.origin }, saved = load();
    if (saved) { payload.token = saved.token; payload.code = saved.code; }
    var sec = secret || sessionStorage.getItem('gdg_secret');
    if (sec) payload.secret = sec;
    if (!payload.token && !payload.secret) { room = null; renderAll(); return; }
    socket.emit(EVT.CREATE_ROOM, payload, function (res) {
      if (!res || !res.ok) {
        try { sessionStorage.removeItem('gdg_host'); sessionStorage.removeItem('gdg_secret'); } catch (e) { /* ignore */ }
        room = null; renderAll();
        $('login-error').textContent = (res && res.error) || 'Could not connect.';
        return;
      }
      $('login-error').textContent = '';
      save(res.token, res.room.code);
      joinUrl = res.joinUrl; qr = res.qr; room = res.room;
      renderAll();
    });
  }

  socket.on('connect', function () { show('conn', false); attach(); });
  socket.on('disconnect', function () { show('conn', true); });

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
