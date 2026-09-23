'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { PublicError, validateVoice, validateMedia, validateActions } = require('./errors.cjs');
const { LavalinkConnection } = require('./lavalink.cjs');
const { VoiceAutomation } = require('./automation.cjs');
const { AccountActions } = require('./actions.cjs');
const { DmCleanup } = require('./dm-cleanup.cjs');
const { guardClient, discordFailure } = require('./guard.cjs');

const activeStates = new Set(['starting', 'connecting', 'connected', 'stopping']);

function withTimeout(promise, ms, code) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new PublicError(code)), ms); timer.unref(); })])
    .finally(() => clearTimeout(timer));
}

class AccountSession {
  constructor(input, node, claim, release, dependencies = {}) {
    this.id = randomUUID();
    this.token = input.token;
    this.tokenHash = createHash('sha256').update(input.token).digest('hex');
    this.guildId = input.guildId;
    this.kind = input.kind || 'guild';
    this.channelId = input.channelId;
    this.accountId = input.accountId || null;
    this.selfMute = input.selfMute ?? true;
    this.selfDeaf = input.selfDeaf ?? true;
    this.pendingVoice = null;
    this.voiceControlError = null;
    this.nextVoiceChange = 0;
    this.platform = 'desktop';
    this.initialAutomation = input.automation || { mode: 'off', targetId: '' };
    this.automation = new VoiceAutomation(this);
    this.actions = new AccountActions(this);
    this.dmCleanup = new DmCleanup(this);
    this.initialActions = { ...validateActions(input.actions), afk: false, njm: false };
    this.mediaRevision = 0;
    this.selfVideo = false; this.selfStream = false; this.mediaPending = null;
    this.mediaError = null; this.nextMediaChange = 0; this.markerStreamKey = null;
    this.node = node;
    this.claim = claim;
    this.release = release;
    this.dependencies = dependencies;
    this.status = 'starting';
    this.createdAt = Date.now();
    this.errorCode = null;
  }

  get active() { return activeStates.has(this.status); }

  publicData() {
    return { id: this.id, userId: this.userId || '', username: this.username || '',
      kind: this.kind, guildId: this.guildId, channelId: this.channelId, status: this.status,
      createdAt: this.createdAt, connectedAt: this.connectedAt || null, errorCode: this.errorCode,
      accountId: this.accountId, selfMute: this.selfMute, selfDeaf: this.selfDeaf,
      voicePending: Boolean(this.pendingVoice), voiceControlError: this.voiceControlError,
      platform: this.platform, automation: this.automation.info(), selfVideo: this.selfVideo,
      selfStream: this.selfStream, mediaPending: Boolean(this.mediaPending), mediaError: this.mediaError,
      actions: this.actions.info(), dmCleanup: this.dmCleanup.info(), retryAt: this.retryAt || null };
  }

