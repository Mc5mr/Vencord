'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AccountSession } = require('../session.cjs');
const { validateStart } = require('../errors.cjs');
const guildId = '100000000000000001', home = '200000000000000001', other = '200000000000000002';
const userId = '300000000000000001', targetId = '300000000000000002';
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(options = {}) {
  const sent = [], streams = [], moves = [], clients = [], messages = [], typing = [];
  const guild = { id: guildId, shard: { send: data => sent.push(data) }, voiceStates: { cache: new Map() } };
  const member = { id: targetId, voice: { channelId: other, async setChannel(channelId) { moves.push(channelId); this.channelId = channelId; } } };
  guild.members = { fetch: async () => member };
  const channels = new Map([home, other].map(id => [id, { id, type: 'GUILD_VOICE', guild,
    permissionsFor: () => ({ has: permission => (Array.isArray(permission) ? permission : [permission]).every(p => !options.denied?.includes(p)) }),
    send: async value => messages.push({ channelId: id, ...value }), sendTyping: async () => typing.push(id) }]));
  guild.channels = { cache: channels };
  class Client extends EventEmitter {
    constructor(config) { super(); this.options = config; this.user = { id: userId, username: 'fake_owner' }; this.channels = { fetch: async id => channels.get(id) }; this.ws = { broadcast: data => streams.push(data) }; clients.push(this); }
    async login() {} destroy() { this.destroyed = true; }
  }
  class Transport { constructor(n, u, g, onState) { this.onState = onState; this.updates = []; } async connect() {} beginMove() { this.moves = (this.moves || 0) + 1; } updateVoice(value) { this.updates.push(value); } async destroy() {} }
  const session = new AccountSession({ token: 'FAKE_USER_FOR_CONTROLS.segment.NOT_A_TOKEN', guildId, channelId: home, platform: options.platform || 'desktop' }, {}, () => {}, () => {}, { Client, Transport, random: () => 0, permitMessage: () => true });
  await session.start();
  const own = (channelId, fields = {}) => session.onPacket({ t: 'VOICE_STATE_UPDATE', d: { user_id: userId, guild_id: guildId, channel_id: channelId, session_id: 'FAKE_VOICE', self_mute: true, self_deaf: true, ...fields } });
  own(home);
  session.onPacket({ t: 'VOICE_SERVER_UPDATE', d: { guild_id: guildId, endpoint: 'voice.invalid', token: 'FAKE_VOICE_ONLY' } });
  session.voice.onState(true);
  const target = channelId => { member.voice.channelId = channelId; session.onPacket({ t: 'VOICE_STATE_UPDATE', d: { user_id: targetId, guild_id: guildId, channel_id: channelId } }); };
  return { session, sent, streams, moves, clients, guild, own, target, channels, messages, typing };
}

test('Follow moves only this account in its configured server and waits for voice confirmation', async t => {
  const f = await fixture();
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    f.session.setAutomation({ mode: 'follow', targetId });
    f.target(other); t.mock.timers.tick(750); await tick();
    assert.equal(f.session.channelId, other); assert.equal(f.session.status, 'connecting');
    assert.equal(f.sent.at(-1).d.channel_id, other); assert.equal(f.moves.length, 0);
    f.own(home); assert.equal(f.session.status, 'connecting');
    f.own(other); f.session.voice.onState(true); assert.equal(f.session.status, 'connecting');
    assert.equal(f.session.voice.updates.length, 1);
    f.session.onPacket({ t: 'VOICE_SERVER_UPDATE', d: { guild_id: guildId, endpoint: 'voice.invalid', token: 'NEW_FAKE_VOICE' } });
    assert.equal(f.session.voice.updates.at(-1).token, 'NEW_FAKE_VOICE');
    f.session.voice.onState(true); assert.equal(f.session.status, 'connected');
    f.session.onPacket({ t: 'VOICE_STATE_UPDATE', d: { user_id: targetId, guild_id: '999999999999999999', channel_id: home } });
    t.mock.timers.tick(6000); await tick(); assert.equal(f.session.channelId, other);
  } finally { await f.session.stop(); }
});

test('Follow handles server-first voice events and catches up when the target moves again while connecting', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const f = await fixture();
  const server = token => f.session.onPacket({ t: 'VOICE_SERVER_UPDATE', d: { guild_id: guildId, endpoint: 'voice.invalid', token } });
  try {
    f.session.setAutomation({ mode: 'follow', targetId }); f.target(other);
    t.mock.timers.tick(750); await tick();
    server('NEW_FIRST'); f.session.voice.onState(true); assert.equal(f.session.status, 'connecting');
    assert.equal(f.session.voice.updates.length, 1);
    f.target(home); f.own(other); f.session.voice.onState(true);
    assert.equal(f.session.voice.updates.at(-1).token, 'NEW_FIRST');
    t.mock.timers.tick(5000); await tick(); assert.equal(f.session.channelId, home);
    f.own(home); server('NEW_SECOND'); f.session.voice.onState(true);
    assert.equal(f.session.status, 'connected'); assert.equal(f.session.voice.updates.at(-1).token, 'NEW_SECOND');
    assert.equal(f.session.automation.mode, 'follow');
  } finally { await f.session.stop(); }
});

