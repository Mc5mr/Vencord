'use strict';
const { PublicError, validateActions } = require('./errors.cjs');
const AFK_INTERVAL = 25 * 60_000;

class AccountActions {
  constructor(session) {
    this.session = session; this.config = validateActions(); this.epoch = 0;
    this.afkNextAt = null; this.njmNextAt = null; this.lastAction = null; this.errorCode = null;
  }
  info() { return { config: this.config, afkNextAt: this.afkNextAt, njmNextAt: this.njmNextAt, lastAction: this.lastAction, errorCode: this.errorCode }; }
  random() { return Math.max(0, Math.min(0.999999, (this.session.dependencies.random || Math.random)())); }
  delay() { return Math.round((this.config.minMinutes + this.random() * (this.config.maxMinutes - this.config.minMinutes)) * 60_000); }
  configure(value) {
    const next = validateActions(value);
    if (next.afk && this.session.automation.mode !== 'off') throw new PublicError('ACTION_CONFLICT', 409);
    this.suspend(); this.epoch++; this.endOwnedMedia();
    this.config = next; this.errorCode = null; this.lastAction = null;
    this.afkNextAt = null; this.njmNextAt = null; this.resume();
  }
  suspend() { clearTimeout(this.afkTimer); clearTimeout(this.njmTimer); this.afkTimer = null; this.njmTimer = null; }
  resume() {
    if (this.session.status !== 'connected' || this.session.stopping) return;
    if (this.config.afk && !this.afkTimer && !this.afkRunning) {
      this.afkNextAt ??= Date.now() + AFK_INTERVAL;
      this.afkTimer = setTimeout(() => { this.afkTimer = null; void this.runAfk(); }, Math.max(750, this.afkNextAt - Date.now())); this.afkTimer.unref();
    }
    if (this.config.njm && !this.njmTimer && !this.njmRunning) {
      this.njmNextAt ??= Date.now() + this.delay();
      this.njmTimer = setTimeout(() => { this.njmTimer = null; void this.runNjm(); }, Math.max(750, this.njmNextAt - Date.now())); this.njmTimer.unref();
    }
  }
  current(epoch) { return epoch === this.epoch && this.session.status === 'connected' && !this.session.stopping; }
  pause(mode, error) {
    this.config = { ...this.config, [mode]: false };
    this[mode + 'NextAt'] = null;
    this.errorCode = error instanceof PublicError && ['ACTION_NO_ROOMS', 'ACTION_PERMISSION', 'AUTOMATION_PERMISSION'].includes(error.code)
      ? error.code === 'AUTOMATION_PERMISSION' ? 'ACTION_PERMISSION' : error.code : 'ACTION_FAILED';
  }
  async runAfk() {
    if (!this.config.afk || this.afkRunning || !this.current(this.epoch)) return;
    const epoch = this.epoch; this.afkRunning = true;
    try {
      let rooms;
      if (this.config.channelIds.length) rooms = await Promise.all(this.config.channelIds.map(id => this.session.client.channels.fetch(id)));
      else rooms = [...(this.session.guild.channels?.cache.values() || [])];
      if (!this.current(epoch)) return;
      rooms = rooms.filter(room => room?.guild?.id === this.session.guildId && room.type === 'GUILD_VOICE'
        && room.permissionsFor(this.session.client.user)?.has(['VIEW_CHANNEL', 'CONNECT'])
        && (!room.userLimit || room.members?.size < room.userLimit || room.permissionsFor(this.session.client.user)?.has('MOVE_MEMBERS')))
        .sort((a, b) => a.id.localeCompare(b.id));
      if (rooms.length < 2) throw new PublicError('ACTION_NO_ROOMS');
      const index = rooms.findIndex(room => room.id === this.session.channelId);
      const target = rooms[(index + 1) % rooms.length];
      this.afkNextAt = Date.now() + AFK_INTERVAL;
      await this.session.moveTo(target.id, () => this.current(epoch) && this.config.afk);
      if (epoch === this.epoch) this.lastAction = 'afk-move';
    } catch (error) { if (epoch === this.epoch) this.pause('afk', error); }
    finally { this.afkRunning = false; this.resume(); }
  }
  async runNjm() {
    if (!this.config.njm || this.njmRunning || !this.current(this.epoch)) return;
    const epoch = this.epoch; this.njmRunning = true;
    this.njmNextAt = Date.now() + this.delay();
    try {
      const choices = [];
      if (this.config.messages.length) choices.push('message');
      if (this.config.typing) choices.push('typing');
      if (!this.ownedMedia && !this.session.mediaPending && Date.now() >= this.session.nextMediaChange) {
        if (this.config.camera && !this.session.selfVideo) choices.push('camera');
        if (this.config.share && !this.session.selfStream) choices.push('share');
      }
      if (!choices.length) return;
      const choice = choices[Math.floor(this.random() * choices.length)];
      if (!this.current(epoch)) return;
      if (choice === 'message' || choice === 'typing') {
        const channel = this.session.channel;
        if (!channel?.permissionsFor(this.session.client.user)?.has(['VIEW_CHANNEL', 'SEND_MESSAGES'])) throw new PublicError('ACTION_PERMISSION');
        if (choice === 'message') {
          if (!this.session.dependencies.permitMessage?.(this.session.guildId, channel.id)) return;
          const content = this.config.messages[Math.floor(this.random() * this.config.messages.length)];
          await channel.send({ content, allowedMentions: { parse: [], repliedUser: false } });
        } else await channel.sendTyping();
      } else {
        const previous = { camera: this.session.selfVideo, share: this.session.selfStream };
        this.session.setMedia({ ...previous, [choice]: true });
        this.ownedMedia = { revision: this.session.mediaRevision, channelId: this.session.channelId, previous };
        this.mediaTimer = setTimeout(() => this.endOwnedMedia(), this.config.mediaMinutes * 60_000); this.mediaTimer.unref();
      }
      if (epoch === this.epoch) this.lastAction = choice;
    } catch (error) { if (epoch === this.epoch) this.pause('njm', error); }
    finally { this.njmRunning = false; this.resume(); }
  }
  endOwnedMedia() {
    clearTimeout(this.mediaTimer);
    const own = this.ownedMedia; this.ownedMedia = null;
    if (!own || this.session.stopping
      || this.session.mediaRevision !== own.revision || this.session.channelId !== own.channelId) return;
    if (this.session.status === 'connecting' || this.session.mediaPending || Date.now() < this.session.nextMediaChange) {
      this.ownedMedia = own;
      this.mediaTimer = setTimeout(() => this.endOwnedMedia(), 1000); this.mediaTimer.unref(); return;
    }
    if (this.session.status !== 'connected') return;
    try { this.session.setMedia(own.previous); }
    catch (error) { this.pause('njm', error); }
  }
  close() {
    this.suspend(); this.epoch++; clearTimeout(this.mediaTimer); this.ownedMedia = null;
    this.afkNextAt = null; this.njmNextAt = null;
  }
}

module.exports = { AccountActions, AFK_INTERVAL };
