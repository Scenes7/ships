// Durable Object that runs the game server: connections, matchmaking and the
// 60 Hz tick loop. One instance ("global") holds every queue and match, so
// players anywhere can be paired. State is in memory, as on the old Node server;
// the object stays resident while any WebSocket is connected.
import { DurableObject } from 'cloudflare:workers';
import { MODES, TICK_RATE } from '../client/shared/constants.js';
import { Match } from './match.js';

const MAX_NAME = 16;
const MAX_PAYLOAD = 1024;
const IDLE_TIMEOUT_MS = 45_000; // clients ping every 15 s; drop sockets silent longer than this

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.nextConnId = 1;
    this.nextMatchId = 1;
    this.queues = new Map(Object.keys(MODES).map((m) => [m, []])); // mode -> waiting conns
    this.matches = new Set();
    this.conns = new Set();
    this.loop = null;
    this.reaper = null;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      const queued = [...this.queues.values()].reduce((n, q) => n + q.length, 0);
      return new Response(`ok ${this.matches.size} matches, ${queued} queued\n`, {
        headers: { 'content-type': 'text/plain' },
      });
    }
    const { 0: client, 1: ws } = new WebSocketPair();
    ws.accept();
    this.onConnect(ws);
    return new Response(null, { status: 101, webSocket: client });
  }

  onConnect(ws) {
    const conn = {
      id: this.nextConnId++,
      name: 'Player',
      ws,
      match: null,
      queuedFor: null,
      lastSeen: Date.now(),
      closed: false,
      sendRaw(data) {
        if (this.closed) return;
        try { ws.send(data); } catch { this.closed = true; }
      },
      send(msg) { this.sendRaw(JSON.stringify(msg)); },
    };
    this.conns.add(conn);
    this.startReaper();
    conn.send({ t: 'hello', id: conn.id });

    ws.addEventListener('message', (e) => {
      conn.lastSeen = Date.now();
      if (typeof e.data !== 'string' || e.data.length > MAX_PAYLOAD) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg && typeof msg === 'object') this.handleMessage(conn, msg);
    });
    const gone = () => this.onDisconnect(conn);
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
  }

  onDisconnect(conn) {
    if (!this.conns.delete(conn)) return;
    conn.closed = true;
    this.dequeue(conn);
    conn.match?.removePlayer(conn);
    try { conn.ws.close(1000, 'bye'); } catch {}
    if (this.conns.size === 0) { clearInterval(this.reaper); this.reaper = null; }
  }

  handleMessage(conn, msg) {
    switch (msg.t) {
      case 'join': {
        const name = String(msg.name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
        conn.name = name || 'Player';
        this.enqueue(conn, typeof msg.mode === 'string' ? msg.mode : 'duel');
        break;
      }
      case 'leaveQueue':
        this.dequeue(conn);
        break;
      case 'input':
        conn.match?.handleInput(conn, msg);
        break;
      case 'leaveMatch':
        conn.match?.removePlayer(conn);
        break;
      case 'ping':
        break; // keepalive only; lastSeen was already updated
    }
  }

  enqueue(conn, mode) {
    if (conn.match || !this.queues.has(mode)) return;
    this.dequeue(conn);
    const queue = this.queues.get(mode);
    queue.push(conn);
    conn.queuedFor = mode;
    const needed = MODES[mode].playersPerMatch;
    if (queue.length >= needed) {
      const group = queue.splice(0, needed);
      for (const c of group) c.queuedFor = null;
      const match = new Match(this.nextMatchId++, mode, MODES[mode], group, (m) => this.matches.delete(m));
      this.matches.add(match);
      this.startLoop();
      console.log(`match ${match.id} started: ${group.map((c) => c.name).join(' vs ')}`);
    } else {
      conn.send({ t: 'queued', mode });
    }
  }

  dequeue(conn) {
    if (!conn.queuedFor) return;
    const queue = this.queues.get(conn.queuedFor);
    const i = queue.indexOf(conn);
    if (i >= 0) queue.splice(i, 1);
    conn.queuedFor = null;
  }

  // Fixed-timestep game loop; only runs while there are matches.
  startLoop() {
    if (this.loop) return;
    const dt = 1 / TICK_RATE;
    let last = Date.now();
    let acc = 0;
    this.loop = setInterval(() => {
      const now = Date.now();
      acc = Math.min(acc + (now - last) / 1000, 0.25);
      last = now;
      while (acc >= dt) {
        for (const m of this.matches) m.tick(dt);
        acc -= dt;
      }
      if (this.matches.size === 0) { clearInterval(this.loop); this.loop = null; }
    }, 1000 / TICK_RATE / 2);
  }

  // Drop connections that stop talking (replaces the Node server's ws ping/pong).
  startReaper() {
    if (this.reaper) return;
    this.reaper = setInterval(() => {
      const cutoff = Date.now() - IDLE_TIMEOUT_MS;
      for (const c of this.conns) if (c.lastSeen < cutoff) this.onDisconnect(c);
    }, 15_000);
  }
}
