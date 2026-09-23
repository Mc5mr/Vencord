'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { AccountSession } = require('../session.cjs');
const { DmCleanup } = require('../dm-cleanup.cjs');
const { validateStart, validateActions } = require('../errors.cjs');
const userId = '300000000000000001', channelId = '200000000000000001', other = '400000000000000001';
const token = 'FAKE_DM_ACCOUNT_FOR_TESTS.segment.NOT_A_REAL_TOKEN';
const input = { token, kind: 'dm', guildId: '', channelId };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('DM input is explicit and cannot enable server automation; legacy guild input still validates', () => {
  assert.equal(validateStart(input).guildId, '');
  assert.equal(validateStart({ ...input, guildId: undefined }).kind, 'dm');
  assert.equal(validateStart({ token, channelId, guildId: other }).kind, 'guild');
  for (const invalid of [{ ...input, guildId: other }, { ...input, kind: 'private' }, { ...input, channelId: '../bad' }])
    assert.throws(() => validateStart(invalid), e => e.code === 'BAD_INPUT');
  for (const invalid of [{ ...input, automation: { mode: 'follow', targetId: other } }, { ...input, actions: { ...validateActions(), afk: true } },
    { ...input, actions: { ...validateActions(), njm: true, typing: true } }])
    assert.throws(() => validateStart(invalid), e => e.code === 'GUILD_ONLY');
});

test('DM and group calls route null guild events to the channel transport in either order, without ringing', async () => {
  for (const type of ['DM', 'GROUP_DM']) for (const reverse of [false, true]) {
    const sent = [], transports = [];
    class Client extends EventEmitter {
      constructor() {
        super(); this.user = { id: userId, username: 'Test account' };
        this.ws = { broadcast: packet => sent.push(packet) };
        this.channels = { fetch: async () => ({ id: channelId, type, sync: () => sent.push({ op: 13 }) }) };
      }
      async login(value) { this.token = value; }
      destroy() { this.token = null; }
    }
    class Transport {
      constructor(node, user, server, onState) { this.server = server; this.onState = onState; this.updates = []; transports.push(this); }
      async connect() {}
      updateVoice(voice) { this.updates.push(voice); }
      async destroy() { this.destroyed = true; }
    }
    const session = new AccountSession(input, {}, () => {}, () => {}, { Client, Transport });
    try {
      await session.start();
      assert.equal(session.status, 'connecting'); assert.equal(transports[0].server, channelId);
      assert.deepEqual(sent.at(-1), { op: 4, d: { guild_id: null, channel_id: channelId, self_mute: true, self_deaf: true } });
      const state = { t: 'VOICE_STATE_UPDATE', d: { user_id: userId, channel_id: channelId, session_id: 'FAKE_SESSION' } };
      const server = { t: 'VOICE_SERVER_UPDATE', d: { guild_id: null, channel_id: channelId, endpoint: 'voice.invalid', token: 'FAKE_VOICE_TOKEN' } };
      session.onPacket({ ...server, d: { ...server.d, channel_id: other } });
      session.onPacket({ ...state, d: { ...state.d, channel_id: other } });
      assert.equal(transports[0].updates.length, 0);
      const statePacket = type === 'GROUP_DM' ? { t: 'CALL_CREATE', d: { channel_id: channelId, voice_states: [state.d] } } : state;
      for (const packet of reverse ? [statePacket, server] : [server, statePacket]) session.onPacket(packet);
      assert.equal(transports[0].updates.length, 1); assert.equal(session.status, 'connecting');
      transports[0].onState(true); assert.equal(session.status, 'connected');
      session.setVoice({ selfMute: false, selfDeaf: false });
      assert.equal(sent.at(-1).d.guild_id, null);
      session.onPacket({ ...state, d: { ...state.d, self_mute: false, self_deaf: false } });
      assert.equal(session.pendingVoice, null);
      assert.throws(() => session.setAutomation({ mode: 'follow', targetId: other }), e => e.code === 'GUILD_ONLY');
      assert.throws(() => session.setActions({ ...validateActions(), afk: true }), e => e.code === 'GUILD_ONLY');
      session.onPacket({ t: 'CALL_DELETE', d: { channel_id: other } }); assert.equal(session.status, 'connected');
      if (reverse) {
        session.onPacket({ t: 'CALL_DELETE', d: { channel_id: channelId } }); await session.stopping;
        assert.equal(session.errorCode, 'DISCONNECTED');
        assert.notEqual(sent.at(-1).d.channel_id, null);
      } else if (type === 'GROUP_DM') {
        session.onPacket({ ...state, d: { ...state.d, channel_id: other } }); await session.stopping;
        assert.equal(session.errorCode, 'MOVED'); assert.notEqual(sent.at(-1).d.channel_id, null);
      } else {
        await session.stop(); assert.equal(sent.at(-1).d.channel_id, null); assert.equal(sent.at(-1).d.guild_id, null);
      }
      assert.ok(transports[0].destroyed); assert.ok(sent.every(packet => [4, 13].includes(packet.op)));
    } finally { await session.stop(); }
  }
});

