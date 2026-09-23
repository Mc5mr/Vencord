'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once, EventEmitter } = require('node:events');
const { WebSocketServer } = require('ws');
const { LavalinkConnection } = require('../lavalink.cjs');

test('real local WebSocket + HTTP exchange waits for node readiness, forwards only voice credentials, and deletes the player', async () => {
  const requests = [], states = [], failures = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    res.writeHead(req.method === 'DELETE' ? 204 : 200, { 'Content-Type': 'application/json' });
    res.end(req.method === 'DELETE' ? undefined : JSON.stringify({ state: { connected: true } }));
  });
  const wss = new WebSocketServer({ server, path: '/v4/websocket' });
  let handshake;
  wss.on('connection', (socket, req) => { handshake = req.headers; socket.send(JSON.stringify({ op: 'ready', sessionId: 'TEST_NODE_SESSION', resumed: false })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const transport = new LavalinkConnection({ host: '127.0.0.1', port: server.address().port, secure: false, password: 'FAKE_NODE_PASSWORD' }, '300000000000000001', '100000000000000001', state => states.push(state), error => failures.push(error.code));
  try {
    await transport.connect();
    assert.equal(handshake['user-id'], '300000000000000001');
    const voice = { token: 'FAKE_EPHEMERAL_VOICE_TOKEN', endpoint: 'voice.example.invalid:443', sessionId: 'VOICE_SESSION', channelId: '200000000000000001' };
    transport.updateVoice(voice); transport.updateVoice(voice); await transport.updatePromise;
    assert.deepEqual(states, [true]); assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'PATCH'); assert.equal(JSON.parse(requests[0].body).voice.channelId, voice.channelId);
    assert.ok(!requests[0].body.includes('FAKE_ACCOUNT_TOKEN'));
    await transport.destroy();
    assert.equal(requests.at(-1).method, 'DELETE'); assert.deepEqual(failures, []);
  } finally {
    await transport.destroy(); for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

async function simulatedTransport(fetch) {
  const states = [], failures = [];
  class Socket extends EventEmitter { ping() {} terminate() {} }
  const transport = new LavalinkConnection({ host: 'example.invalid', port: 2333, password: 'TEST_ONLY' }, '300000000000000001', '100000000000000001',
    value => states.push(value), error => failures.push(error.code), { WebSocket: Socket, fetch });
  const ready = transport.connect();
  transport.socket.emit('message', JSON.stringify({ op: 'ready', sessionId: 'TEST_ONLY' })); await ready;
  const packet = value => transport.socket.emit('message', JSON.stringify({ guildId: transport.guildId, ...value }));
  const voice = token => ({ token, endpoint: 'voice.invalid', sessionId: 'VOICE', channelId: '200000000000000001' });
  return { transport, states, failures, packet, voice };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const response = connected => Response.json({ state: { connected } });

test('moving ignores old voice close/state frames until fresh credentials settle, then confirms suspicious disconnects', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  let connected = true, pendingPatch;
  const requests = [];
  const f = await simulatedTransport(async (url, options) => {
    requests.push(options.method);
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    if (options.method === 'PATCH' && pendingPatch) return new Promise(resolve => { pendingPatch = resolve; });
    return response(connected);
  });
  const closed = { op: 'event', type: 'WebSocketClosedEvent', code: 4014 };
  try {
    f.transport.updateVoice(f.voice('FIRST')); await f.transport.updatePromise;
    f.transport.beginMove();
    f.packet(closed); f.packet({ op: 'playerUpdate', state: { connected: false } });
    assert.deepEqual(f.failures, []); assert.deepEqual(f.states, [true]);
    pendingPatch = true;
    f.transport.updateVoice(f.voice('SECOND')); await flush();
    f.packet({ op: 'playerUpdate', state: { connected: true } }); f.packet(closed);
    assert.deepEqual(f.states, [true]);
    pendingPatch(response(false)); await f.transport.updatePromise; pendingPatch = null;
    f.packet(closed); assert.deepEqual(f.failures, []);
    f.packet({ op: 'playerUpdate', state: { connected: true } });
    f.packet(closed); t.mock.timers.tick(1000); await flush();
    assert.deepEqual(f.failures, []); assert.equal(requests.at(-1), 'GET');
    connected = false;
    f.packet({ op: 'playerUpdate', state: { connected: false } }); t.mock.timers.tick(1000); await flush();
    assert.deepEqual(f.failures, ['DISCONNECTED']);
    t.mock.timers.tick(5000); f.packet(closed);
    assert.deepEqual(f.failures, ['DISCONNECTED', 'DISCONNECTED']);
  } finally { await f.transport.destroy(); }
});

test('a delayed PATCH from the previous move cannot mark the new voice connection as connected', async () => {
  const pending = [];
  const f = await simulatedTransport(async (url, options) => options.method === 'DELETE'
    ? new Response(null, { status: 204 }) : new Promise(resolve => pending.push(resolve)));
  try {
    f.transport.updateVoice(f.voice('OLD')); await flush();
    f.transport.beginMove(); f.transport.updateVoice(f.voice('NEW'));
    pending[0](response(true)); await flush(); assert.deepEqual(f.states, []);
    pending[1](response(true)); await f.transport.updatePromise; assert.deepEqual(f.states, [true]);
    assert.deepEqual(f.failures, []);
  } finally { for (const resolve of pending) resolve(response(false)); await f.transport.destroy(); }
});