  async start() {
    try {
      const Client = this.dependencies.Client || require('discord.js-selfbot-v13').Client;
      const client = this.client = new Client({
        presence: { status: 'idle', activities: [], afk: true },
        allowedMentions: { parse: [] }, restRequestTimeout: 10_000, retryLimit: 0,
        captchaRetryLimit: 0, TOTPKey: null,
        rejectOnRateLimit: info => { this.suspend('RATE_LIMITED', info?.timeout); return true; }
      });
      guardClient(this, client);
      client.on('raw', packet => this.onPacket(packet));
      try { await withTimeout(client.login(this.token), 30_000, 'LOGIN_FAILED'); }
      catch (error) { throw new PublicError(discordFailure(error) || 'LOGIN_FAILED'); }
      this.token = '';
      if (!this.active || this.stopping) return;
      if (!client.user || client.user.bot) throw new PublicError('USER_ONLY');
      this.userId = client.user.id;
      this.username = String(client.user.username || '').slice(0, 80);
      this.claim(this);
      let channel;
      try { channel = await withTimeout(client.channels.fetch(this.channelId), 12_000, 'CHANNEL'); }
      catch { throw new PublicError('CHANNEL'); }
      if (!this.active || this.stopping) return;
      if (this.kind === 'dm') {
        if (!channel || !['DM', 'GROUP_DM'].includes(channel.type) || channel.id !== this.channelId) throw new PublicError('DM_ONLY');
        if (this.initialAutomation.mode !== 'off' || this.initialActions.afk || this.initialActions.njm) throw new PublicError('GUILD_ONLY');
      } else if (!channel || channel.type !== 'GUILD_VOICE' || channel.guild?.id !== this.guildId
        || !channel.permissionsFor(client.user)?.has('CONNECT')) throw new PublicError('CHANNEL');
      this.guild = channel.guild;
      this.channel = channel;
      this.automation.configure(this.initialAutomation);
      this.actions.configure(this.initialActions);
      this.status = 'connecting';
      const Transport = this.dependencies.Transport || LavalinkConnection;
      // Private calls use their channel ID as the voice server/player identifier.
      this.voice = new Transport(this.node, this.userId, this.kind === 'dm' ? this.channelId : this.guildId,
        connected => this.onVoiceConnection(connected), error => { void this.fail(error); });
      await this.voice.connect();
      if (!this.active || this.stopping) return;
      this.joinRequested = true;
      this.voiceTimer = setTimeout(() => { void this.fail(new PublicError('VOICE_TIMEOUT')); }, 45_000);
      if (this.kind === 'dm') this.channel.sync?.();
      this.sendVoice({ channel_id: this.channelId, self_mute: this.selfMute, self_deaf: this.selfDeaf });
    } catch (error) {
      this.token = '';
      await this.fail(error instanceof PublicError ? error : new PublicError('SERVICE_ERROR'));
    }
  }

  sendVoice(state) {
    const payload = { op: 4, d: { guild_id: this.kind === 'dm' ? null : this.guildId, ...state } };
    if (this.kind === 'dm') this.client.ws.broadcast(payload);
    else this.guild.shard.send(payload);
  }

  suspend(code, timeout) {
    if (!this.active || this.status === 'stopping' || this.stopping) return;
    if (['AUTH_REVIEW', 'RATE_LIMITED', 'DISCORD_DENIED'].includes(code)) {
      const delay = Math.max(code === 'AUTH_REVIEW' ? 600_000 : 60_000, Number.isFinite(timeout) ? timeout : 0);
      this.retryAt = Date.now() + delay;
      this.dependencies.pauseAccount?.(this.tokenHash, this.accountId, this.retryAt, this.ownerId);
    }
    void this.stop(code, false);
  }

