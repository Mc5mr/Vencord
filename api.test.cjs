'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomUUID, scryptSync } = require('node:crypto');
const { createServer } = require('../server.cjs');
const { PublicError, validateActions } = require('../errors.cjs');

test('DM deletion routes reject untrusted, malformed and missing confirmations before reaching the manager', async () => {
  const key = 'TEST_KEY_DO_NOT_USE_IN_PRODUCTION_123456789', id = randomUUID(), calls = [];
  const { server } = createServer({ apiKey: key, maxSessions: 30 }, {
    controlDm: async (...args) => { calls.push(args); return { id }; }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/v1/sessions/${id}/dm/`;
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-AFK-Device-Key': 'a'.repeat(64) };
  try {
    for (const action of ['preview', 'start', 'cancel']) {
      const denied = await fetch(base + action, { method: 'POST', body: '{}' });
      assert.equal(denied.status, 401); await denied.text();
    }
    for (const [action, body] of [['preview', { channelId: '../wrong' }], ['start', {}], ['start', { confirmationId: 'yes' }], ['cancel', null]]) {
      const result = await fetch(base + action, { method: 'POST', headers, body: JSON.stringify(body) });
      assert.equal(result.status, 400); await result.text();
    }
    assert.equal(calls.length, 0);
    const confirmationId = randomUUID();
    for (const [action, body] of [['preview', { channelId: '200000000000000001' }], ['start', { confirmationId }], ['cancel', {}]]) {
      const result = await fetch(base + action, { method: 'POST', headers, body: JSON.stringify(body) });
      assert.equal(result.status, 202); await result.text();
      assert.deepEqual(calls.at(-1).slice(0, 3), [id, action, body]); assert.match(calls.at(-1)[3], /^[a-f0-9]{64}$/);
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('HTTP API authenticates every route, rejects browser origins and malformed input, and never returns submitted tokens', async () => {
  const key = 'TEST_KEY_DO_NOT_USE_IN_PRODUCTION_123456789';
  const fakeToken = 'FAKE_USER_TOKEN_FOR_TESTS.segment.NOT_A_REAL_TOKEN';
  const records = new Map(); let creates = 0, voiceChanges = 0, actionChanges = 0;
  const manager = {
    list: () => [...records.values()],
    create: ({ guildId, channelId }) => {
      creates++;
      const record = { id: randomUUID(), guildId, channelId, status: 'starting' }; records.set(record.id, record); return record;
    },
    setVoice: (id, voice) => {
      voiceChanges++;
      const record = records.get(id); if (!record) throw new PublicError('NOT_FOUND', 404);
      return { ...record, ...voice, voicePending: true };
    },
    setActions: (id, actions) => {
      actionChanges++;
      return { ...records.get(id), actions: { config: actions, afkNextAt: null, njmNextAt: null, lastAction: null, errorCode: null } };
    },
    stop: async (id, remove) => {
      const record = records.get(id); if (!record) throw new PublicError('NOT_FOUND', 404);
      record.status = 'stopped'; if (remove) records.delete(id); return record;
    }
  };
  const { server } = createServer({ apiKey: key, maxSessions: 30 }, manager);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-AFK-Device-Key': 'a'.repeat(64) };
  const input = { token: fakeToken, guildId: '100000000000000001', channelId: '200000000000000001' };
  try {
    for (const path of ['/v1/health', '/v1/sessions']) {
      const response = await fetch(base + path); assert.equal(response.status, 401); await response.text();
    }
    let response = await fetch(base + '/v1/sessions', { headers: { ...headers, Origin: 'https://untrusted.invalid' } });
    assert.equal(response.status, 403); await response.text();
    response = await fetch(base + '/v1/sessions', { method: 'POST', headers, body: JSON.stringify({ ...input, channelId: '../wrong' }) });
    assert.equal(response.status, 400); assert.ok(!(await response.text()).includes(fakeToken)); assert.equal(creates, 0);
    response = await fetch(base + '/v1/sessions', { method: 'POST', headers, body: JSON.stringify({ ...input, padding: 'x'.repeat(9000) }) });
    assert.equal(response.status, 413); await response.text(); assert.equal(creates, 0);
    response = await fetch(base + '/v1/sessions', { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(response.status, 202); const created = await response.json(); assert.ok(!JSON.stringify(created).includes(fakeToken));
    response = await fetch(base + '/v1/sessions', { headers });
    const listed = await response.json(); assert.equal(listed.value.maxSessions, 30); assert.equal(listed.value.sessions.length, 1); assert.ok(!JSON.stringify(listed).includes(fakeToken));
    const voicePath = base + `/v1/sessions/${created.value.id}/voice`;
    response = await fetch(voicePath, { method: 'POST', headers, body: JSON.stringify({ selfMute: false, selfDeaf: true }) });
    assert.equal(response.status, 400); await response.text(); assert.equal(voiceChanges, 0);
    response = await fetch(voicePath, { method: 'POST', headers, body: JSON.stringify({ selfMute: false, selfDeaf: false }) });
    assert.equal(response.status, 202); assert.equal((await response.json()).value.voicePending, true); assert.equal(voiceChanges, 1);
    const actionPath = base + `/v1/sessions/${created.value.id}/actions`;
    const actions = { ...validateActions(), afk: true, njm: true, typing: true };
    response = await fetch(actionPath, { method: 'POST', body: JSON.stringify(actions) });
    assert.equal(response.status, 401); await response.text(); assert.equal(actionChanges, 0);
    for (const invalid of [{ ...actions, minMinutes: 0 }, { ...actions, channelIds: [input.channelId] }, { ...actions, messages: ['x'.repeat(201)] }]) {
      response = await fetch(actionPath, { method: 'POST', headers, body: JSON.stringify(invalid) });
      assert.equal(response.status, 400); await response.text(); assert.equal(actionChanges, 0);
    }
    response = await fetch(actionPath, { method: 'POST', headers, body: JSON.stringify(actions) });
    assert.equal(response.status, 202); assert.equal((await response.json()).value.actions.config.afk, true); assert.equal(actionChanges, 1);
    response = await fetch(base + `/v1/sessions/${created.value.id}/stop`, { method: 'POST', headers });
    assert.equal((await response.json()).value.status, 'stopped');
    response = await fetch(base + `/v1/sessions/${created.value.id}`, { method: 'DELETE', headers }); await response.text();
    assert.equal(records.size, 0);
    response = await fetch(base + '/v1/sessions/' + randomUUID(), { method: 'DELETE', headers });
    assert.equal(response.status, 404); await response.text();
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('access passwords are required on every route and the server selects the tier for starts', async () => {
  const key = 'TEST_KEY_DO_NOT_USE_IN_PRODUCTION_123456789';
  const accessCodes = [10, 20, 30].map(limit => {
    const salt = String(limit).repeat(16);
    return { limit, salt, hash: scryptSync(`TEST_ONLY_${limit}`, salt, 32).toString('hex') };
  });
  const received = [];
  const { server } = createServer({ apiKey: key, maxSessions: 30, accessCodes }, {
    list: () => [], create: (input, limit) => { received.push(limit); return { id: randomUUID(), status: 'starting' }; }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-AFK-Device-Key': 'a'.repeat(64) };
  const input = { token: 'FAKE_USER_TOKEN_FOR_TESTS.segment.NOT_REAL', guildId: '100000000000000001', channelId: '200000000000000001', maxSessions: 30 };
  try {
    for (const route of ['/v1/health', '/v1/sessions']) {
      const response = await fetch(base + route, { headers });
      assert.equal(response.status, 403); assert.equal((await response.json()).code, 'ACCESS_REQUIRED');
    }
    for (const limit of [10, 20, 30]) {
      const tierHeaders = { ...headers, 'X-AFK-Password': `TEST_ONLY_${limit}` };
      let response = await fetch(base + '/v1/health', { headers: tierHeaders });
      assert.equal((await response.json()).value.maxSessions, limit);
      response = await fetch(base + '/v1/sessions', { method: 'POST', headers: tierHeaders, body: JSON.stringify(input) });
      assert.equal(response.status, 202); await response.text();
      assert.equal(received.at(-1), limit);
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