test('voice endpoint reallocation waits for new credentials without stopping Follow', async () => {
  const f = await fixture();
  try {
    f.session.setAutomation({ mode: 'follow', targetId });
    f.session.onPacket({ t: 'VOICE_SERVER_UPDATE', d: { guild_id: guildId, endpoint: null, token: 'RELOCATED' } });
    f.session.voice.onState(false); assert.equal(f.session.status, 'connecting');
    f.session.onPacket({ t: 'VOICE_SERVER_UPDATE', d: { guild_id: guildId, endpoint: 'new-voice.invalid', token: 'RELOCATED' } });
    assert.equal(f.session.voice.updates.at(-1).token, 'RELOCATED');
    f.session.voice.onState(true); assert.equal(f.session.status, 'connected'); assert.equal(f.session.automation.mode, 'follow');
  } finally { await f.session.stop(); }
});

test('AFK Action waits 25 minutes, rotates accessible rooms, excludes Follow and cancels on Stop', async t => {
  const { validateActions } = require('../errors.cjs');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const f = await fixture();
  try {
    const original = f.channels.get(home);
    f.channels.set(home + '1', { ...original, id: home + '1', guild: { id: '999999999999999999' } });
    f.channels.set(home + '2', { ...original, id: home + '2', type: 'GUILD_TEXT' });
    f.channels.set(home + '3', { ...original, id: home + '3', permissionsFor: () => ({ has: () => false }) });
    f.channels.set(home + '4', { ...original, id: home + '4', userLimit: 1, members: { size: 1 }, permissionsFor: () => ({ has: value => value !== 'MOVE_MEMBERS' }) });
    f.session.setAutomation({ mode: 'follow', targetId });
    assert.throws(() => f.session.setActions({ ...validateActions(), afk: true }), e => e.code === 'ACTION_CONFLICT');
    f.session.setAutomation({ mode: 'off', targetId: '' });
    f.session.setActions({ ...validateActions(), afk: true });
    assert.throws(() => f.session.setAutomation({ mode: 'follow', targetId }), e => e.code === 'ACTION_CONFLICT');
    const count = f.sent.length;
    t.mock.timers.tick(25 * 60_000 - 1); await tick(); assert.equal(f.sent.length, count);
    t.mock.timers.tick(1); await tick(); assert.equal(f.session.channelId, other);
    assert.equal(f.session.actions.lastAction, 'afk-move');
    f.own(other); f.session.onPacket({ t: 'VOICE_SERVER_UPDATE', d: { guild_id: guildId, endpoint: 'voice.invalid', token: 'AFK_MOVE_VOICE' } }); f.session.voice.onState(true);
    await f.session.stop(); const stoppedCount = f.sent.length;
    t.mock.timers.tick(60 * 60_000); await tick(); assert.equal(f.sent.length, stoppedCount);
  } finally { await f.session.stop(); }
});

test('accounts share a per-room message allowance and AFK pauses when fewer than two allowed rooms remain', async t => {
  const { SessionManager } = require('../session.cjs');
  const { validateActions } = require('../errors.cjs');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const manager = new SessionManager({ maxSessions: 30 });
  const f = await fixture();
  try {
    assert.equal(manager.dependencies.permitMessage(guildId, home), true);
    assert.equal(manager.dependencies.permitMessage(guildId, home), false);
    assert.equal(manager.dependencies.permitMessage(guildId, other), true);
    t.mock.timers.tick(60_000); assert.equal(manager.dependencies.permitMessage(guildId, home), true);
    f.channels.delete(other);
    f.session.setActions({ ...validateActions(), afk: true });
    t.mock.timers.tick(25 * 60_000); await tick();
    assert.equal(f.session.actions.errorCode, 'ACTION_NO_ROOMS'); assert.equal(f.session.actions.config.afk, false);
    assert.equal(f.session.status, 'connected'); assert.equal(f.session.channelId, home);
  } finally { await f.session.stop(); }
});

test('njm sends only the configured text in the current room without mentions, and pauses on permission failure', async t => {
  const { validateActions } = require('../errors.cjs');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const f = await fixture();
  try {
    f.session.setActions({ ...validateActions(), njm: true, messages: ['My approved test text'], minMinutes: 5, maxMinutes: 5 });
    t.mock.timers.tick(5 * 60_000 - 1); await tick(); assert.equal(f.messages.length, 0);
    t.mock.timers.tick(1); await tick();
    assert.deepEqual(f.messages, [{ channelId: home, content: 'My approved test text', allowedMentions: { parse: [], repliedUser: false } }]);
    f.session.dependencies.permitMessage = () => false;
    t.mock.timers.tick(5 * 60_000); await tick(); assert.equal(f.messages.length, 1);
    f.session.channel.permissionsFor = () => ({ has: () => false });
    t.mock.timers.tick(5 * 60_000); await tick();
    assert.equal(f.session.actions.config.njm, false); assert.equal(f.session.actions.errorCode, 'ACTION_PERMISSION');
    assert.equal(f.session.status, 'connected');
    t.mock.timers.tick(30 * 60_000); await tick(); assert.equal(f.messages.length, 1);
  } finally { await f.session.stop(); }
});

