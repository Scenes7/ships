import {
  TANK_SIZE, BULLET_RADIUS, WALL_THICKNESS, TICK_RATE, PLAYER_COLORS,
  KEY_FORWARD, KEY_BACK, KEY_LEFT, KEY_RIGHT, KEY_FIRE,
} from './shared/constants.js';
import { stepTank } from './shared/sim.js';
import { SERVER_URL } from './config.js';

const INTERP_DELAY = 100;     // ms other players/bullets are rendered behind the server
const DT = 1 / TICK_RATE;

const $ = (id) => document.getElementById(id);
const screens = { menu: $('menu'), queue: $('queue'), game: $('game') };
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const overlay = $('overlay');

const sprites = PLAYER_COLORS.map((c) => { const img = new Image(); img.src = c.sprite; return img; });

let ws = null;
let game = null; // state of the current match, null when in menus

function show(name) {
  for (const [k, el] of Object.entries(screens)) el.classList.toggle('hidden', k !== name);
  if (name === 'game') resize();
}

// ---- Networking -------------------------------------------------------------

function connect() {
  return new Promise((resolve, reject) => {
    if (ws && ws.readyState === WebSocket.OPEN) return resolve(ws);
    const sock = new WebSocket(SERVER_URL);
    sock.onopen = () => { ws = sock; resolve(sock); };
    sock.onerror = () => reject(new Error('Could not reach the game server.'));
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      const wasPlaying = game && !game.over;
      game = null;
      show('menu');
      setStatus(wasPlaying ? 'Lost connection to the server.' : '');
    };
    sock.onmessage = (e) => onMessage(JSON.parse(e.data));
  });
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function onMessage(msg) {
  switch (msg.t) {
    case 'queued': show('queue'); break;
    case 'match': startMatch(msg); break;
    case 'round': onRound(msg); break;
    case 's': onSnapshot(msg); break;
    case 'roundEnd': onRoundEnd(msg); break;
    case 'matchEnd': onMatchEnd(msg); break;
  }
}

// ---- Menus ------------------------------------------------------------------

const nameInput = $('name');
try { nameInput.value = localStorage.getItem('tankName') || ''; } catch {}

function setStatus(text) { $('menu-status').textContent = text; }

$('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  try { localStorage.setItem('tankName', name); } catch {}
  setStatus('Connecting…');
  $('play').disabled = true;
  try {
    await connect();
    setStatus('');
    send({ t: 'join', name, mode: 'duel' });
  } catch (err) {
    setStatus(err.message);
  } finally {
    $('play').disabled = false;
  }
});

$('cancel-queue').addEventListener('click', () => {
  send({ t: 'leaveQueue' });
  show('menu');
});

// ---- Match state ------------------------------------------------------------

function startMatch(msg) {
  game = {
    you: msg.you,
    bestOf: msg.bestOf,
    rules: msg.rules,
    players: new Map(msg.players.map((p) => [p.id, p])),
    scores: {},
    round: 0,
    map: null,
    phase: 'countdown',
    timeLeft: 0,
    intro: false,
    snapshots: [],
    me: null,          // predicted local tank
    myServer: null,    // last authoritative local state
    offset: { x: 0, y: 0, a: 0 }, // visual smoothing of prediction corrections
    pending: [],
    seq: 0,
    banner: null,
    over: false,
    explosions: [],
  };
  for (const p of msg.players) game.scores[p.team] = 0;
  buildTicks('hp-ticks', msg.rules.maxHp);
  buildTicks('ammo-ticks', msg.rules.maxAmmo);
  show('game');
  renderScoreboard();
}

function onRound(msg) {
  game.round = msg.round;
  game.map = msg.map;
  game.intro = msg.intro;
  game.banner = null;
  game.snapshots = [];
  game.me = null;
  game.offset = { x: 0, y: 0, a: 0 };
  game.explosions = [];
  resize();
  renderScoreboard();
}

