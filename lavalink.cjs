'use strict';
const { PublicError } = require('./errors.cjs');

class LavalinkConnection {
  constructor(node, userId, guildId, onState, onFailure, dependencies = {}) {
    this.node = node;
    this.userId = userId;
    this.guildId = guildId;
    this.onState = onState;
    this.onFailure = onFailure;
    this.WebSocket = dependencies.WebSocket || require('ws');
    this.fetch = dependencies.fetch || global.fetch;
    this.base = `${node.secure ? 'https' : 'http'}://${node.host}:${node.port}`;
    this.closed = false;
    this.controller = new AbortController();
    this.updatePromise = Promise.resolve();
    this.lastVoice = '';
    this.voiceRevision = 0;
    this.awaitingVoice = true;
    this.patchPending = false;
    this.reconnectingVoice = true;
  }

  async request(method, route, body, signal = this.controller.signal) {
    const response = await this.fetch(this.base + route, {
      method, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      headers: { Authorization: this.node.password, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) { await response.body?.cancel(); throw new PublicError('LAVALINK_VOICE'); }
    if (response.status === 204) return null;
    // Parse only bounded responses; never surface server bodies in errors or logs.
    const reader = response.body?.getReader();
    if (!reader) throw new PublicError('LAVALINK_VOICE');
    const chunks = []; let size = 0;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 64 * 1024) { await reader.cancel(); throw new PublicError('LAVALINK_VOICE'); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(this.readyTimer);
        error ? reject(error) : resolve();
      };
      this.finishConnect = finish;
      this.readyTimer = setTimeout(() => finish(new PublicError('LAVALINK_OFFLINE')), 12_000);
      const ws = this.socket = new this.WebSocket(this.base.replace(/^http/, 'ws') + '/v4/websocket', {
        headers: { Authorization: this.node.password, 'User-Id': this.userId, 'Client-Name': 'Mc5mr-AFKPanel/1.0.0' },
        maxPayload: 256 * 1024, handshakeTimeout: 10_000, followRedirects: false
      });
      this.lastActivity = Date.now();
      ws.on('pong', () => { this.lastActivity = Date.now(); });
      ws.on('message', data => {
        if (this.closed) return;
        this.lastActivity = Date.now();
        let packet; try { packet = JSON.parse(data.toString()); } catch { return; }
        if (packet.op === 'ready' && typeof packet.sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(packet.sessionId)) {
          this.sessionId = packet.sessionId;
          finish();
        } else if (packet.op === 'playerUpdate' && packet.guildId === this.guildId && typeof packet.state?.connected === 'boolean') {
          if (!this.awaitingVoice && !this.patchPending) {
            if (packet.state.connected && this.reconnectingVoice) {
              this.reconnectingVoice = false;
              this.settleUntil = Date.now() + 5000;
            }
            if (!packet.state.connected && Date.now() < this.settleUntil) this.checkSettledVoice();
            else this.onState(packet.state.connected);
          }
        } else if (packet.op === 'event' && packet.guildId === this.guildId && packet.type === 'WebSocketClosedEvent') {
          if (!this.reconnectingVoice) {
            if (Date.now() < this.settleUntil) this.checkSettledVoice();
            else this.onFailure(new PublicError('DISCONNECTED'));
          }
        }
      });
      ws.on('error', () => {
        finish(new PublicError('LAVALINK_OFFLINE'));
        if (!this.closed) this.onFailure(new PublicError('LAVALINK_OFFLINE'));
      });
      ws.on('close', () => {
        finish(new PublicError('LAVALINK_OFFLINE'));
        if (!this.closed) this.onFailure(new PublicError('LAVALINK_OFFLINE'));
      });
      this.pingTimer = setInterval(() => {
        if (this.closed) return;
        if (Date.now() - this.lastActivity > 60_000) return this.onFailure(new PublicError('LAVALINK_OFFLINE'));
        if (ws.readyState === 1) ws.ping();
      }, 20_000);
      this.pingTimer.unref();
    });
  }

  beginMove() {
    clearTimeout(this.settleTimer); this.settleTimer = null;
    this.voiceRevision++;
    this.lastVoice = '';
    this.awaitingVoice = true;
    this.reconnectingVoice = true;
    this.settleUntil = 0;
  }

  checkSettledVoice() {
    if (this.settleTimer || this.closed) return;
    const revision = this.voiceRevision;
    const timer = this.settleTimer = setTimeout(async () => {
      try {
        const player = await this.request('GET', `/v4/sessions/${this.sessionId}/players/${this.guildId}`);
        if (this.closed || revision !== this.voiceRevision) return;
        if (player?.state?.connected === true) this.onState(true);
        else this.onFailure(new PublicError('DISCONNECTED'));
      } catch { if (!this.closed && revision === this.voiceRevision) this.onFailure(new PublicError('LAVALINK_VOICE')); }
      finally { if (this.settleTimer === timer) this.settleTimer = null; }
    }, 1000);
    this.settleTimer.unref();
  }

  updateVoice(voice) {
    if (this.closed || !this.sessionId) return;
    const fingerprint = JSON.stringify(voice);
    if (fingerprint === this.lastVoice) return;
    this.lastVoice = fingerprint;
    const revision = this.voiceRevision;
    this.updatePromise = this.updatePromise.then(async () => {
      if (this.closed || revision !== this.voiceRevision) return;
      this.patchPending = true;
      try {
        const result = await this.request('PATCH', `/v4/sessions/${this.sessionId}/players/${this.guildId}`, { voice });
        if (this.closed || revision !== this.voiceRevision) return;
        this.awaitingVoice = false;
        if (result?.state?.connected === true) {
          this.reconnectingVoice = false;
          this.settleUntil = Date.now() + 5000;
          this.onState(true);
        }
      } finally { this.patchPending = false; }
    }).catch(() => { if (!this.closed && revision === this.voiceRevision) this.onFailure(new PublicError('LAVALINK_VOICE')); });
  }

  async destroy() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.readyTimer); clearInterval(this.pingTimer);
    clearTimeout(this.settleTimer);
    this.finishConnect?.(new PublicError('DISCONNECTED'));
    this.controller.abort();
    await this.updatePromise;
    if (this.sessionId) {
      try { await this.request('DELETE', `/v4/sessions/${this.sessionId}/players/${this.guildId}`, undefined, AbortSignal.timeout(2500)); } catch { /* best-effort release */ }
    }
    this.socket?.terminate();
    this.lastVoice = '';
    this.node = { ...this.node, password: '' };
  }
}

module.exports = { LavalinkConnection };
