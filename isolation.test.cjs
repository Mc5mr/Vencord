'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { createServer } = require('../server.cjs');
const { AccountSession, SessionManager } = require('../session.cjs');
const { validateActions } = require('../errors.cjs');

const guildId = '100000000000000001', channelId = '200000000000000001';
const token = 'FAKE_ISOLATION_ACCOUNT.segment.NOT_A_REAL_TOKEN';
const tick = () => new Promise(resolve => setImmediate(resolve));
const config = { apiKey: 'FAKE_SERVICE_KEY_FOR_ISOLATION_TESTS_123456789', maxSessions: 30, node: {} };

function fixture(options = {}) {
  const clients = [];
  const guild = { id: guildId, shard: { send() {} } };
  class Client extends EventEmitter {
    constructor(settings) {
      super(); this.options = settings;
      this.user = { id: String(300000000000000001n + BigInt(clients.length)), username: `PRIVATE_OWNER_${clients.length}` };
      this.ws = { broadcast() {} };
      this.rest = { request: async () => { if (options.error) throw options.error; return {}; } };
      this.channels = { fetch: async id => ({ id, type: 'GUILD_VOICE', guild, permissionsFor: () => ({ has: () => true }) }) };
      clients.push(this);
    }
    async login(value) {
      this.token = value;
      if (options.verifyOnLogin) this.emit('raw', { t: 'READY', d: { required_action: 'REQUIRE_REVERIFIED_EMAIL' } });
    }
    destroy() { this.destroyed = true; this.token = null; }
  }
  class Transport { async connect() {} updateVoice() {} async destroy() {} }
  return { clients, dependencies: { Client, Transport } };
}

test('two devices sharing the service key cannot list or control each other on any session route', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const f = fixture(), manager = new SessionManager(config, f.dependencies);
  const { server } = createServer(config, manager);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(device, route, method = 'GET', body) {
    const headers = { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' };
    if (device) headers['X-AFK-Device-Key'] = device.repeat(64);
    const response = await fetch(base + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  try {
    assert.equal((await request(null, '/v1/sessions')).body.code, 'DEVICE_REQUIRED');
    const a = await request('a', '/v1/sessions', 'POST', { token, guildId, channelId });
    assert.equal(a.status, 202); await tick();
    t.mock.timers.tick(4000);
    const b = await request('b', '/v1/sessions', 'POST', { token: token + '_B', guildId, channelId });
    assert.equal(b.status, 202); await tick();
    for (const [device, own, other] of [['a', a, b], ['b', b, a]]) {
      const listed = await request(device, '/v1/sessions');
      assert.equal(listed.body.deviceIsolation, 1);
      assert.deepEqual(listed.body.value.sessions.map(s => s.id), [own.body.value.id]);
      assert.ok(!JSON.stringify(listed).includes(other.body.value.id));
      assert.ok(!JSON.stringify(listed).includes(device.repeat(64)));
    }
    const route = `/v1/sessions/${a.body.value.id}`;
    const attempts = [
      [route + '/stop', 'POST'], [route, 'DELETE'],
      [route + '/voice', 'POST', { selfMute: true, selfDeaf: true }],
      [route + '/automation', 'POST', { mode: 'off', targetId: '' }],
      [route + '/media', 'POST', { camera: false, share: false }],
      [route + '/actions', 'POST', validateActions()],
      [route + '/dm/preview', 'POST', { channelId }],
      [route + '/dm/start', 'POST', { confirmationId: randomUUID() }],
      [route + '/dm/cancel', 'POST', {}]
    ];
    for (const args of attempts) {
      const denied = await request('b', ...args);
      assert.equal(denied.status, 404, args[0]); assert.equal(denied.body.code, 'NOT_FOUND');
    }
    const stopped = await request('b', '/v1/sessions/stop-all', 'POST');
    assert.deepEqual(stopped.body.value.sessions.map(s => [s.id, s.status]), [[b.body.value.id, 'stopped']]);
    assert.equal(manager.sessions.get(a.body.value.id).status, 'connecting');
    t.mock.timers.tick(4000);
    const forged = await request('b', '/v1/sessions', 'POST', { token: token + '_C', guildId, channelId,
      ownerId: manager.sessions.get(a.body.value.id).ownerId, deviceKey: 'a'.repeat(64) });
    assert.equal(forged.status, 202); await tick();
    assert.equal((await request('a', '/v1/sessions')).body.value.sessions.length, 1);
    const bList = await request('b', '/v1/sessions');
    assert.equal(bList.body.value.sessions.length, 2);
    assert.ok(!JSON.stringify(bList).includes('PRIVATE_OWNER_0'));
  } finally { await manager.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('verification during login stops immediately and blocks repeated account starts', async () => {
  const f = fixture({ verifyOnLogin: true }), manager = new SessionManager(config, f.dependencies);
  const input = { token, guildId, channelId, accountId: randomUUID(), actions: { ...validateActions(), afk: true, njm: true, typing: true } };
  try {
    const created = manager.create(input, 30, 'device-A'), session = manager.sessions.get(created.id);
    await tick(); await session.stopping;
    assert.equal(session.publicData().errorCode, 'AUTH_REVIEW');
    assert.equal(f.clients[0].destroyed, true);
    assert.equal(session.initialActions.afk, false); assert.equal(session.initialActions.njm, false);
    assert.equal(f.clients[0].options.captchaRetryLimit, 0); assert.equal(f.clients[0].options.TOTPKey, null);
    assert.throws(() => manager.create(input, 30, 'device-A'), error => error.code === 'ACCOUNT_PAUSED');
    assert.deepEqual(manager.list('device-B'), []);
    assert.ok(session.publicData().retryAt > Date.now());
  } finally { await manager.close(); }
});

test('authentication, rate-limit, agreement and reconnect failures close the client without retrying', async () => {
  for (const scenario of ['auth', 'rate', 'agreements', 'reconnect', 'disconnected']) {
    const error = { httpStatus: 401, authorization: token };
    const f = fixture(scenario === 'auth' ? { error } : {});
    const session = new AccountSession({ token, guildId, channelId }, {}, () => {}, () => {}, f.dependencies);
    try {
      await session.start(); const client = f.clients[0];
      if (scenario === 'auth') await assert.rejects(client.rest.request('get', '/users/@me'));
      if (scenario === 'agreements') await assert.rejects(client.rest.request('post', '/users/@me/agreements'));
      if (scenario === 'rate') assert.equal(client.options.rejectOnRateLimit({ timeout: 120_000 }), true);
      if (scenario === 'reconnect') client.emit('shardReconnecting');
      if (scenario === 'disconnected') client.emit('shardDisconnect', { code: 1006 });
      assert.equal(client.destroyed, true, scenario);
      await session.stopping;
      assert.equal(session.errorCode, scenario === 'rate' ? 'RATE_LIMITED' : scenario === 'reconnect' ? 'RECONNECT_STOPPED' : scenario === 'disconnected' ? 'DISCONNECTED' : 'AUTH_REVIEW');
      assert.ok(!JSON.stringify(session.publicData()).includes(token));
    } finally { await session.stop(); }
  }
});