function onSnapshot(msg) {
  const snap = {
    time: performance.now(),
    players: new Map(msg.p.map(([id, x, y, a, alive, hp, ammo, ack]) => [id, { id, x, y, a, alive: !!alive, hp, ammo, ack }])),
    bullets: new Map(msg.b.map(([id, x, y, color]) => [id, { x, y, color }])),
  };
  const prev = game.snapshots[game.snapshots.length - 1];
  if (prev) {
    for (const [id, p] of snap.players) {
      const was = prev.players.get(id);
      if (was && was.alive && !p.alive) game.explosions.push({ x: p.x, y: p.y, color: game.players.get(id).color, t: 0 });
    }
  }
  game.phase = msg.ph;
  game.timeLeft = msg.tl;
  game.snapshots.push(snap);
  while (game.snapshots.length > 30) game.snapshots.shift();
  reconcile(snap.players.get(game.you));
  updateOverlay();
}

// Server-authoritative position + replay of inputs the server hasn't processed yet.
function reconcile(server) {
  if (!server) return;
  game.myServer = server;
  game.pending = game.pending.filter((i) => i.seq > server.ack);
  const before = game.me;
  const me = { id: server.id, x: server.x, y: server.y, a: server.a, alive: server.alive };
  if (game.phase === 'playing' && me.alive) {
    for (const input of game.pending) stepTank(me, input.keys, game.rules, DT, game.map.walls, otherTanks());
  }
  if (before) {
    const dx = before.x + game.offset.x - me.x;
    const dy = before.y + game.offset.y - me.y;
    if (Math.hypot(dx, dy) < TANK_SIZE) {
      game.offset.x = dx;
      game.offset.y = dy;
      game.offset.a = angleDiff(before.a + game.offset.a, me.a);
    } else {
      game.offset = { x: 0, y: 0, a: 0 };
    }
  }
  game.me = me;
}

function otherTanks() {
  const last = game.snapshots[game.snapshots.length - 1];
  if (!last) return [];
  return [...last.players.values()].filter((p) => p.id !== game.you && p.alive);
}

function onRoundEnd(msg) {
  game.scores = msg.scores;
  game.banner = { kind: 'round', winner: msg.winner };
  renderScoreboard();
  updateOverlay();
}

function onMatchEnd(msg) {
  game.scores = msg.scores;
  game.over = true;
  game.banner = { kind: 'match', winner: msg.winner, reason: msg.reason };
  renderScoreboard();
  updateOverlay();
}

// ---- Input ------------------------------------------------------------------

const KEYMAP = {
  KeyW: KEY_FORWARD, ArrowUp: KEY_FORWARD,
  KeyS: KEY_BACK, ArrowDown: KEY_BACK,
  KeyA: KEY_LEFT, ArrowLeft: KEY_LEFT,
  KeyD: KEY_RIGHT, ArrowRight: KEY_RIGHT,
};
const held = new Set();
let firePressed = false;

addEventListener('keydown', (e) => {
  if (!game || e.target === nameInput) return;
  if (KEYMAP[e.code]) { held.add(e.code); e.preventDefault(); }
  if (e.code === 'Space') { if (!e.repeat) firePressed = true; e.preventDefault(); }
});
addEventListener('keyup', (e) => held.delete(e.code));
addEventListener('blur', () => held.clear());

function sampleKeys() {
  let k = 0;
  for (const code of held) k |= KEYMAP[code];
  if (firePressed) { k |= KEY_FIRE; firePressed = false; }
  return k;
}

// One fixed simulation step: send input, predict own movement.
function tick() {
  if (!game || game.over || !game.map) return;
  const keys = sampleKeys();
  const seq = ++game.seq;
  send({ t: 'input', s: seq, k: keys });
  game.pending.push({ seq, keys });
  if (game.me && game.me.alive && game.phase === 'playing') {
    stepTank(game.me, keys, game.rules, DT, game.map.walls, otherTanks());
  }
}

// ---- Rendering --------------------------------------------------------------

let scale = 1;
function resize() {
  if (!game || !game.map) return;
  const stage = $('stage');
  const pad = WALL_THICKNESS;
  const w = game.map.width + pad * 2;
  const h = game.map.height + pad * 2;
  scale = Math.min(stage.clientWidth / w, stage.clientHeight / h);
  const dpr = devicePixelRatio || 1;
  canvas.style.width = `${w * scale}px`;
  canvas.style.height = `${h * scale}px`;
  canvas.width = Math.round(w * scale * dpr);
  canvas.height = Math.round(h * scale * dpr);
}
addEventListener('resize', resize);

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
const lerp = (a, b, t) => a + (b - a) * t;