test('njm closes its camera marker after the configured duration and preserves later manual changes', async t => {
  const { validateActions } = require('../errors.cjs');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const f = await fixture();
  try {
    f.session.setActions({ ...validateActions(), njm: true, camera: true, minMinutes: 5, maxMinutes: 5, mediaMinutes: 2 });
    t.mock.timers.tick(5 * 60_000); await tick();
    assert.equal(f.sent.at(-1).d.self_video, true); f.own(home, { self_video: true });
    t.mock.timers.tick(2 * 60_000 - 1); await tick(); assert.equal(f.sent.at(-1).d.self_video, true);
    f.session.status = 'connecting';
    t.mock.timers.tick(1); await tick(); assert.equal(f.sent.at(-1).d.self_video, true);
    f.session.status = 'connected';
    t.mock.timers.tick(1000); await tick(); assert.equal(f.sent.at(-1).d.self_video, false); f.own(home, { self_video: false });
    t.mock.timers.tick(3 * 60_000); await tick(); f.own(home, { self_video: true });
    t.mock.timers.tick(4000); f.session.setMedia({ camera: false, share: false }); f.own(home, { self_video: false });
    t.mock.timers.tick(4000); f.session.setMedia({ camera: true, share: false }); f.own(home, { self_video: true });
    const count = f.sent.length;
    t.mock.timers.tick(2 * 60_000); await tick(); assert.equal(f.sent.length, count); assert.equal(f.session.selfVideo, true);
  } finally { await f.session.stop(); }
});

test('Pull moves the target to this account, cancels on target disconnect, and requires permissions', async t => {
  const f = await fixture();
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    f.session.setAutomation({ mode: 'pull', targetId });
    f.target(other); f.target(null); t.mock.timers.tick(1000); await tick(); assert.equal(f.moves.length, 0);
    f.target(other); t.mock.timers.tick(1000); await tick();
    assert.deepEqual(f.moves, [home]); assert.equal(f.session.channelId, home);
    assert.throws(() => f.session.setAutomation({ mode: 'pull', targetId: userId }), e => e.code === 'BAD_INPUT');
  } finally { await f.session.stop(); }
  const denied = await fixture({ denied: ['MOVE_MEMBERS'] });
  try { assert.throws(() => denied.session.setAutomation({ mode: 'pull', targetId }), e => e.code === 'AUTOMATION_PERMISSION'); assert.equal(denied.moves.length, 0); }
  finally { await denied.session.stop(); }
});

test('Follow permission failure pauses the automation without repeated requests', async t => {
  const f = await fixture();
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    f.session.client.channels.fetch = async () => null;
    f.session.setAutomation({ mode: 'follow', targetId });
    f.target(other); t.mock.timers.tick(1000); await tick();
    assert.equal(f.session.automation.mode, 'off');
    assert.equal(f.session.automation.errorCode, 'AUTOMATION_PERMISSION');
    assert.equal(f.session.status, 'connected');
    const count = f.sent.length; t.mock.timers.tick(60_000); await tick(); assert.equal(f.sent.length, count);
  } finally { await f.session.stop(); }
});

test('media markers send signals only, require acknowledgement, and are removed on stop', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = await fixture();
  try {
    f.session.setMedia({ camera: true, share: true });
    assert.equal(f.session.publicData().mediaPending, true);
    assert.equal(f.session.publicData().selfVideo, false);
    assert.equal(f.sent.at(-1).d.self_video, true);
    assert.deepEqual(f.streams.map(s => s.op), [18, 22]);
    assert.throws(() => f.session.setMedia({ camera: true, share: true }), e => e.code === 'WAIT');
    f.session.onPacket({ t: 'STREAM_CREATE', d: { stream_key: f.session.markerStreamKey } });
    f.own(home, { self_video: true, self_stream: true });
    assert.equal(f.session.publicData().mediaPending, false);
    assert.equal(f.session.publicData().selfVideo, true);
    await f.session.stop(); assert.equal(f.streams.at(-1).op, 19); assert.equal(f.session.mediaPending, null);
  } finally { await f.session.stop(); }
});

test('unsupported console platforms are rejected and old mobile preferences no longer override the connection', async () => {
  const input = { token: 'FAKE_USER_FOR_CONTROLS.segment.NOT_A_TOKEN', guildId, channelId: home };
  assert.throws(() => validateStart({ ...input, platform: 'xbox' }), e => e.code === 'BAD_INPUT');
  assert.throws(() => validateStart({ ...input, platform: 'playstation' }), e => e.code === 'BAD_INPUT');
  const f = await fixture({ platform: 'mobile' });
  try { assert.equal(f.clients[0].options.ws, undefined); assert.equal(f.session.publicData().platform, 'desktop'); }
  finally { await f.session.stop(); }
});