  onPacket(packet) {
    if (this.active && !this.stopping && ((['READY', 'USER_REQUIRED_ACTION_UPDATE'].includes(packet?.t)
      && packet.d?.required_action) || packet?.op === 9 && packet.d === false)) {
      this.suspend('AUTH_REVIEW'); return;
    }
    if (!this.joinRequested || this.stopping || !this.active || !packet?.d) return;
    const data = packet.d;
    if (this.kind === 'dm' && data.channel_id === this.channelId) {
      if (packet.t === 'CALL_DELETE') { void this.fail(new PublicError('DISCONNECTED'), false); return; }
      if (packet.t === 'CALL_CREATE') {
        for (const state of data.voice_states || []) {
          if (state.user_id === this.userId && state.channel_id === this.channelId)
            this.onPacket({ t: 'VOICE_STATE_UPDATE', d: state });
        }
        return;
      }
    }
    if (packet.t === 'VOICE_STATE_UPDATE') this.automation.observe(data);
    if (['STREAM_CREATE', 'STREAM_DELETE'].includes(packet.t) && data.stream_key === this.markerStreamKey) {
      this.selfStream = packet.t === 'STREAM_CREATE';
      this.confirmMedia();
      return;
    }
    const ownState = packet.t === 'VOICE_STATE_UPDATE' && data.user_id === this.userId;
    if (this.kind === 'dm' && ownState && this.voiceState && data.session_id === this.voiceState.sessionId
      && data.channel_id && data.channel_id !== this.channelId) {
      void this.fail(new PublicError('MOVED'), false);
      return;
    }
    if (ownState && (this.kind === 'dm' ? data.guild_id == null && (data.channel_id === this.channelId
      || data.channel_id === null && this.voiceState && (!data.session_id || data.session_id === this.voiceState.sessionId)) : data.guild_id === this.guildId)) {
      if (data.channel_id !== this.channelId) {
        if (this.status === 'connecting' && this.previousChannelId && data.channel_id === this.previousChannelId) return;
        void this.fail(new PublicError('MOVED'), false);
        return;
      }
      if (typeof data.session_id === 'string') this.voiceState = { sessionId: data.session_id };
      this.previousChannelId = null;
      if (typeof data.self_video === 'boolean') {
        this.selfVideo = data.self_video;
        this.confirmMedia();
      }
      if (typeof data.self_stream === 'boolean') { this.selfStream = data.self_stream; this.confirmMedia(); }
      if (typeof data.self_mute === 'boolean') this.selfMute = data.self_mute;
      if (typeof data.self_deaf === 'boolean') this.selfDeaf = data.self_deaf;
      if (this.pendingVoice && typeof data.self_mute === 'boolean' && typeof data.self_deaf === 'boolean'
        && this.selfMute === this.pendingVoice.selfMute && this.selfDeaf === this.pendingVoice.selfDeaf) {
        clearTimeout(this.voiceControlTimer);
        this.pendingVoice = null;
        this.voiceControlError = null;
      }
    } else if (packet.t === 'VOICE_SERVER_UPDATE' && (this.kind === 'dm'
      ? data.guild_id == null && data.channel_id === this.channelId : data.guild_id === this.guildId)) {
      if (this.status === 'connected' && (!data.endpoint || this.voiceServer?.token !== data.token)) {
        this.status = 'connecting';
        this.actions.suspend();
        this.voice.beginMove?.();
        clearTimeout(this.voiceTimer);
        this.voiceTimer = setTimeout(() => { void this.fail(new PublicError('VOICE_TIMEOUT')); }, 45_000);
      }
      if (typeof data.endpoint !== 'string' || !data.endpoint || typeof data.token !== 'string' || !data.token) { this.voiceServer = null; return; }
      this.voiceServer = { endpoint: data.endpoint, token: data.token };
    } else return;
    if (this.voiceState && this.voiceServer) this.voice.updateVoice({
      ...this.voiceServer, sessionId: this.voiceState.sessionId, channelId: this.channelId
    });
  }

  onVoiceConnection(connected) {
    if (this.stopping || !this.active) return;
    if (connected && this.voiceState && this.voiceServer) {
      clearTimeout(this.voiceTimer);
      this.status = 'connected';
      this.connectedAt ||= Date.now();
      this.automation.schedule();
      this.actions.resume();
    } else if (!connected && this.status === 'connected') {
      void this.fail(new PublicError('DISCONNECTED'));
    }
  }

  setVoice(value) {
    const voice = validateVoice(value);
    if (this.status !== 'connected' || this.stopping) throw new PublicError('NOT_CONNECTED', 409);
    if (this.pendingVoice || Date.now() < this.nextVoiceChange) throw new PublicError('WAIT', 429);
    if (this.selfMute === voice.selfMute && this.selfDeaf === voice.selfDeaf) {
      this.voiceControlError = null;
      return this.publicData();
    }
    this.nextVoiceChange = Date.now() + 3000;
    this.voiceControlError = null;
    this.pendingVoice = voice;
    this.voiceControlTimer = setTimeout(() => {
      this.pendingVoice = null;
      if (this.status === 'connected' && !this.stopping) this.voiceControlError = 'VOICE_CONTROL_FAILED';
    }, 10_000);
    this.voiceControlTimer.unref();
    try {
      this.sendVoice({ channel_id: this.channelId,
        self_mute: voice.selfMute, self_deaf: voice.selfDeaf, self_video: this.selfVideo
      });
    } catch {
      clearTimeout(this.voiceControlTimer);
      this.pendingVoice = null;
      this.voiceControlError = 'VOICE_CONTROL_FAILED';
      throw new PublicError('VOICE_CONTROL_FAILED', 502);
    }
    return this.publicData();
  }

  async followTo(channelId, current) { return this.moveTo(channelId, current); }