// Find the two snapshots around `time` for interpolation.
function bracket(time) {
  const s = game.snapshots;
  if (!s.length) return null;
  for (let i = s.length - 1; i > 0; i--) {
    if (s[i - 1].time <= time) {
      const a = s[i - 1], b = s[i];
      return { a, b, t: Math.min(1, Math.max(0, (time - a.time) / (b.time - a.time || 1))) };
    }
  }
  return { a: s[0], b: s[0], t: 0 };
}

function render(frameDt) {
  if (!game || !game.map) return;
  const dpr = devicePixelRatio || 1;
  const pad = WALL_THICKNESS;
  const { width, height, walls } = game.map;
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, pad * scale * dpr, pad * scale * dpr);

  ctx.fillStyle = '#fff';
  ctx.fillRect(-pad, -pad, width + pad * 2, height + pad * 2);

  // Grid: one line per tank length.
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1 / scale;
  ctx.beginPath();
  for (let x = 0; x <= width; x += TANK_SIZE) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
  for (let y = 0; y <= height; y += TANK_SIZE) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
  ctx.stroke();

  ctx.fillStyle = '#000';
  for (const w of walls) ctx.fillRect(w.x, w.y, w.w, w.h);

  const br = bracket(performance.now() - INTERP_DELAY);
  if (br) {
    for (const [id, pb] of br.b.bullets) {
      const pa = br.a.bullets.get(id) || pb;
      ctx.fillStyle = PLAYER_COLORS[pb.color].hex;
      ctx.beginPath();
      ctx.arc(lerp(pa.x, pb.x, br.t), lerp(pa.y, pb.y, br.t), BULLET_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const [id, pb] of br.b.players) {
      if (id === game.you) continue;
      const pa = br.a.players.get(id) || pb;
      if (!pb.alive) continue;
      drawTank(id, lerp(pa.x, pb.x, br.t), lerp(pa.y, pb.y, br.t), pb.a + angleDiff(pa.a, pb.a) * (1 - br.t));
    }
  }

  if (game.me && game.me.alive) {
    const decay = Math.pow(0.001, frameDt); // offset shrinks ~99.9% per second
    game.offset.x *= decay; game.offset.y *= decay; game.offset.a *= decay;
    drawTank(game.you, game.me.x + game.offset.x, game.me.y + game.offset.y, game.me.a + game.offset.a);
  }

  game.explosions = game.explosions.filter((ex) => (ex.t += frameDt) < 0.6);
  for (const ex of game.explosions) {
    const k = ex.t / 0.6;
    ctx.globalAlpha = 1 - k;
    ctx.fillStyle = PLAYER_COLORS[ex.color].hex;
    ctx.beginPath();
    ctx.arc(ex.x, ex.y, TANK_SIZE * (0.4 + k), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  renderHud();
}

function drawTank(id, x, y, a) {
  const info = game.players.get(id);
  if (!info) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  const img = sprites[info.color];
  if (img.complete && img.naturalWidth) {
    ctx.drawImage(img, -TANK_SIZE / 2, -TANK_SIZE / 2, TANK_SIZE, TANK_SIZE);
  } else {
    ctx.fillStyle = PLAYER_COLORS[info.color].hex;
    ctx.fillRect(-TANK_SIZE / 2, -TANK_SIZE / 2, TANK_SIZE, TANK_SIZE);
  }
  ctx.restore();

  ctx.font = `600 ${12}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const label = id === game.you ? `${info.name} (you)` : info.name;
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#fff';
  ctx.strokeText(label, x, y - TANK_SIZE * 0.75);
  ctx.fillStyle = PLAYER_COLORS[info.color].hex;
  ctx.fillText(label, x, y - TANK_SIZE * 0.75);
}

function buildTicks(id, n) {
  $(id).innerHTML = '<span></span>'.repeat(Math.max(1, n));
}

function renderHud() {
  const s = game.myServer;
  if (!s) return;
  const r = game.rules;
  $('hp-fill').style.width = `${(Math.max(0, s.hp) / r.maxHp) * 100}%`;
  // Extrapolate reload between snapshots so the bar fills smoothly.
  let ammo = s.ammo;
  const last = game.snapshots[game.snapshots.length - 1];
  if (game.phase === 'playing' && s.alive && last) {
    ammo = Math.min(r.maxAmmo, ammo + (performance.now() - last.time) / 1000 / r.reloadTime);
  }
  $('ammo-fill').style.width = `${(ammo / r.maxAmmo) * 100}%`;
}

function playerForTeam(team) {
  return [...game.players.values()].find((p) => p.team === team);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderScoreboard() {
  const ps = [...game.players.values()];
  const tag = (p) => `<span><span class="swatch" style="background:${PLAYER_COLORS[p.color].hex}"></span>${esc(p.name)}${p.id === game.you ? ' (you)' : ''}</span>`;
  const scores = ps.map((p) => game.scores[p.team] ?? 0).join(' : ');
  $('scoreboard').innerHTML = ps.length === 2
    ? `${tag(ps[0])}<span class="score">${scores}</span>${tag(ps[1])}<span class="round">Round ${game.round} · Best of ${game.bestOf}</span>`
    : `${ps.map((p) => `${tag(p)} <span class="score">${game.scores[p.team] ?? 0}</span>`).join('')}<span class="round">Round ${game.round}</span>`;
}

let overlayKey = '';
function updateOverlay() {
  const r = game.rules;
  let key, html;
  if (game.banner?.kind === 'match') {
    const { winner, reason } = game.banner;
    const me = game.players.get(game.you);
    const won = winner === me.team;
    const title = reason === 'forfeit' ? (won ? 'Your opponent left — you win!' : 'Match abandoned')
      : won ? 'You win the match!' : `${esc(playerForTeam(winner)?.name ?? 'Opponent')} wins the match`;
    key = `match`;
    html = `<div class="panel"><h2>${title}</h2>
      <p class="big">${[...game.players.values()].map((p) => game.scores[p.team] ?? 0).join(' : ')}</p>
      <button id="again">Play again</button> <button id="to-menu" class="secondary">Main menu</button></div>`;
  } else if (game.banner?.kind === 'round') {
    const w = game.banner.winner;
    const text = w === null ? 'Draw — nobody scores' : w === game.players.get(game.you).team ? 'You win the round!' : `${esc(playerForTeam(w)?.name)} wins the round`;
    key = `round${game.round}`;
    html = `<div class="panel"><h2>${text}</h2></div>`;
  } else if (game.phase === 'countdown') {
    const n = Math.ceil(game.timeLeft);
    key = `cd${game.round}-${n}`;
    const title = game.intro ? 'Get ready!' : `Round ${game.round}`;
    const rules = game.intro ? `
      <table>
        <tr><td><kbd>W</kbd> / <kbd>↑</kbd></td><td>Drive forward</td></tr>
        <tr><td><kbd>S</kbd> / <kbd>↓</kbd></td><td>Drive backward</td></tr>
        <tr><td><kbd>A</kbd> / <kbd>←</kbd></td><td>Turn counter-clockwise</td></tr>
        <tr><td><kbd>D</kbd> / <kbd>→</kbd></td><td>Turn clockwise</td></tr>
        <tr><td><kbd>Space</kbd></td><td>Fire</td></tr>
      </table>
      <table>
        <tr><td>Match</td><td>Best of ${game.bestOf} rounds (first to ${Math.ceil(game.bestOf / 2)})</td></tr>
        <tr><td>Bullet bounces</td><td>${r.maxBounces}</td></tr>
        <tr><td>Hitpoints</td><td>${r.maxHp} (${r.maxHp === r.bulletDamage ? 'one hit kills' : `${r.bulletDamage} per hit`})</td></tr>
        <tr><td>Ammo</td><td>${r.maxAmmo} max, reload 1 every ${r.reloadTime}s</td></tr>
      </table>` : '';
    html = `<div class="panel"><h2>${title}</h2>${rules}<p class="big">${n}</p></div>`;
  } else {
    key = '';
    html = '';
  }
  if (key === overlayKey) return;
  overlayKey = key;
  overlay.innerHTML = html;
  overlay.classList.toggle('hidden', !html);
  $('again')?.addEventListener('click', () => {
    const name = game.players.get(game.you).name;
    game = null;
    overlayKey = '';
    send({ t: 'join', name, mode: 'duel' });
  });
  $('to-menu')?.addEventListener('click', () => {
    game = null;
    overlayKey = '';
    show('menu');
  });
}

// ---- Main loop --------------------------------------------------------------

let lastFrame = performance.now();
let acc = 0;
function frame(now) {
  const frameDt = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;
  acc += frameDt;
  while (acc >= DT) { tick(); acc -= DT; }
  render(frameDt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
