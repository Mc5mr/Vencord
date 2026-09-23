'use strict';
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { PublicError } = require('./errors.cjs');
const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
// Call records and membership notices cannot be deleted. Only user-authored types
// that are deletable in DMs are included; unknown/system types are left alone.
const deletableTypes = new Set([0, 19, 20, 23]);

class DmCleanup {
  constructor(session) {
    this.session = session;
    this.state = { status: 'idle', channelId: '', name: '', confirmationId: null, expiresAt: null,
      scanned: 0, deleted: 0, skipped: 0, errorCode: null, retryAt: null };
  }
  info() { return { ...this.state }; }
  get busy() { return Boolean(this.running || this.preparing); }
  available() {
    if (!this.session.client?.user || !this.session.active || this.session.stopping) throw new PublicError('NOT_CONNECTED', 409);
  }
  async preview(channelId) {
    this.available();
    if (!snowflake(channelId)) throw new PublicError('BAD_INPUT');
    if (this.busy) throw new PublicError('DM_BUSY', 409);
    this.preparing = true;
    this.state.confirmationId = null;
    try {
      const channel = await this.session.client.channels.fetch(channelId);
      this.available();
      if (!channel || !['DM', 'GROUP_DM'].includes(channel.type) || channel.id !== channelId) throw new PublicError('DM_ONLY');
      const recipients = channel.recipient?.username || [...(channel.recipients?.values() || [])].map(user => user.username).join(', ');
      const name = String(channel.name || recipients || 'Private conversation').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
      // The boundary is fixed at review time. Messages sent afterwards are untouched.
      this.before = ((BigInt(Date.now()) - 1420070400000n) << 22n).toString();
      this.state = { status: 'ready', channelId, name, confirmationId: randomUUID(), expiresAt: Date.now() + 300_000,
        scanned: 0, deleted: 0, skipped: 0, errorCode: null, retryAt: null };
      return this.info();
    } catch (error) {
      this.state.status = 'error';
      this.state.errorCode = error instanceof PublicError ? error.code : 'DM_ONLY';
      throw error instanceof PublicError ? error : new PublicError('DM_ONLY');
    } finally { this.preparing = false; }
  }
  start(confirmationId) {
    this.available();
    if (this.busy) throw new PublicError('DM_BUSY', 409);
    if (this.blockedUntil > Date.now()) throw new PublicError('DM_RATE_LIMIT', 429);
    if (this.state.status !== 'ready' || !confirmationId || confirmationId !== this.state.confirmationId
      || Date.now() >= this.state.expiresAt) throw new PublicError('DM_CONFIRM', 409);
    this.state.confirmationId = null; this.state.expiresAt = null;
    this.state.status = 'deleting'; this.controller = new AbortController();
    this.running = this.run(this.controller.signal).finally(() => { this.running = null; this.controller = null; });
    return this.info();
  }
  cancel() {
    this.state.confirmationId = null; this.state.expiresAt = null;
    if (this.running) { this.state.status = 'stopping'; this.controller.abort(); }
    else if (this.state.status === 'ready') this.state.status = 'cancelled';
    return this.info();
  }
  async close() { this.cancel(); await this.running; }
  async wait(ms, signal) {
    signal.throwIfAborted();
    await (this.session.dependencies.dmDelay || delay)(ms, undefined, { signal });
    signal.throwIfAborted();
  }
  async request(path, method, signal) {
    for (let attempt = 0; attempt < 5; attempt++) {
      signal.throwIfAborted();
      if (this.nextRequest > Date.now()) await this.wait(this.nextRequest - Date.now(), signal);
      const response = await (this.session.dependencies.dmFetch || fetch)(`https://discord.com/api/v9/channels/${this.state.channelId}/messages${path}`, {
        method, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        headers: { Authorization: this.session.client.token, Accept: 'application/json' }
      });
      this.nextRequest = Date.now() + 1500;
      if (response.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(response.headers.get('x-ratelimit-reset-after'));
        if (Number.isFinite(reset) && reset > 0) this.nextRequest = Math.max(this.nextRequest, Date.now() + reset * 1000 + 250);
      }
      if (response.status === 429) {
        const body = await response.json().catch(() => ({}));
        const seconds = Math.max(Number(body.retry_after) || 0, Number(response.headers.get('retry-after')) || 0);
        if (body.global === true) { this.session.suspend?.('RATE_LIMITED', seconds * 1000); throw new PublicError('DM_RATE_LIMIT'); }
        if (!Number.isFinite(seconds) || seconds <= 0) throw new PublicError('DM_RATE_LIMIT');
        this.nextRequest = Math.max(this.nextRequest, Date.now() + seconds * 1000 + 250);
        // Restarting a cancelled task must not skip Discord's retry window.
        this.blockedUntil = this.nextRequest;
        if (seconds > 3600) throw new PublicError('DM_RATE_LIMIT');
        this.state.status = 'waiting'; this.state.retryAt = this.nextRequest;
        await this.wait(this.nextRequest - Date.now(), signal);
        this.state.status = 'deleting'; this.state.retryAt = null;
        continue;
      }
      if (method === 'DELETE' && response.status === 404) {
        const body = await response.json().catch(() => ({}));
        if (body.code === 10008) return false; // Already removed, not a missing conversation.
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        if (response.status === 401 || body.captcha_service || body.code === 60003) this.session.suspend?.('AUTH_REVIEW');
        else if (response.status === 403) this.session.suspend?.('DISCORD_DENIED');
        throw new PublicError('DM_DELETE_FAILED');
      }
      if (method === 'DELETE') { await response.body?.cancel(); return true; }
      return response.json();
    }
    throw new PublicError('DM_RATE_LIMIT');
  }
  async run(signal) {
    let before = this.before;
    try {
      while (!signal.aborted) {
        const page = await this.request(`?limit=100&before=${before}`, 'GET', signal);
        signal.throwIfAborted();
        if (!Array.isArray(page) || page.length > 100 || page.some(m => !snowflake(m.id) || m.channel_id !== this.state.channelId
          || BigInt(m.id) >= BigInt(before))) throw new PublicError('DM_DELETE_FAILED');
        if (!page.length) { this.state.status = 'completed'; return; }
        let oldest = BigInt(before);
        for (const message of page) {
          signal.throwIfAborted();
          oldest = BigInt(message.id) < oldest ? BigInt(message.id) : oldest;
          this.state.scanned++;
          if (message.author?.id !== this.session.userId) continue;
          if (!deletableTypes.has(message.type) || message.webhook_id) { this.state.skipped++; continue; }
          if (await this.request(`/${message.id}`, 'DELETE', signal)) this.state.deleted++;
          else this.state.skipped++;
        }
        before = oldest.toString();
      }
    } catch (error) {
      if (!signal.aborted) {
        this.state.status = 'error';
        this.state.errorCode = error instanceof PublicError ? error.code : 'DM_DELETE_FAILED';
      }
    } finally {
      if (signal.aborted) this.state.status = 'cancelled';
      this.state.retryAt = null;
    }
  }
}

module.exports = { DmCleanup };