  async moveTo(channelId, current) {
    if (this.kind === 'dm') throw new PublicError('GUILD_ONLY');
    const channel = await withTimeout(this.client.channels.fetch(channelId), 12_000, 'CHANNEL');
    if (!current()) return;
    if (!channel || channel.type !== 'GUILD_VOICE' || channel.guild?.id !== this.guildId
      || !channel.permissionsFor(this.client.user)?.has('CONNECT')) throw new PublicError('AUTOMATION_PERMISSION', 403);
    this.clearMedia();
    this.actions.suspend();
    this.previousChannelId = this.channelId;
    this.channelId = channelId; this.channel = channel;
    this.status = 'connecting'; this.voiceState = null; this.voiceServer = null;
    this.voice.beginMove?.();
    clearTimeout(this.voiceControlTimer); this.pendingVoice = null;
    clearTimeout(this.voiceTimer);
    this.voiceTimer = setTimeout(() => { void this.fail(new PublicError('VOICE_TIMEOUT')); }, 45_000);
    try {
      this.guild.shard.send({ op: 4, d: { guild_id: this.guildId, channel_id: channelId,
        self_mute: this.selfMute, self_deaf: this.selfDeaf, self_video: false } });
    } catch (error) { await this.fail(new PublicError('AUTOMATION_FAILED')); throw error; }
  }

  async pullMember(targetId, sourceId, current) {
    const source = await withTimeout(this.client.channels.fetch(sourceId), 12_000, 'CHANNEL');
    const member = await withTimeout(this.guild.members.fetch(targetId), 12_000, 'CHANNEL');
    if (!current() || member.voice?.channelId !== sourceId) return;
    if (source?.guild?.id !== this.guildId || !source.permissionsFor(this.client.user)?.has('MOVE_MEMBERS')
      || !this.channel.permissionsFor(this.client.user)?.has('MOVE_MEMBERS')
      || !this.channel.permissionsFor(member)?.has('CONNECT')) throw new PublicError('AUTOMATION_PERMISSION', 403);
    await withTimeout(member.voice.setChannel(this.channelId, 'AFK Panel: requested Pull'), 12_000, 'AUTOMATION_FAILED');
  }

  setAutomation(value) {
    if (this.kind === 'dm' && value.mode !== 'off') throw new PublicError('GUILD_ONLY');
    if (this.status !== 'connected' && value.mode !== 'off') throw new PublicError('NOT_CONNECTED', 409);
    if (value.mode !== 'off' && this.actions.config.afk) throw new PublicError('ACTION_CONFLICT', 409);
    if (value.mode === 'pull' && !this.channel?.permissionsFor(this.client.user)?.has('MOVE_MEMBERS')) throw new PublicError('AUTOMATION_PERMISSION', 403);
    this.automation.configure(value);
    if (this.status === 'starting') this.initialAutomation = value;
    return this.publicData();
  }

  setActions(value) {
    if (this.kind === 'dm' && (value.afk || value.njm)) throw new PublicError('GUILD_ONLY');
    if (this.status !== 'connected' && (value.afk || value.njm)) throw new PublicError('NOT_CONNECTED', 409);
    this.actions.configure(value);
    if (this.status === 'starting') this.initialActions = this.actions.config;
    return this.publicData();
  }

  confirmMedia() {
    if (this.mediaPending && this.selfVideo === this.mediaPending.camera && this.selfStream === this.mediaPending.share) {
      clearTimeout(this.mediaTimer); this.mediaPending = null; this.mediaError = null;
    }
  }

  setMedia(value) {
    if (this.kind === 'dm') throw new PublicError('GUILD_ONLY');
    const desired = validateMedia(value);
    if (this.status !== 'connected' || this.stopping) throw new PublicError('NOT_CONNECTED', 409);
    if ((desired.camera || desired.share) && !this.channel?.permissionsFor(this.client.user)?.has('STREAM')) throw new PublicError('AUTOMATION_PERMISSION', 403);
    if (this.mediaPending || Date.now() < this.nextMediaChange) throw new PublicError('WAIT', 429);
    this.nextMediaChange = Date.now() + 3000; this.mediaError = null;
    this.mediaRevision++;
    this.mediaPending = desired;
    this.mediaTimer = setTimeout(() => { this.mediaPending = null; this.mediaError = 'MEDIA_FAILED'; }, 10_000);
    this.mediaTimer.unref();
    try {
      if (this.selfVideo !== desired.camera) this.guild.shard.send({ op: 4, d: {
        guild_id: this.guildId, channel_id: this.channelId, self_mute: this.selfMute,
        self_deaf: this.selfDeaf, self_video: desired.camera
      } });
      if (this.selfStream !== desired.share || !desired.share && this.markerStreamKey) {
        if (desired.share) {
          this.markerStreamKey = `guild:${this.guildId}:${this.channelId}:${this.userId}`;
          this.client.ws.broadcast({ op: 18, d: { type: 'guild', guild_id: this.guildId, channel_id: this.channelId, preferred_region: null } });
          this.client.ws.broadcast({ op: 22, d: { stream_key: this.markerStreamKey, paused: true } });
        } else if (this.markerStreamKey) this.client.ws.broadcast({ op: 19, d: { stream_key: this.markerStreamKey } });
      }
      this.confirmMedia();
    } catch {
      clearTimeout(this.mediaTimer); this.mediaPending = null; this.mediaError = 'MEDIA_FAILED';
      throw new PublicError('MEDIA_FAILED', 502);
    }
    return this.publicData();
  }

