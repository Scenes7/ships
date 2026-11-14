// Worker entry: static files in client/ are served by Workers Static Assets;
// /ws (game WebSocket) and /health go to the Lobby Durable Object.
export { Lobby } from './lobby.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws' || url.pathname === '/health') {
      return env.LOBBY.getByName('global').fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
