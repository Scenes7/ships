// Deterministic game simulation shared by the server (authoritative) and the
// client (prediction of the local tank). No DOM or Node APIs in here.
import {
  TANK_SIZE, BULLET_RADIUS, WALL_THICKNESS, MAZE_CELL, MAZE_COLS, MAZE_ROWS,
  MAZE_EXTRA_OPENINGS, BULLET_LIFETIME, SELF_DAMAGE,
  KEY_FORWARD, KEY_BACK, KEY_LEFT, KEY_RIGHT,
} from './constants.js';

const HALF = TANK_SIZE / 2;

// ---- Maze -------------------------------------------------------------------

// Builds a random maze whose walls sit on the tank-length grid lines.
// Returns { width, height, cols, rows, cellSize, walls: [{x, y, w, h}] }.
export function generateMaze(rng = Math.random, cols = MAZE_COLS, rows = MAZE_ROWS) {
  const S = MAZE_CELL * TANK_SIZE;
  // vWalls[r][c]: wall between (c, r) and (c+1, r). hWalls[r][c]: between (c, r) and (c, r+1).
  const vWalls = Array.from({ length: rows }, () => Array(cols - 1).fill(true));
  const hWalls = Array.from({ length: rows - 1 }, () => Array(cols).fill(true));

  // Recursive backtracker gives a perfect (fully connected) maze.
  const visited = Array.from({ length: rows }, () => Array(cols).fill(false));
  const stack = [[Math.floor(rng() * cols), Math.floor(rng() * rows)]];
  visited[stack[0][1]][stack[0][0]] = true;
  while (stack.length) {
    const [c, r] = stack[stack.length - 1];
    const next = [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]]
      .filter(([nc, nr]) => nc >= 0 && nr >= 0 && nc < cols && nr < rows && !visited[nr][nc]);
    if (!next.length) { stack.pop(); continue; }
    const [nc, nr] = next[Math.floor(rng() * next.length)];
    if (nc !== c) vWalls[r][Math.min(c, nc)] = false;
    else hWalls[Math.min(r, nr)][c] = false;
    visited[nr][nc] = true;
    stack.push([nc, nr]);
  }

  // Knock out extra walls so there are loops and multiple firing lanes.
  for (const grid of [vWalls, hWalls]) {
    for (const row of grid) {
      for (let i = 0; i < row.length; i++) {
        if (row[i] && rng() < MAZE_EXTRA_OPENINGS) row[i] = false;
      }
    }
  }

  const width = cols * S;
  const height = rows * S;
  const t = WALL_THICKNESS;
  const walls = [
    { x: -t / 2, y: -t / 2, w: width + t, h: t },
    { x: -t / 2, y: height - t / 2, w: width + t, h: t },
    { x: -t / 2, y: -t / 2, w: t, h: height + t },
    { x: width - t / 2, y: -t / 2, w: t, h: height + t },
  ];
  // Merge runs of adjacent wall pieces into single rectangles.
  for (let c = 0; c < cols - 1; c++) {
    for (let r = 0; r < rows; r++) {
      if (!vWalls[r][c]) continue;
      let end = r;
      while (end + 1 < rows && vWalls[end + 1][c]) end++;
      walls.push({ x: (c + 1) * S - t / 2, y: r * S - t / 2, w: t, h: (end - r + 1) * S + t });
      r = end;
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
      if (!hWalls[r][c]) continue;
      let end = c;
      while (end + 1 < cols && hWalls[r][end + 1]) end++;
      walls.push({ x: c * S - t / 2, y: (r + 1) * S - t / 2, w: (end - c + 1) * S + t, h: t });
      c = end;
    }
  }
  return { width, height, cols, rows, cellSize: S, walls };
}

