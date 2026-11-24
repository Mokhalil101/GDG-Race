# GDG RACE: Code to Victory

Real-time multiplayer QR racing game for GDG Assiut events (SRS v1.1).
Scan. Join. Race. Win.

- **Host screen** (`/host`): Phaser 3 track, lobby with QR code, countdown, HUD, leaderboard, results.
- **Phone controller** (`/play`): name, car pick, big LEFT / RIGHT buttons.
- **Server**: Node.js + Express + Socket.IO. The server runs the whole race (movement, collisions, laps, ranking), so phones can only send steering.

## 1. Run it locally (5 minutes)

Requirements: Node.js 18 or newer, and a laptop plus phones on the same Wi-Fi.

```bash
cd gdg-race
npm install
npm test            # 27 unit tests, optional
npm start
```

1. Open `http://localhost:3000/host` on the laptop connected to the projector.
2. Enter the host key. Without `HOST_SECRET` set, the dev key is `gdg-race`.
3. The QR code automatically points to the laptop's Wi-Fi address (for example `http://192.168.1.20:3000/play?room=ABCD`). Phones scan it, enter a name, pick a car and join.
4. Press **Space** (or the Start button). A 10 to 1 countdown runs, then the race starts.

**Phone can't open the QR link? Quick diagnosis**

1. On the phone browser type the address shown under the room code (for example `http://192.168.1.20:3000/play`) by hand. If it doesn't open, the problem is the network, not the game.
2. The laptop and phone must be on the **same Wi-Fi** (not mobile data, not a guest network). Turn off mobile data on the phone.
3. Windows: allow Node.js through the firewall (first run prompt: tick **Private networks**), or run once in an admin PowerShell: `New-NetFirewallRule -DisplayName "GDG Race" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow`.
4. Wrong address in the QR (VPN, VirtualBox, WSL...): disconnect the VPN, or start with the right address: `PUBLIC_URL=http://192.168.1.20:3000 npm start` (Windows PowerShell: `$env:PUBLIC_URL="http://192.168.1.20:3000"; npm start`).
5. Hotspot trick: if the venue Wi-Fi isolates devices, turn on a phone hotspot and connect the laptop and the other phones to it.

If phones can't open the page: make sure they are on the same Wi-Fi, the router doesn't isolate clients (guest networks often do), and the laptop firewall allows port 3000.

### Host keyboard shortcuts

| Key | Action |
|---|---|
| Space | Start race (lobby) |
| Esc | Cancel countdown |
| P | Pause / resume |
| A (twice) | Abort race |
| R (twice during a race) | Reset to lobby |
| N or Enter | New round (after results) |
| M | Mute |
| F | Fullscreen |

**Full screen:** the first click or key press on the host page switches to full screen. `F` or a double-click toggles it, `Esc` leaves it. The screen is designed at 1920x1080 and scaled to fit any display; on 16:10 laptops or ultrawide screens the extra margin is the same navy as the background. The mouse pointer hides after 3 seconds in full screen.

Hover the lobby slots to get an ✕ button that removes a player. Laps, crash penalty and obstacles are configurable in the lobby.

### Testing without phones
Open `http://localhost:3000/play?room=ABCD` in several browser tabs (use the real room code). On a laptop, steer with Arrow keys or A / D.

## 1b. Players on different networks (mobile data, other Wi-Fi)

`npm start` on a laptop is only reachable from the same Wi-Fi. For everyone to join from anywhere you need a public HTTPS address. Two ways:

**A. Quick tunnel from your laptop (no deployment, good for a demo or a test)**
```bash
npm start
cloudflared tunnel --url http://localhost:3000     # prints https://something.trycloudflare.com
```
Open that https address on the laptop as the host page (`.../host`). The QR code uses the address you opened, so phones anywhere can scan it. (`ngrok http 3000` works the same way.) The laptop must stay on and connected.

**B. Host it on a server (recommended for the real event)**
Use any Node host that supports WebSockets (Render, Railway, Fly.io, a VPS). Settings:
- Build command: `npm install`  ·  Start command: `npm start`
- Environment: `NODE_ENV=production`, `HOST_SECRET=<long random key>`, `PUBLIC_URL=https://<your-app-url>`
- Run **one instance only** (rooms are kept in memory). Free plans may sleep when idle: open the host page a few minutes before the event to wake it.

## 2. Deploy for a real event (HTTPS, SRS 14)

Any VPS or host that supports WebSockets works (Render, Railway, Fly.io, a small VPS). Example with a VPS and Caddy for automatic HTTPS:

