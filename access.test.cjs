'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, scryptSync } = require('node:crypto');
const { AccessGate, validateAccess } = require('../access.cjs');

const definitions = [['FAKE_TIER_TEN', 10], ['FAKE_TIER_TWENTY', 20], ['FAKE_TIER_TWENTY_ALIAS', 20], ['FAKE_TIER_THIRTY', 30]];
const entries = definitions.map(([password, limit]) => { const salt = randomBytes(16).toString('hex'); return { limit, salt, hash: scryptSync(password, salt, 32).toString('hex') }; });

test('salted password verification gives the correct tier including aliases and enforces the service maximum', async () => {
  const gate = new AccessGate(validateAccess(entries));
  for (const [password, limit] of definitions) assert.equal(await gate.limit(password, 30), limit);
  assert.equal(await gate.limit(definitions[3][0], 20), 20);
  await assert.rejects(() => gate.limit(undefined, 30), e => e.code === 'ACCESS_REQUIRED');
  await assert.rejects(() => gate.limit('INCORRECT_FAKE_PASSWORD', 30), e => e.code === 'ACCESS_REQUIRED');
});

test('uncached password guesses are rate limited and malformed hash files are rejected', async () => {
  const gate = new AccessGate(entries);
  for (let i = 0; i < 8; i++) await assert.rejects(() => gate.limit('WRONG_PASSWORD_' + i, 30), e => e.code === 'ACCESS_REQUIRED');
  await assert.rejects(() => gate.limit(definitions[0][0], 30), e => e.code === 'ACCESS_WAIT');
  assert.throws(() => validateAccess([{ ...entries[0], limit: 99 }]));
  assert.throws(() => validateAccess([{ ...entries[0], hash: 'incorrect' }]));
});