  clearMedia(send = true) {
    this.mediaRevision++;
    clearTimeout(this.mediaTimer); this.mediaPending = null;
    if (send && this.markerStreamKey) {
      try { this.client?.ws.broadcast({ op: 19, d: { stream_key: this.markerStreamKey } }); } catch { /* already disconnected */ }
    }
    this.markerStreamKey = null; this.selfVideo = false; this.selfStream = false;
  }

  fail(error, leave = true) {
    if (this.stopping || this.status === 'stopping' || !this.active) return Promise.resolve();
    if (['AUTH_REVIEW', 'RATE_LIMITED', 'DISCORD_DENIED'].includes(error.code)) { this.suspend(error.code); return this.stopping || Promise.resolve(); }
    return this.stop(error.code || 'SERVICE_ERROR', leave);
  }

  stop(errorCode = null, leave = true) {
    if (this.stopping) return this.stopping;
    if (!this.active) return Promise.resolve();
    this.status = 'stopping';
    this.errorCode = errorCode;
    clearTimeout(this.voiceTimer);
    clearTimeout(this.voiceControlTimer);
    this.pendingVoice = null;
    this.automation.close(); this.actions.close(); this.clearMedia(leave);
    this.dmCleanup.cancel();
    // Shut down the gateway synchronously on authentication/reconnect failures,
    // before the client's internal reconnect queue gets another turn.
    let clientClosed = false;
    if (['AUTH_REVIEW', 'RATE_LIMITED', 'DISCORD_DENIED', 'RECONNECT_STOPPED', 'DISCONNECTED'].includes(errorCode)) {
      try { this.client?.destroy(); clientClosed = true; } catch { /* finish cleanup below */ }
    }
    this.stopping = (async () => {
      await this.dmCleanup.close();
      if (leave && this.joinRequested) {
        try { this.sendVoice({ channel_id: null, self_mute: true, self_deaf: true }); } catch { /* client already closed */ }
      }
      try { await this.voice?.destroy(); } catch { /* close the Discord session regardless */ }
      if (!clientClosed) { try { await this.client?.destroy(); } catch { /* already destroyed */ } }
      this.client = null;
      this.voice = null;
      this.voiceState = null;
      this.voiceServer = null;
      this.token = '';
      this.tokenHash = '';
      this.node = null;
      this.guild = null;
      this.status = errorCode ? 'error' : 'stopped';
      this.release(this);
    })();
    return this.stopping;
  }
}