function cleanupFixture(request) {
  const requests = [];
  const session = { active: true, userId, dependencies: { dmDelay: async () => {}, dmFetch: async (url, options) => {
    requests.push({ url, options }); return request(url, options);
  } }, client: { token, user: { id: userId }, channels: { fetch: async id => ({ id, type: 'DM', recipient: { username: 'Test friend' } }) } } };
  return { session, requests, cleanup: new DmCleanup(session) };
}
const message = (id, author = userId, type = 0) => ({ id, channel_id: channelId, author: { id: author }, type, content: 'PRIVATE_FIXTURE_TEXT' });
const response = (body, status = 200, headers) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers });

test('deletion requires review and deletes only own messages across pages; no contents or tokens in progress', async () => {
  let page = 0;
  const f = cleanupFixture(async (url, { method }) => method === 'DELETE' ? response(null, 204) : response([
    [message('900000000000000001'), message('800000000000000001', other), message('700000000000000001', userId, 3)],
    [message('600000000000000001', userId, 19)], []
  ][page++]));
  assert.throws(() => f.cleanup.start('not-reviewed'), e => e.code === 'DM_CONFIRM');
  const review = await f.cleanup.preview(channelId);
  assert.equal(f.requests.length, 0); assert.equal(review.name, 'Test friend');
  assert.throws(() => f.cleanup.start(other), e => e.code === 'DM_CONFIRM');
  f.cleanup.start(review.confirmationId);
  assert.throws(() => f.cleanup.start(review.confirmationId), e => e.code === 'DM_BUSY');
  await f.cleanup.running;
  assert.equal(f.cleanup.info().status, 'completed'); assert.equal(f.cleanup.info().deleted, 2);
  assert.equal(f.cleanup.info().scanned, 4); assert.equal(f.cleanup.info().skipped, 1);
  const deletes = f.requests.filter(r => r.options.method === 'DELETE');
  assert.deepEqual(deletes.map(r => r.url.split('/').at(-1)), ['900000000000000001', '600000000000000001']);
  assert.ok(f.requests[0].url.includes('before='));
  assert.ok(f.requests.find(r => r.url.endsWith('before=700000000000000001')));
  assert.ok(f.requests.every(r => r.options.headers.Authorization === token && r.options.redirect === 'error'));
  assert.ok(!JSON.stringify(f.cleanup.info()).includes(token)); assert.ok(!JSON.stringify(f.cleanup.info()).includes('PRIVATE_FIXTURE_TEXT'));
  assert.throws(() => f.cleanup.start(review.confirmationId), e => e.code === 'DM_CONFIRM');
});

