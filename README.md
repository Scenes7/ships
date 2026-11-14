# Tank Duel

A top-down 1v1 tank game played in the browser. Walls form a maze, bullets bounce, one hit kills, and a match is best of 5 rounds.

## Architecture

```
Cloudflare Worker "tank-duel"  (tanks.dreamteamhub.ca)
  ├─ static assets: client/  (HTML/JS/canvas)
  └─ /ws, /health ──► Durable Object "Lobby" (worker/)  — matchmaking + 60 Hz sim
```

- **Client** (`client/`): plain ES modules with no build step. Workers Static Assets serves the folder as-is.
- **Server** (`worker/`): a Worker routes `/ws` to one Durable Object (`Lobby`) that holds the queues and matches in memory, runs the simulation at 60 Hz and sends snapshots at 30 Hz.
- **Shared** (`client/shared/`): constants and physics used by **both** sides. The worker imports them from `../client/shared`. The client uses them to predict its own tank, so movement feels instant, and reconciles with the server. Other tanks and bullets are drawn 100 ms behind the server, interpolated between snapshots.
- **Multiplayer-ready**: matchmaking keeps one queue per mode (`MODES` in `constants.js`). `Match` handles N players on teams, and spawns spread out for more than 2 players. To add TDM or FFA, add a mode entry and assign teams in `Match`.

## Tuning

Everything is in `client/shared/constants.js`:

| Constant | Default |
|---|---|
| `MOVE_SPEED` / `REVERSE_SPEED` | 110 / 80 units/s (a tank is 40 units) |
| `TURN_RATE` | π rad/s (180°/s) |
| `BULLET_SPEED` | 260 units/s |
| `MAX_BOUNCES` | 3 |
| `MAX_HP` / `BULLET_DAMAGE` | 1 / 1 |
| `MAX_AMMO` / `RELOAD_TIME` | 3 / 5 s per bullet |
| `FIRE_COOLDOWN`, `SELF_DAMAGE`, maze size, timings | see file |

Each player gets their own copy of `DEFAULT_STATS` (`player.stats` in `worker/match.js`). Upgrades should change that copy. The client gets it in the `match` message, so the HUD and prediction stay in sync.

After changing constants, run `npm run deploy`.

## Run locally

```bash
npm install
npm run dev                      # http://localhost:8787, open in two tabs
npm run test:e2e                 # protocol E2E against localhost:8787 (BASE=https://... for prod)
SITE=http://localhost:8787/ node test/browser.js   # two-player browser test (needs playwright)
```

The client connects to `/ws` on whatever host served the page. Override with `?server=wss://host/ws`.

## Deploy

```bash
npm run deploy                   # wrangler deploy: uploads client/ + worker, binds tanks.dreamteamhub.ca
```

Requires Node 22+ and `wrangler login`. Cost: free tier (Workers + SQLite-backed Durable Objects).
