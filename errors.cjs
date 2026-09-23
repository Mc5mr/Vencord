'use strict';

const messages = Object.freeze({
  BAD_INPUT: 'Enter a complete account token and valid IDs for the selected server room or private call.',
  DM_ONLY: 'Choose an existing DM or group DM accessible to this account.',
  GUILD_ONLY: 'Follow, Pull, room rotation and random actions are available in server voice rooms only.',
  DM_CONFIRM: 'Review the conversation again before confirming deletion. Confirmations expire after five minutes.',
  DM_BUSY: 'Stop the current message deletion before choosing another conversation.',
  DM_DELETE_FAILED: 'Deletion stopped after a failed request. Check the conversation and review it again to continue.',
  DM_RATE_LIMIT: 'Discord requested a long pause. Deletion stopped; wait before reviewing and starting again.',
  UNAUTHORIZED: 'The AFK service key is missing or incorrect.',
  DEVICE_REQUIRED: 'Update AFK Panel on this computer. A private device key is required.',
  ACCESS_REQUIRED: 'Enter a valid access password for the 10, 20, or 30 account tier.',
  ACCESS_WAIT: 'Too many password attempts. Wait a minute before trying again.',
  LIMIT: 'Stop an existing session before starting another account.',
  WAIT: 'Wait a few seconds before starting another session.',
  DUPLICATE: 'This account already has an active AFK session.',
  LOGIN_FAILED: 'Discord did not allow this sign-in. Check the token or sign in normally.',
  AUTH_REVIEW: 'Discord requested account verification or rejected authentication. This session stopped. Review the account in Discord before trying again.',
  RATE_LIMITED: 'Discord limited requests. The session stopped and will not retry automatically.',
  DISCORD_DENIED: 'Discord refused a request. The session stopped; check permissions and account notices in Discord.',
  ACCOUNT_PAUSED: 'This account is temporarily paused after a Discord restriction. Review the account in Discord and wait before retrying.',
  RECONNECT_STOPPED: 'The gateway requested a reconnect. The session stopped instead of signing in again automatically.',
  USER_ONLY: 'Use a user account you own. This service does not accept bot tokens.',
  CHANNEL: 'The voice channel is unavailable, belongs to another server, or you cannot connect to it.',
  LAVALINK_OFFLINE: 'Could not connect to the configured Lavalink node.',
  LAVALINK_VERSION: 'The Lavalink node must support API v4 and current Discord voice encryption.',
  LAVALINK_VOICE: 'The Lavalink node could not establish the voice connection.',
  VOICE_TIMEOUT: 'Voice connection was not confirmed. Check the channel permissions and Lavalink version.',
  NOT_CONNECTED: 'Wait until the account is connected before changing its voice state.',
  VOICE_CONTROL_FAILED: 'Discord did not confirm the voice change. The last confirmed state is shown.',
  AUTOMATION_PERMISSION: 'The account or target does not have the required voice-channel permissions.',
  AUTOMATION_FAILED: 'Follow or Pull was paused after a failed operation. Check permissions before enabling it again.',
  TARGET_BUSY: 'Another session is already pulling this member.',
  MEDIA_FAILED: 'Discord did not confirm the media marker. No video is being transmitted.',
  ACTION_CONFLICT: 'Turn off Follow / Pull before enabling AFK Action, or turn off AFK Action first.',
  ACTION_NO_ROOMS: 'AFK Action needs at least two accessible voice rooms in this server.',
  ACTION_PERMISSION: 'The action was paused because a required channel permission is missing.',
  ACTION_FAILED: 'The action was paused after a failed request. Check the settings before enabling it again.',
  DISCONNECTED: 'The voice connection ended. Start the session again when ready.',
  MOVED: 'The account left or was moved out of the selected channel. AFK was stopped.',
  SERVICE_ERROR: 'The operation could not be completed. No automatic retry was made.',
  NOT_FOUND: 'This session is no longer available.',
  STOPPING: 'The service is shutting down.'
});

class PublicError extends Error {
  constructor(code, status = 400) { super(messages[code] || messages.SERVICE_ERROR); this.code = code in messages ? code : 'SERVICE_ERROR'; this.status = status; }
}

