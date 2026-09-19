// Where the game server lives. Override at runtime with ?server=wss://host
// (handy for testing). Localhost pages default to a local server.
const PRODUCTION_SERVER = 'wss://15-156-243-42.sslip.io';

const override = new URLSearchParams(location.search).get('server');
const isLocal = ['localhost', '127.0.0.1', ''].includes(location.hostname);

export const SERVER_URL = override || (isLocal ? `ws://${location.hostname || 'localhost'}:8080` : PRODUCTION_SERVER);