class SessionManager {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.pausedAccounts = new Map();
    this.messageTimes = new Map();
    this.dependencies = { ...dependencies, pauseAccount: (hash, accountId, until, ownerId) => {
      this.pausedAccounts.set('token:' + hash, until);
      if (accountId) this.pausedAccounts.set(`account:${ownerId}:${accountId}`, until);
    }, permitMessage: (guildId, channelId) => {
      const key = `${guildId}:${channelId}`, now = Date.now();
      if ((this.messageTimes.get(key) || 0) > now) return false;
      for (const [id, until] of this.messageTimes) if (until <= now) this.messageTimes.delete(id);
      this.messageTimes.set(key, now + 60_000); return true;
    } };
    this.sessions = new Map();
    this.accounts = new Map();
    this.nextStart = 0;
    this.closing = false;
  }

  list(ownerId) { return [...this.sessions.values()].filter(session => session.ownerId === ownerId).map(session => session.publicData()); }

  owned(id, ownerId) {
    const session = this.sessions.get(id);
    if (!session || session.ownerId !== ownerId) throw new PublicError('NOT_FOUND', 404);
    return session;
  }

  hasPullTarget(guildId, targetId, except) {
    return [...this.sessions.values()].some(session => {
      const automation = session.status === 'starting' ? session.initialAutomation : session.automation;
      return session !== except && session.active && session.guildId === guildId
        && automation.mode === 'pull' && automation.targetId === targetId;
    });
  }

  create(input, limit = this.config.maxSessions, ownerId) {
    if (this.closing) throw new PublicError('STOPPING', 503);
    const active = [...this.sessions.values()].filter(session => session.active);
    if (active.length >= this.config.maxSessions || active.filter(session => session.ownerId === ownerId).length >= limit) throw new PublicError('LIMIT', 409);
    if (input.automation?.mode === 'pull' && this.hasPullTarget(input.guildId, input.automation.targetId)) throw new PublicError('TARGET_BUSY', 409);
    const hash = createHash('sha256').update(input.token).digest('hex');
    for (const [key, until] of this.pausedAccounts) if (until <= Date.now()) this.pausedAccounts.delete(key);
    if (this.pausedAccounts.has('token:' + hash) || input.accountId && this.pausedAccounts.has(`account:${ownerId}:${input.accountId}`)) throw new PublicError('ACCOUNT_PAUSED', 429);
    if (active.some(session => session.tokenHash === hash)) throw new PublicError('DUPLICATE', 409);
    if (input.accountId && active.some(session => session.ownerId === ownerId && session.accountId === input.accountId)) throw new PublicError('DUPLICATE', 409);
    if (Date.now() < this.nextStart) throw new PublicError('WAIT', 429);
    this.nextStart = Date.now() + 3000;
    const session = new AccountSession(input, this.config.node, current => {
      const existing = this.accounts.get(current.userId);
      if (existing && existing !== current.id) throw new PublicError('DUPLICATE', 409);
      this.accounts.set(current.userId, current.id);
    }, current => {
      if (this.accounts.get(current.userId) === current.id) this.accounts.delete(current.userId);
    }, this.dependencies);
    if (this.sessions.size >= 60) {
      for (const [id, old] of this.sessions) {
        if (!old.active) { this.sessions.delete(id); break; }
      }
    }
    session.ownerId = ownerId;
    this.sessions.set(session.id, session);
    void session.start();
    return session.publicData();
  }

  async stop(id, remove = false, ownerId) {
    const session = this.owned(id, ownerId);
    await session.stop();
    if (remove) this.sessions.delete(id);
    return session.publicData();
  }

  setVoice(id, voice, ownerId) {
    const session = this.owned(id, ownerId);
    return session.setVoice(voice);
  }

  setAutomation(id, value, ownerId) {
    const session = this.owned(id, ownerId);
    if (value.mode === 'pull' && this.hasPullTarget(session.guildId, value.targetId, session)) throw new PublicError('TARGET_BUSY', 409);
    return session.setAutomation(value);
  }

  setMedia(id, value, ownerId) {
    const session = this.owned(id, ownerId);
    return session.setMedia(value);
  }

  setActions(id, value, ownerId) {
    const session = this.owned(id, ownerId);
    return session.setActions(value);
  }

  async controlDm(id, action, value, ownerId) {
    const session = this.owned(id, ownerId);
    if (action === 'preview') await session.dmCleanup.preview(value.channelId);
    else if (action === 'start') session.dmCleanup.start(value.confirmationId);
    else if (action === 'cancel') session.dmCleanup.cancel();
    else throw new PublicError('BAD_INPUT');
    return session.publicData();
  }

  async close() {
    this.closing = true;
    await Promise.allSettled([...this.sessions.values()].map(session => session.stop()));
  }

  async stopAll(ownerId) {
    await Promise.all([...this.sessions.values()].filter(session => session.ownerId === ownerId).map(session => session.stop()));
    return this.list(ownerId);
  }
}

module.exports = { AccountSession, SessionManager, activeStates };