// Spawn points centred in maze cells. Two players get opposite sides; larger
// matches (future tdm/ffa) spread players out greedily.
export function pickSpawns(map, count, rng = Math.random) {
  const cell = (c, r, a) => ({ x: (c + 0.5) * map.cellSize, y: (r + 0.5) * map.cellSize, a });
  if (count === 2) {
    return [
      cell(0, Math.floor(rng() * map.rows), Math.PI / 2),
      cell(map.cols - 1, Math.floor(rng() * map.rows), -Math.PI / 2),
    ];
  }
  const spawns = [cell(0, Math.floor(rng() * map.rows), Math.PI / 2)];
  while (spawns.length < count) {
    let best = null;
    let bestDist = -1;
    for (let c = 0; c < map.cols; c++) {
      for (let r = 0; r < map.rows; r++) {
        const p = cell(c, r, 0);
        const d = Math.min(...spawns.map((s) => Math.hypot(s.x - p.x, s.y - p.y)));
        if (d > bestDist) { bestDist = d; best = p; }
      }
    }
    best.a = best.x < map.width / 2 ? Math.PI / 2 : -Math.PI / 2;
    spawns.push(best);
  }
  return spawns;
}

// ---- Collision helpers ------------------------------------------------------

function box(x, y, hw, hh, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return { x, y, hw, hh, ux: c, uy: s, vx: -s, vy: c };
}
const tankBox = (t) => box(t.x, t.y, HALF, HALF, t.a);
const wallBox = (w) => box(w.x + w.w / 2, w.y + w.h / 2, w.w / 2, w.h / 2, 0);

// Separating-axis test between two oriented boxes. Returns the minimum
// translation that moves A out of B, or null when they don't overlap.
function boxOverlap(A, B) {
  let best = null;
  let bestO = Infinity;
  const dx = A.x - B.x, dy = A.y - B.y;
  for (const [nx, ny] of [[A.ux, A.uy], [A.vx, A.vy], [B.ux, B.uy], [B.vx, B.vy]]) {
    const rA = A.hw * Math.abs(nx * A.ux + ny * A.uy) + A.hh * Math.abs(nx * A.vx + ny * A.vy);
    const rB = B.hw * Math.abs(nx * B.ux + ny * B.uy) + B.hh * Math.abs(nx * B.vx + ny * B.vy);
    const d = dx * nx + dy * ny;
    const o = rA + rB - Math.abs(d);
    if (o <= 0) return null;
    if (o < bestO) {
      bestO = o;
      const sign = d < 0 ? -1 : 1;
      best = { x: nx * o * sign, y: ny * o * sign };
    }
  }
  return best;
}

function resolveTank(tank, walls, others) {
  for (let iter = 0; iter < 4; iter++) {
    let moved = false;
    for (const w of walls) {
      const m = boxOverlap(tankBox(tank), wallBox(w));
      if (m) { tank.x += m.x; tank.y += m.y; moved = true; }
    }
    for (const o of others) {
      const m = boxOverlap(tankBox(tank), tankBox(o));
      if (m) { tank.x += m.x; tank.y += m.y; moved = true; }
    }
    if (!moved) return;
  }
}

export function circleHitsTank(x, y, r, tank) {
  const dx = x - tank.x, dy = y - tank.y;
  const c = Math.cos(tank.a), s = Math.sin(tank.a);
  const lx = dx * c + dy * s;
  const ly = -dx * s + dy * c;
  const cx = Math.max(-HALF, Math.min(HALF, lx));
  const cy = Math.max(-HALF, Math.min(HALF, ly));
  return (lx - cx) ** 2 + (ly - cy) ** 2 < r * r;
}

// ---- Tanks ------------------------------------------------------------------

export function forward(a) {
  return { x: Math.sin(a), y: -Math.cos(a) };
}

