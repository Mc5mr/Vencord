'use strict';
const { PublicError, validateAutomation } = require('./errors.cjs');

class VoiceAutomation {
  constructor(session) {
    this.session = session;
    this.mode = 'off'; this.targetId = ''; this.targetChannel = null;
    this.errorCode = null; this.epoch = 0; this.nextAction = 0; this.running = false;
  }
  info() { return { mode: this.mode, targetId: this.targetId, errorCode: this.errorCode }; }
  configure(input) {
    const value = validateAutomation(input);
    if (value.targetId && value.targetId === this.session.userId) throw new PublicError('BAD_INPUT');
    this.cancel(); this.mode = value.mode; this.targetId = value.targetId; this.errorCode = null;
    this.targetChannel = this.session.guild?.voiceStates?.cache.get(this.targetId)?.channelId || null;
    this.schedule();
  }
  observe(data) {
    if (this.mode === 'off' || data.guild_id !== this.session.guildId || data.user_id !== this.targetId) return;
    this.targetChannel = typeof data.channel_id === 'string' ? data.channel_id : null;
    this.schedule();
  }
  cancel() { this.epoch++; clearTimeout(this.timer); this.timer = null; }
  close() { this.cancel(); this.mode = 'off'; this.targetId = ''; this.targetChannel = null; }
  schedule() {
    clearTimeout(this.timer); this.timer = null;
    if (this.mode === 'off' || this.running || this.session.status !== 'connected'
      || !this.targetChannel || this.targetChannel === this.session.channelId) return;
    this.timer = setTimeout(() => { void this.run(); }, Math.max(750, this.nextAction - Date.now()));
    this.timer.unref();
  }
  async run() {
    if (this.running || this.mode === 'off' || this.session.status !== 'connected'
      || !this.targetChannel || this.targetChannel === this.session.channelId) return;
    const epoch = this.epoch, source = this.targetChannel, mode = this.mode;
    const current = () => epoch === this.epoch && this.session.status === 'connected'
      && !this.session.stopping && this.targetChannel === source && this.mode === mode;
    this.running = true; this.nextAction = Date.now() + 5000;
    try {
      if (mode === 'follow') await this.session.followTo(source, current);
      else await this.session.pullMember(this.targetId, source, current);
    } catch (error) {
      if (epoch === this.epoch && this.session.active) {
        this.errorCode = error instanceof PublicError && error.code === 'AUTOMATION_PERMISSION' ? error.code : 'AUTOMATION_FAILED';
        this.mode = 'off'; this.cancel();
      }
    } finally {
      this.running = false;
      // Retry only after a new voice event; never repeatedly retry a failed move.
      if (epoch === this.epoch && source !== this.targetChannel) this.schedule();
    }
  }
}

module.exports = { VoiceAutomation };