test('review rejects guilds, expires, and cannot be reused after cancellation', async t => {
  const f = cleanupFixture(() => { throw Error('No request expected'); });
  f.session.client.channels.fetch = async id => ({ id, type: 'GUILD_TEXT' });
  await assert.rejects(f.cleanup.preview(channelId), e => e.code === 'DM_ONLY');
  f.session.client.channels.fetch = async id => ({ id, type: 'GROUP_DM', name: 'Test group' });
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  let review = await f.cleanup.preview(channelId); now += 300_001;
  assert.throws(() => f.cleanup.start(review.confirmationId), e => e.code === 'DM_CONFIRM');
  review = await f.cleanup.preview(channelId); f.cleanup.cancel();
  assert.throws(() => f.cleanup.start(review.confirmationId), e => e.code === 'DM_CONFIRM');
  assert.equal(f.requests.length, 0);
});

test('429 waits respect retry_after and cancellation aborts the wait without another deletion', async () => {
  const f = cleanupFixture(async (_url, { method }) => method === 'GET'
    ? response([message('900000000000000001')]) : response({ retry_after: 30 }, 429));
  const waits = [];
  f.session.dependencies.dmDelay = (ms, unused, options) => { waits.push(ms); return ms > 2000 ? delay(ms, unused, options) : Promise.resolve(); };
  const review = await f.cleanup.preview(channelId); f.cleanup.start(review.confirmationId);
  for (let n = 0; n < 20 && f.cleanup.info().status !== 'waiting'; n++) await tick();
  assert.equal(f.cleanup.info().status, 'waiting'); assert.ok(waits.at(-1) >= 30_000);
  const task = f.cleanup.running; f.cleanup.cancel(); await task;
  assert.equal(f.cleanup.info().status, 'cancelled'); assert.equal(f.cleanup.info().deleted, 0);
  assert.equal(f.requests.filter(r => r.options.method === 'DELETE').length, 1);
  const retry = await f.cleanup.preview(channelId);
  assert.throws(() => f.cleanup.start(retry.confirmationId), e => e.code === 'DM_RATE_LIMIT');
});

test('failed permissions and unexpected channel data stop deletion; unknown messages are skipped', async () => {
  for (const status of [403, 401, 500]) {
    const f = cleanupFixture(async () => response({ message: 'MUST_NOT_BE_EXPOSED' }, status));
    const review = await f.cleanup.preview(channelId); f.cleanup.start(review.confirmationId); await f.cleanup.running;
    assert.equal(f.cleanup.info().errorCode, 'DM_DELETE_FAILED'); assert.equal(f.requests.length, 1);
  }
  const wrong = cleanupFixture(async () => response([{ ...message('900000000000000001'), channel_id: other }]));
  const review = await wrong.cleanup.preview(channelId); wrong.cleanup.start(review.confirmationId); await wrong.cleanup.running;
  assert.equal(wrong.cleanup.info().status, 'error'); assert.equal(wrong.requests.length, 1);
  let page = 0;
  const gone = cleanupFixture(async (_url, { method }) => method === 'DELETE' ? response({ code: 10008 }, 404)
    : response(page++ === 0 ? [message('900000000000000001')] : []));
  const ready = await gone.cleanup.preview(channelId); gone.cleanup.start(ready.confirmationId); await gone.cleanup.running;
  assert.equal(gone.cleanup.info().status, 'completed'); assert.equal(gone.cleanup.info().skipped, 1);
});

test('shutdown aborts an in-flight deletion and does not issue the next one', async () => {
  let pending;
  const f = cleanupFixture(async (_url, { method, signal }) => method === 'GET'
    ? response([message('900000000000000001'), message('800000000000000001')])
    : new Promise((resolve, reject) => { pending = true; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
  const ready = await f.cleanup.preview(channelId); f.cleanup.start(ready.confirmationId);
  for (let n = 0; n < 20 && !pending; n++) await tick();
  assert.ok(pending); await f.cleanup.close();
  assert.equal(f.cleanup.info().status, 'cancelled'); assert.equal(f.requests.filter(r => r.options.method === 'DELETE').length, 1);
});
