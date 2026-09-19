// Tunable game constants. Shared by the browser client and the Node server,
// so both simulate identically. Change a value here and restart the server /
// redeploy the site.

// ---- Core gameplay tuning ---------------------------------------------------
export const MOVE_SPEED = 110;             // world units per second, forward
export const REVERSE_SPEED = 80;           // world units per second, backward
export const TURN_RATE = Math.PI;          // radians per second (180°/s)
export const BULLET_SPEED = 260;           // world units per second
export const MAX_BOUNCES = 3;              // wall bounces before a bullet disappears
export const MAX_HP = 1;                   // hitpoints per round
export const BULLET_DAMAGE = 1;
export const MAX_AMMO = 3;                 // bullets a tank can hold
export const RELOAD_TIME = 5;              // seconds to regain 1 bullet
export const FIRE_COOLDOWN = 0.15;         // minimum seconds between shots
export const BULLET_LIFETIME = 15;         // safety cap, seconds
export const SELF_DAMAGE = true;           // can your own ricochet kill you?

// Per-player stats start from these values. Upgrades (later) modify a copy
// on the player object, never these defaults.
export const DEFAULT_STATS = Object.freeze({
  moveSpeed: MOVE_SPEED,
  reverseSpeed: REVERSE_SPEED,
  turnRate: TURN_RATE,
  bulletSpeed: BULLET_SPEED,
  maxBounces: MAX_BOUNCES,
  maxHp: MAX_HP,
  bulletDamage: BULLET_DAMAGE,
  maxAmmo: MAX_AMMO,
  reloadTime: RELOAD_TIME,
  fireCooldown: FIRE_COOLDOWN,
});

// ---- World ------------------------------------------------------------------
export const TANK_SIZE = 40;               // tank side length; also the grid spacing
export const BULLET_RADIUS = 4;
export const WALL_THICKNESS = 6;
export const MAZE_CELL = 3;                // maze corridor width, in tank lengths
export const MAZE_COLS = 9;
export const MAZE_ROWS = 6;
export const MAZE_EXTRA_OPENINGS = 0.3;    // fraction of leftover walls removed to create loops
export const WORLD_WIDTH = MAZE_COLS * MAZE_CELL * TANK_SIZE;
export const WORLD_HEIGHT = MAZE_ROWS * MAZE_CELL * TANK_SIZE;

// ---- Timing / networking ----------------------------------------------------
export const TICK_RATE = 60;               // simulation steps per second
export const SNAPSHOT_RATE = 30;           // server -> client state updates per second
export const INTRO_DELAY = 5;              // seconds before round 1 (instructions shown)
export const ROUND_START_DELAY = 2;        // countdown before later rounds
export const ROUND_END_DELAY = 2.5;        // pause after a round is decided

// ---- Game modes -------------------------------------------------------------
// Matchmaking and matches are written for N players / teams; only duel is
// enabled today. tdm/ffa can be added here with team assignment.
export const MODES = Object.freeze({
  duel: { playersPerMatch: 2, bestOf: 5 },
});

export const PLAYER_COLORS = [
  { name: 'Blue', hex: '#1e9bf0', sprite: 'assets/blueTank.png' },
  { name: 'Red', hex: '#e8413c', sprite: 'assets/redTank.png' },
];

// Input bitmask sent every tick by the client.
export const KEY_FORWARD = 1;
export const KEY_BACK = 2;
export const KEY_LEFT = 4;
export const KEY_RIGHT = 8;
export const KEY_FIRE = 16;
