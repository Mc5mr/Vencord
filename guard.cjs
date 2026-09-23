'use strict';
const { PublicError } = require('./errors.cjs');

function discordFailure(error) {
  if (error?.httpStatus === 401 || error?.captcha || error?.code === 'TOKEN_INVALID' || error?.code === 60003) return 'AUTH_REVIEW';
  if (error?.name === 'RateLimitError' || error?.httpStatus === 429) return 'RATE_LIMITED';
  if (error?.httpStatus === 403) return 'DISCORD_DENIED';
  return null;
}

function guardClient(session, client) {
  // Observe only status/error codes. Never log library errors, headers or bodies.
  client.on('invalidated', () => session.suspend('AUTH_REVIEW'));
  client.on('error', error => session.suspend(discordFailure(error) || 'DISCONNECTED'));
  client.on('shardDisconnect', event => session.suspend(event?.code === 4004 ? 'AUTH_REVIEW' : 'DISCONNECTED'));
  client.on('shardReconnecting', () => session.suspend('RECONNECT_STOPPED'));
  if (client.rest?.request) {
    const request = client.rest.request.bind(client.rest);
    client.rest.request = (method, path, options) => {
      if (!session.active || session.status === 'stopping' || session.stopping) return Promise.reject(new PublicError('NOT_CONNECTED'));
      // The bundled client auto-accepts agreements. Leave verification and
      // account terms to the owner in Discord, including during READY handling.
      if (/^\/users\/@me\/agreements(?:\?|$)/.test(path)) {
        session.suspend('AUTH_REVIEW');
        return Promise.reject(new PublicError('AUTH_REVIEW'));
      }
      return request(method, path, options).catch(error => {
        const code = discordFailure(error);
        if (code) session.suspend(code, error?.timeout);
        throw error;
      });
    };
  }
}

module.exports = { guardClient, discordFailure };
