# Tank Duel

A top-down 1v1 tank game played in the browser. Walls form a maze, bullets bounce, one hit kills, and a match is best of 5 rounds.

## Architecture

```
GitHub Pages (static)            AWS (one EC2 t4g.nano)
client/  ── HTML/JS/canvas  ──►  Caddy :443 (auto TLS, <ip>.sslip.io)
                         wss://      └─► Node + ws :8080  (server/)
```

- **Client** (`client/`): plain ES modules with no build step. GitHub Pages serves the folder as-is.
- **Server** (`server/`): authoritative Node server that runs the simulation at 60 Hz and sends snapshots at 30 Hz. Its only dependency is `ws`.
- **Shared** (`client/shared/`): constants and physics used by **both** sides. The server imports them from `../client/shared`. The client uses them to predict its own tank, so movement feels instant, and reconciles with the server. Other tanks and bullets are drawn 100 ms behind the server, interpolated between snapshots.
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

Each player gets their own copy of `DEFAULT_STATS` (`player.stats` in `server/match.js`). Upgrades should change that copy. The client gets it in the `match` message, so the HUD and prediction stay in sync.

After changing constants, restart or update the server and push the client.

## Run locally

```bash
cd server && npm install && npm start          # ws://localhost:8080
cd client && python3 -m http.server 5173       # open http://localhost:5173 in two tabs
```

On `localhost` the client connects to `ws://localhost:8080` automatically. On any page you can pick a server with `?server=wss://host`.

## Deploy

**Server (AWS):** requires the AWS CLI with credentials that have the permissions listed below.

```bash
AWS_REGION=us-east-1 deploy/deploy.sh     # creates the stack, writes the wss:// URL into client/config.js
```

The first boot takes about 2 minutes: installs, then the TLS certificate. After you push server changes, run `deploy/update-server.sh`. It uses SSM to pull and restart, so no SSH is needed. To tear everything down, run `aws cloudformation delete-stack --stack-name tank-duel`.

**Client (GitHub Pages):** in the repo, go to Settings → Pages → Source and choose **GitHub Actions**. Every push to `main` that touches `client/` then publishes it. The repo must be public, because the server clones it.

**Cost:** about $3/mo for the t4g.nano plus about $3.60/mo for its public IPv4 address. Pages is free.

### AWS permissions needed

- `cloudformation:*` on the `tank-duel` stack
- `ec2:RunInstances`, `TerminateInstances`, `Describe*`, `CreateSecurityGroup`, `DeleteSecurityGroup`, `AuthorizeSecurityGroupIngress`, `AllocateAddress`, `ReleaseAddress`, `AssociateAddress`, `DisassociateAddress`, `CreateTags`
- `iam:CreateRole`, `DeleteRole`, `AttachRolePolicy`, `DetachRolePolicy`, `CreateInstanceProfile`, `DeleteInstanceProfile`, `AddRoleToInstanceProfile`, `RemoveRoleFromInstanceProfile`, `PassRole`, `GetRole`
- `ssm:GetParameters` (to look up the AMI), `ssm:SendCommand`, `ssm:GetCommandInvocation`, `ssm:ListCommandInvocations`
