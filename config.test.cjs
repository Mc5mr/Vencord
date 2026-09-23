'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../config.cjs');

test('configuration accepts up to 30 sessions and rejects invalid limits', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'afkp-limit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'afkpanel.local.json');
  fs.writeFileSync(path.join(directory, 'host.json'), JSON.stringify([
    { identifier: 'test', host: '127.0.0.1', port: 2333, secure: false, password: 'FAKE_NODE_PASSWORD' }
  ]));
  const config = {
    apiKey: 'FAKE_SERVICE_KEY_ONLY_FOR_TESTS_123456789', bind: '127.0.0.1', port: 3847,
    lavalinkFile: './host.json', lavalinkNode: 'test'
  };
  for (const maxSessions of [1, 5, 30]) {
    fs.writeFileSync(file, JSON.stringify({ ...config, maxSessions }));
    assert.equal(loadConfig(file).maxSessions, maxSessions);
  }
  for (const maxSessions of [0, 31, 1.5, '30']) {
    fs.writeFileSync(file, JSON.stringify({ ...config, maxSessions }));
    assert.throws(() => loadConfig(file), /maxSessions must be between 1 and 30/);
  }
});