// Advance one tank by one input tick. `others` are tanks it can't drive through.
export function stepTank(tank, keys, stats, dt, walls, others = []) {
  let turn = 0;
  if (keys & KEY_LEFT) turn -= 1;
  if (keys & KEY_RIGHT) turn += 1;
  if (turn) {
    tank.a += turn * stats.turnRate * dt;
    if (tank.a > Math.PI) tank.a -= 2 * Math.PI;
    if (tank.a < -Math.PI) tank.a += 2 * Math.PI;
    resolveTank(tank, walls, others);
  }
  let speed = 0;
  if (keys & KEY_FORWARD) speed += stats.moveSpeed;
  if (keys & KEY_BACK) speed -= stats.reverseSpeed;
  if (speed) {
    const f = forward(tank.a);
    tank.x += f.x * speed * dt;
    tank.y += f.y * speed * dt;
    resolveTank(tank, walls, others);
  }
}

// ---- Bullets ----------------------------------------------------------------

// Moves a bullet `dt` seconds, bouncing off walls. Returns
//   { dead: true }            - exceeded its bounce limit or lifetime
//   { hit: tank }             - struck a tank (caller applies damage)
//   null                      - still flying
export function stepBullet(b, dt, walls, tanks = []) {
  b.age += dt;
  if (b.age > BULLET_LIFETIME) return { dead: true };
  const dist = Math.hypot(b.vx, b.vy) * dt;
  const steps = Math.max(1, Math.ceil(dist / (BULLET_RADIUS * 0.5)));
  const h = dt / steps;
  const r = BULLET_RADIUS;
  for (let i = 0; i < steps; i++) {
    b.x += b.vx * h;
    b.y += b.vy * h;

    let nx = 0, ny = 0;
    for (const w of walls) {
      const cx = Math.max(w.x, Math.min(w.x + w.w, b.x));
      const cy = Math.max(w.y, Math.min(w.y + w.h, b.y));
      let dx = b.x - cx, dy = b.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r * r) continue;
      let pen;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        dx /= d; dy /= d;
        pen = r - d;
      } else {
        // Centre is inside the wall: push out along the shallowest side.
        const opts = [
          [-1, 0, b.x - w.x], [1, 0, w.x + w.w - b.x],
          [0, -1, b.y - w.y], [0, 1, w.y + w.h - b.y],
        ].sort((p, q) => p[2] - q[2]);
        [dx, dy] = opts[0];
        pen = opts[0][2] + r;
      }
      b.x += dx * pen;
      b.y += dy * pen;
      nx += dx; ny += dy;
    }
    if (nx || ny) {
      const n = Math.hypot(nx, ny);
      nx /= n; ny /= n;
      const dot = b.vx * nx + b.vy * ny;
      if (dot < 0) {
        b.vx -= 2 * dot * nx;
        b.vy -= 2 * dot * ny;
        b.bounces++;
        if (b.bounces > b.maxBounces) return { dead: true };
      }
    }

    for (const t of tanks) {
      if (!t.alive) continue;
      const touching = circleHitsTank(b.x, b.y, r, t);
      if (t.id === b.owner) {
        // The shooter is immune until the bullet has fully left its hull.
        if (!b.armed) { if (!touching) b.armed = true; continue; }
        if (!SELF_DAMAGE) continue;
      }
      if (touching) return { hit: t };
    }
  }
  return null;
}

// Creates a bullet leaving the barrel of `tank`. It starts at the tank's
// centre and is swept to the muzzle so it can never spawn inside a wall.
export function createBullet(id, tank, stats, walls) {
  const f = forward(tank.a);
  const b = {
    id, owner: tank.id, x: tank.x, y: tank.y,
    vx: f.x * stats.bulletSpeed, vy: f.y * stats.bulletSpeed,
    bounces: 0, maxBounces: stats.maxBounces, damage: stats.bulletDamage,
    age: 0, armed: false,
  };
  const muzzle = HALF + BULLET_RADIUS + 1;
  const res = stepBullet(b, muzzle / stats.bulletSpeed, walls);
  b.age = 0;
  return res && res.dead ? null : b;
}
