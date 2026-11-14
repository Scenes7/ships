// The game server is the same Cloudflare Worker that serves this page, at /ws.
// Override at runtime with ?server=wss://host/ws (handy for testing).
const override = new URLSearchParams(location.search).get('server');
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';

export const SERVER_URL = override || `${proto}//${location.host}/ws`;
