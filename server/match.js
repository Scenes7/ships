// One running match: owns its players, map, bullets and round flow.
// Written for any number of players/teams; duel = 2 players, 1 per team.
import {
  DEFAULT_STATS, TICK_RATE, SNAPSHOT_RATE, INTRO_DELAY, ROUND_START_DELAY,
  ROUND_END_DELAY, PLAYER_COLORS, KEY_FIRE,
} from '../client/shared/constants.js';
import { generateMaze, pickSpawns, stepTank, stepBullet, createBullet } from '../client/shared/sim.js';

const MAX_QUEUED_INPUTS = 8;   // inputs buffered per player before old ones are dropped
const INPUT_HOLD_TICKS = 6;    // repeat the last input this long if the client goes quiet

const r2 = (n) => Math.round(n * 100) / 100;

export class Match {
  constructor(id, mode, modeConfig, conns, onEnd) {
    this.id = id;
    this.mode = mode;
    this.bestOf = modeConfig.bestOf;
    this.roundsToWin = Math.ceil(modeConfig.bestOf / 2);
    this.onEnd = onEnd;
    this.tickCount = 0;
    this.round = 0;
    this.bullets = [];
    this.nextBulletId = 1;
    this.map = null;
    this.phase = 'countdown';
    this.timer = 0;
    this.over = false;

    this.players = conns.map((conn, i) => ({
      conn,
      id: conn.id,
      name: conn.name,
      color: i % PLAYER_COLORS.length,
      team: i, // free-for-all teams of one; tdm would assign shared teams here
      stats: { ...DEFAULT_STATS },
      x: 0, y: 0, a: 0,
      alive: true, hp: 0, ammo: 0, cooldown: 0,
      inputs: [], lastKeys: 0, idle: 0, ack: 0,
      connected: true,
    }));
    this.scores = {};
    for (const p of this.players) this.scores[p.team] = 0;

    for (const p of this.players) {
      p.conn.match = this;
      p.conn.send({
        t: 'match',
        you: p.id,
        mode,
        bestOf: this.bestOf,
        players: this.players.map((q) => ({ id: q.id, name: q.name, color: q.color, team: q.team })),
        rules: p.stats,
      });
    }
    this.startRound();
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const p of this.players) if (p.connected) p.conn.sendRaw(data);
  }

  startRound() {
    this.round++;
    this.map = generateMaze();
    this.bullets = [];
    const spawns = pickSpawns(this.map, this.players.length);
    this.players.forEach((p, i) => {
      Object.assign(p, spawns[i]);
      p.alive = p.connected;
      p.hp = p.stats.maxHp;
      p.ammo = p.stats.maxAmmo;
      p.cooldown = 0;
    });
    this.phase = 'countdown';
    this.timer = this.round === 1 ? INTRO_DELAY : ROUND_START_DELAY;
    this.broadcast({ t: 'round', round: this.round, map: this.map, intro: this.round === 1, countdown: this.timer });
    this.sendSnapshot();
  }

  handleInput(conn, msg) {
    const p = this.players.find((q) => q.conn === conn);
    if (!p || !Number.isInteger(msg.s) || !Number.isInteger(msg.k)) return;
    p.inputs.push({ seq: msg.s, keys: msg.k & 0xff });
    if (p.inputs.length > MAX_QUEUED_INPUTS) p.inputs.splice(0, p.inputs.length - MAX_QUEUED_INPUTS);
  }

  removePlayer(conn) {
    const p = this.players.find((q) => q.conn === conn);
    if (!p || this.over) return;
    p.connected = false;
    p.alive = false;
    const remaining = this.players.filter((q) => q.connected);
    const teams = new Set(remaining.map((q) => q.team));
    if (teams.size <= 1) {
      const winner = remaining[0] ? remaining[0].team : null;
      this.endMatch(winner, 'forfeit');
    }
  }

  tick(dt) {
    if (this.over) return;
    this.tickCount++;
    const playing = this.phase === 'playing';

    for (const p of this.players) {
      let input = p.inputs.shift();
      if (input) {
        p.ack = input.seq;
        p.lastKeys = input.keys;
        p.idle = 0;
      } else {
        // No input this tick (network jitter / hidden tab): briefly repeat the
        // last movement, then stop. Never repeat a shot.
        p.idle++;
        input = { keys: p.idle <= INPUT_HOLD_TICKS ? p.lastKeys & ~KEY_FIRE : 0 };
      }
      if (!playing || !p.alive) continue;

      const others = this.players.filter((q) => q !== p && q.alive);
      stepTank(p, input.keys, p.stats, dt, this.map.walls, others);

      p.cooldown = Math.max(0, p.cooldown - dt);
      p.ammo = Math.min(p.stats.maxAmmo, p.ammo + dt / p.stats.reloadTime);
      if ((input.keys & KEY_FIRE) && p.ammo >= 1 && p.cooldown === 0) {
        const b = createBullet(this.nextBulletId++, p, p.stats, this.map.walls);
        p.ammo -= 1;
        p.cooldown = p.stats.fireCooldown;
        if (b) this.bullets.push(b);
      }
    }

    if (playing || this.phase === 'roundOver') {
      const living = this.players.filter((p) => p.alive);
      this.bullets = this.bullets.filter((b) => {
        const res = stepBullet(b, dt, this.map.walls, living);
        if (!res) return true;
        if (res.hit && this.phase === 'playing') {
          const t = res.hit;
          t.hp -= b.damage;
          if (t.hp <= 0) t.alive = false;
        }
        return false;
      });
    }

    if (this.phase === 'playing') {
      const aliveTeams = new Set(this.players.filter((p) => p.alive).map((p) => p.team));
      if (aliveTeams.size <= 1) {
        const winner = aliveTeams.size ? [...aliveTeams][0] : null; // null = simultaneous kill, draw
        if (winner !== null) this.scores[winner]++;
        this.phase = 'roundOver';
        this.timer = ROUND_END_DELAY;
        this.broadcast({ t: 'roundEnd', winner, scores: this.scores });
      }
    } else {
      this.timer -= dt;
      if (this.timer <= 0) {
        if (this.phase === 'countdown') {
          this.phase = 'playing';
        } else if (this.phase === 'roundOver') {
          const champ = Object.keys(this.scores).find((t) => this.scores[t] >= this.roundsToWin);
          if (champ !== undefined) this.endMatch(Number(champ), 'score');
          else this.startRound();
          return;
        }
      }
    }

    if (this.tickCount % Math.round(TICK_RATE / SNAPSHOT_RATE) === 0) this.sendSnapshot();
  }

  sendSnapshot() {
    this.broadcast({
      t: 's',
      ph: this.phase,
      tl: r2(Math.max(0, this.timer)),
      p: this.players.map((p) => [p.id, r2(p.x), r2(p.y), r2(p.a), p.alive ? 1 : 0, p.hp, r2(p.ammo), p.ack]),
      b: this.bullets.map((b) => [b.id, r2(b.x), r2(b.y), this.players.find((p) => p.id === b.owner)?.color ?? 0]),
    });
  }

  endMatch(winner, reason) {
    if (this.over) return;
    this.over = true;
    this.phase = 'matchOver';
    this.broadcast({ t: 'matchEnd', winner, scores: this.scores, reason });
    for (const p of this.players) if (p.conn.match === this) p.conn.match = null;
    this.onEnd(this);
  }
}
