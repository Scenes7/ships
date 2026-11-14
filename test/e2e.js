// End-to-end test against a running deployment (wrangler dev or production).
// Usage: BASE=https://tanks.dreamteamhub.ca node test/e2e.js   (default http://localhost:8787)
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { KEY_FORWARD, KEY_FIRE } from '../client/shared/constants.js';

const BASE = (process.env.BASE || 'http://localhost:8787').replace(/\/$/, '');
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
const step = (s) => console.log(`✓ ${s}`);

function client(name) {
  const ws = new WebSocket(WS_URL);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const c = {
    name, ws, inbox,
    open: () => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    send: (m) => ws.send(JSON.stringify(m)),
    wait(pred, ms = 15000, label = 'message') {
      const hit = inbox.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error(`${name}: timed out waiting for ${label}`)), ms);
      });
    },
  };
  return c;
}

const res = await fetch(BASE + '/');
assert.equal(res.status, 200);
assert.match(await res.text(), /<canvas|<script/i);
for (const f of ['/main.js', '/config.js', '/shared/sim.js', '/assets/redTank.png']) {
  assert.equal((await fetch(BASE + f)).status, 200, f);
}
step('static client served');

const health = await (await fetch(BASE + '/health')).text();
assert.match(health, /^ok \d+ matches, \d+ queued/);
step(`health: ${health.trim()}`);

const a = client('alice'), b = client('bob');
await Promise.all([a.open(), b.open()]);
const [ha, hb] = await Promise.all([a.wait((m) => m.t === 'hello'), b.wait((m) => m.t === 'hello')]);
assert.notEqual(ha.id, hb.id);
step('both clients connected (hello)');

a.send({ t: 'join', name: 'alice-e2e', mode: 'duel' });
await a.wait((m) => m.t === 'queued', 5000, 'queued');
step('alice queued');
b.send({ t: 'join', name: 'bob-e2e', mode: 'duel' });
const [ma, mb] = await Promise.all([a.wait((m) => m.t === 'match'), b.wait((m) => m.t === 'match')]);
assert.equal(ma.players.length, 2);
assert.deepEqual(ma.players.map((p) => p.name).sort(), ['alice-e2e', 'bob-e2e']);
assert.equal(ma.you, ha.id);
assert.equal(mb.you, hb.id);
step('matched into a duel');

const round = await a.wait((m) => m.t === 'round', 5000, 'round');
assert.equal(round.round, 1);
assert.ok(round.map?.walls?.length > 0, 'map has walls');
step(`round 1 started, ${round.map.walls.length} walls, countdown ${round.countdown}s`);

await a.wait((m) => m.t === 's' && m.ph === 'playing', 10000, 'playing phase');
step('countdown finished, phase=playing');

// Drive alice forward for ~1 s and check the authoritative position moves and inputs are acked.
const before = a.inbox.filter((m) => m.t === 's').at(-1).p.find((p) => p[0] === ha.id);
let seq = 0;
const drive = setInterval(() => a.send({ t: 'input', s: ++seq, k: KEY_FORWARD | (seq === 30 ? KEY_FIRE : 0) }), 1000 / 60);
const keepB = setInterval(() => b.send({ t: 'input', s: Date.now() % 1e9, k: 0 }), 1000 / 60);
await new Promise((r) => setTimeout(r, 1200));
clearInterval(drive);
const snaps = a.inbox.filter((m) => m.t === 's');
const after = snaps.at(-1).p.find((p) => p[0] === ha.id);
const moved = Math.hypot(after[1] - before[1], after[2] - before[2]);
assert.ok(after[7] > 0, 'server acked inputs');
assert.ok(moved > 5 || after[6] < before[6], `tank moved (${moved.toFixed(1)}) or fired`);
const sawBullet = snaps.some((m) => m.b.length > 0);
step(`alice moved ${moved.toFixed(1)} units, ack=${after[7]}, bullet seen=${sawBullet}, ${snaps.length} snapshots`);

// Bob leaving the match should forfeit it to alice.
clearInterval(keepB);
b.ws.close();
const end = await a.wait((m) => m.t === 'matchEnd', 5000, 'matchEnd');
assert.equal(end.reason, 'forfeit');
assert.equal(end.winner, ma.players.find((p) => p.id === ha.id).team);
step('opponent disconnect -> forfeit win');

a.send({ t: 'ping' });
a.ws.close();
console.log('\nALL PASSED');
process.exit(0);