function errorResult(error) {
  const safe = error instanceof PublicError ? error : new PublicError('SERVICE_ERROR', 500);
  return { status: safe.status, body: { ok: false, code: safe.code, error: safe.message } };
}

function validateStart(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PublicError('BAD_INPUT');
  const { token, guildId = '', channelId, kind = 'guild', accountId = null, selfMute = true, selfDeaf = true, platform = 'desktop', automation = { mode: 'off', targetId: '' } } = value;
  if (typeof token !== 'string' || token.length < 20 || token.length > 2048 || !/^[\w.-]+$/.test(token)
    || !(token.startsWith('mfa.') || token.split('.').length === 3)
    || !['guild', 'dm'].includes(kind) || (kind === 'dm' ? guildId !== '' : typeof guildId !== 'string' || !/^\d{17,20}$/.test(guildId))
    || typeof channelId !== 'string' || !/^\d{17,20}$/.test(channelId)
    || (accountId !== null && (typeof accountId !== 'string' || !/^[a-f0-9-]{36}$/.test(accountId)))
    || !['desktop', 'mobile'].includes(platform)) throw new PublicError('BAD_INPUT');
  const voice = validateVoice({ selfMute, selfDeaf });
  const watch = validateAutomation(automation);
  const actions = validateActions(value.actions);
  if (kind === 'dm' && (watch.mode !== 'off' || actions.afk || actions.njm)) throw new PublicError('GUILD_ONLY');
  if (actions.afk && watch.mode !== 'off') throw new PublicError('ACTION_CONFLICT');
  return { token, kind, guildId, channelId, accountId, platform, actions, automation: watch, ...voice };
}

function validateVoice(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.selfMute !== 'boolean' || typeof value.selfDeaf !== 'boolean'
    || (value.selfDeaf && !value.selfMute)) throw new PublicError('BAD_INPUT');
  return { selfMute: value.selfMute, selfDeaf: value.selfDeaf };
}

function validateAutomation(value) {
  if (!value || !['off', 'follow', 'pull'].includes(value.mode)
    || value.mode !== 'off' && (typeof value.targetId !== 'string' || !/^\d{17,20}$/.test(value.targetId))) throw new PublicError('BAD_INPUT');
  return { mode: value.mode, targetId: value.mode === 'off' ? '' : value.targetId };
}

function validateMedia(value) {
  if (!value || typeof value.camera !== 'boolean' || typeof value.share !== 'boolean') throw new PublicError('BAD_INPUT');
  return { camera: value.camera, share: value.share };
}

function validateActions(value) {
  if (value === undefined) return { afk: false, channelIds: [], njm: false, messages: [], camera: false, share: false, typing: false, minMinutes: 10, maxMinutes: 25, mediaMinutes: 2 };
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ['afk', 'njm', 'camera', 'share', 'typing'].some(key => typeof value[key] !== 'boolean')
    || !Array.isArray(value.channelIds) || value.channelIds.length > 12 || value.channelIds.some(id => typeof id !== 'string' || !/^\d{17,20}$/.test(id))
    || !Array.isArray(value.messages) || value.messages.length > 3 || value.messages.some(text => typeof text !== 'string' || text.length > 200 || /[\u0000-\u001f\u007f]/.test(text))
    || !Number.isInteger(value.minMinutes) || value.minMinutes < 5 || value.minMinutes > 120
    || !Number.isInteger(value.maxMinutes) || value.maxMinutes < value.minMinutes || value.maxMinutes > 180
    || !Number.isInteger(value.mediaMinutes) || value.mediaMinutes < 1 || value.mediaMinutes > 5) throw new PublicError('BAD_INPUT');
  const channelIds = [...new Set(value.channelIds)], messages = value.messages.map(text => text.trim()).filter(Boolean);
  if (value.afk && channelIds.length === 1 || value.njm && !messages.length && !value.camera && !value.share && !value.typing) throw new PublicError('BAD_INPUT');
  return { afk: value.afk, channelIds, njm: value.njm, messages, camera: value.camera, share: value.share,
    typing: value.typing, minMinutes: value.minMinutes, maxMinutes: value.maxMinutes, mediaMinutes: value.mediaMinutes };
}

module.exports = { PublicError, errorResult, validateStart, validateVoice, validateAutomation, validateMedia, validateActions, messages };