```bash
# on the server
git clone <your repo> gdg-race && cd gdg-race
npm install --omit=dev
export NODE_ENV=production
export PORT=3000
export PUBLIC_URL=https://race.yourdomain.com
export HOST_SECRET="a-long-random-string"
export FORCE_HTTPS=1
npm start            # use pm2 or systemd to keep it running
```

`Caddyfile`:
```
race.yourdomain.com {
  reverse_proxy localhost:3000
}
```

Caddy handles HTTPS and WebSocket upgrades. With nginx, add the `Upgrade` and `Connection` headers for `/socket.io/`.

Environment variables (see `.env.example`): `PORT`, `NODE_ENV`, `PUBLIC_URL`, `HOST_SECRET`, `FORCE_HTTPS`.
In production the server refuses to start without `HOST_SECRET`.

## 3. Logo and branding

Put the official logo at `public/assets/logo.png`. It is picked up automatically on every screen. Without it, a text wordmark with the four GDG dots is shown.

The host and controller pages load the Orbitron and Rajdhani fonts from Google Fonts. Without internet they fall back to system fonts and everything still works.

## 4. Pre-event checklist (SRS 14.5)

- [ ] Open `/host` on the real projector at 1920x1080, press F for fullscreen.
- [ ] Join with at least 3 to 6 real phones (Android Chrome and iPhone Safari).
- [ ] Hold LEFT and RIGHT: the car should respond immediately; no scrolling or zooming.
- [ ] Switch a phone to airplane mode and back: it should reconnect to the same car.
- [ ] Refresh the host page mid-race: the room and race continue.
- [ ] Check sound (browsers need one click or key press on the host page first).
- [ ] Run a full 3-lap race and a "New round".

Active rooms live in memory. If the server restarts during an event, players must rescan the QR code (SRS 9.9).

## 5. Project layout

```
shared/game.js      colours, cars, socket event names, config, track geometry (used by server AND browser)
server/sim.js       race simulation: steering, speed, collisions, laps, ranking (pure, tested)
server/rooms.js     room state machine, players, results, reconnection
server/index.js     Express + Socket.IO, host auth, rate limiting, QR generation
public/host.*       host display (Phaser 3)
public/play.*       phone controller
test/game.test.js   unit tests
```

## 6. Tuning the game

Everything lives in `shared/game.js` under `CONFIG`:

- `DEFAULTS.laps`, `collisionPenalty`, `raceTimeoutSec`, `finishGraceSec`
- `PHYS.MAX_SPEED`, `LAT_SPEED` (how fast steering is), `WALL_FACTOR`, `DISCONNECT_FACTOR`
- `SIM_HZ` (30), `BROADCAST_HZ` (20)

The track is a stadium shape defined by `TRACK` (length, radius, width). To add another track, replace `centerAt()` with a new path that returns a position and heading for each distance `s`; the simulation and renderer both use it.

## 7. How the SRS requirements map to the code

| SRS section | Where |
|---|---|
| FR-001..012 Host management | `server/rooms.js` (Room methods), host controls in `public/host.js` |
| FR-013..022 Joining, reconnect | `addPlayer`, `reconnectPlayer`, `public/play.js` |
| FR-023..029 Cars | `CARS` in shared/game.js, `selectCar` |
| FR-030..036 Countdown | `startCountdown`, `tick` (server-controlled, 10 to 1) |
| FR-037..051 Racing | `server/sim.js` |
| FR-052..065 Controller | `public/play.*` |
| FR-066..074 Leaderboard, results | `leaderboard()`, `_endRace()`, results screen |
| FR-075..080 Feedback and sound | `public/host.js` (synth sounds, mute with M) |
| SEC-001..012 Security | `server/index.js` (host secret, rate limit, membership checks), `sanitizeName` |
| NFR targets | 30 Hz simulation, 20 Hz broadcast, host interpolates at 60 FPS |

Deliberate choices where the SRS left room: collisions push cars apart sideways and slow them for a short time; optional cars on the road are red obstacles (can be switched off); finished cars coast at half speed while the rest finish; the race ends when everyone finishes, when `finishGraceSec` (25 s) passes after the first finisher, or at the timeout (180 s), and unfinished players are marked DNF.

## 8. Known limits (MVP)

- One race room per host session, kept in memory (the architecture supports several rooms; the UI creates one).
- Sound is synthesised in the browser; no audio files.
- Not tested on real phones in this build environment. Do the checklist above before the event.
