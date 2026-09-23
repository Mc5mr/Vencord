'use strict';
const { scrypt, timingSafeEqual, createHash } = require('node:crypto');
const { promisify } = require('node:util');
const { PublicError } = require('./errors.cjs');
const derive = promisify(scrypt);

function validateAccess(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8 || value.some(entry =>
    !entry || ![10, 20, 30].includes(entry.limit) || !/^[a-f0-9]{32}$/.test(entry.salt)
    || !/^[a-f0-9]{64}$/.test(entry.hash))) throw Error('Invalid access password configuration.');
  return value.map(({ limit, salt, hash }) => ({ limit, salt, hash }));
}

class AccessGate {
  constructor(entries = []) { this.entries = entries; this.cache = new Map(); this.attempts = []; this.pending = 0; }
  async limit(password, maximum) {
    if (!this.entries.length) return maximum;
    if (typeof password !== 'string' || !/^[A-Za-z0-9_-]{2,128}$/.test(password)) throw new PublicError('ACCESS_REQUIRED', 403);
    const fingerprint = createHash('sha256').update(password).digest('hex');
    const known = this.cache.get(fingerprint);
    if (known) return Math.min(known, maximum);
    const now = Date.now();
    this.attempts = this.attempts.filter(time => time > now - 60_000);
    if (this.attempts.length >= 8 || this.pending >= 2) throw new PublicError('ACCESS_WAIT', 429);
    this.attempts.push(now); this.pending++;
    try {
      let result = 0;
      for (const entry of this.entries) {
        const hash = await derive(password, entry.salt, 32);
        if (timingSafeEqual(hash, Buffer.from(entry.hash, 'hex'))) result = Math.max(result, entry.limit);
      }
      if (!result) throw new PublicError('ACCESS_REQUIRED', 403);
      this.cache.set(fingerprint, result);
      return Math.min(result, maximum);
    } finally { this.pending--; }
  }
}

module.exports = { AccessGate, validateAccess };
