'use strict';
const http = require('node:http');
const { timingSafeEqual, createHash } = require('node:crypto');
const { PublicError, errorResult, validateStart, validateVoice, validateAutomation, validateMedia, validateActions } = require('./errors.cjs');
const { SessionManager } = require('./session.cjs');
const { AccessGate } = require('./access.cjs');

function authorized(header, apiKey) {
  const expected = Buffer.from(`Bearer ${apiKey}`);
  const received = Buffer.from(typeof header === 'string' ? header : '');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new PublicError('BAD_INPUT', 415);
  if (Number(request.headers['content-length'] || 0) > 8192) throw new PublicError('BAD_INPUT', 413);
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 8192) throw new PublicError('BAD_INPUT', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new PublicError('BAD_INPUT'); }
}

function createServer(config, manager = new SessionManager(config)) {
  const access = new AccessGate(config.accessCodes);
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 5000 }, async (req, res) => {
    const send = (status, value) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Connection': 'close', ...(status === 429 ? { 'Retry-After': value.code === 'ACCESS_WAIT' ? '60' : '3' } : {}) });
      res.end(JSON.stringify(value.ok === true ? { ...value, deviceIsolation: 1 } : value));
    };
    try {
      // The plugin talks from Electron's main process. No browser CORS or cookie authentication.
      if (req.headers.origin) throw new PublicError('UNAUTHORIZED', 403);
      if (!authorized(req.headers.authorization, config.apiKey)) throw new PublicError('UNAUTHORIZED', 401);
      const deviceKey = req.headers['x-afk-device-key'];
      if (typeof deviceKey !== 'string' || !/^[a-f0-9]{64}$/.test(deviceKey)) throw new PublicError('DEVICE_REQUIRED', 401);
      const ownerId = createHash('sha256').update(deviceKey).digest('hex');
      const limit = await access.limit(req.headers['x-afk-password'], config.maxSessions);
      if (req.method === 'GET' && req.url === '/v1/health') return send(200, { ok: true, value: { version: 1, maxSessions: limit, controlsVersion: 5 } });
      if (req.method === 'POST' && req.url === '/v1/sessions/stop-all') return send(200, { ok: true, value: { version: 1, maxSessions: limit, sessions: await manager.stopAll(ownerId) } });
      if (req.method === 'GET' && req.url === '/v1/sessions') return send(200, { ok: true, value: { version: 1, maxSessions: limit, sessions: manager.list(ownerId) } });
      if (req.method === 'POST' && req.url === '/v1/sessions') {
        const input = validateStart(await readBody(req));
        return send(202, { ok: true, value: manager.create(input, limit, ownerId) });
      }
      const dmMatch = /^\/v1\/sessions\/([a-f0-9-]{36})\/dm\/(preview|start|cancel)$/.exec(req.url || '');
      if (req.method === 'POST' && dmMatch) {
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || dmMatch[2] === 'preview' && (typeof body.channelId !== 'string' || !/^\d{17,20}$/.test(body.channelId))
          || dmMatch[2] === 'start' && (typeof body.confirmationId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.confirmationId))) throw new PublicError('BAD_INPUT');
        return send(202, { ok: true, value: await manager.controlDm(dmMatch[1], dmMatch[2], body, ownerId) });
      }
      const voiceMatch = /^\/v1\/sessions\/([a-f0-9-]{36})\/voice$/.exec(req.url || '');
      if (req.method === 'POST' && voiceMatch) {
        return send(202, { ok: true, value: manager.setVoice(voiceMatch[1], validateVoice(await readBody(req)), ownerId) });
      }
      const controlMatch = /^\/v1\/sessions\/([a-f0-9-]{36})\/(automation|media|actions)$/.exec(req.url || '');
      if (req.method === 'POST' && controlMatch) {
        const body = await readBody(req);
        const value = controlMatch[2] === 'automation'
          ? await manager.setAutomation(controlMatch[1], validateAutomation(body), ownerId)
          : controlMatch[2] === 'media' ? await manager.setMedia(controlMatch[1], validateMedia(body), ownerId)
            : await manager.setActions(controlMatch[1], validateActions(body), ownerId);
        return send(202, { ok: true, value });
      }
      const match = /^\/v1\/sessions\/([a-f0-9-]{36})(\/stop)?$/.exec(req.url || '');
      if (match && ((req.method === 'POST' && match[2]) || (req.method === 'DELETE' && !match[2]))) {
        return send(200, { ok: true, value: await manager.stop(match[1], req.method === 'DELETE', ownerId) });
      }
      throw new PublicError('NOT_FOUND', 404);
    } catch (error) {
      const safe = errorResult(error);
      send(safe.status, safe.body);
    }
  });
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  return { server, manager };
}

if (require.main === module) {
  let config;
  try { config = require('./config.cjs').loadConfig(); }
  catch { console.error('AFK Panel: check afkpanel.local.json and your private host.json. Run npm run configure for first-time setup.'); process.exit(1); }
  const { server, manager } = createServer(config);
  server.on('error', () => { console.error('AFK Panel could not listen on the configured address.'); process.exitCode = 1; });
  server.listen(config.port, config.bind, () => console.log(`AFK Panel service listening on ${config.bind}:${config.port}. No account sessions are started automatically.`));
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    const force = setTimeout(() => process.exit(1), 20_000); force.unref();
    await manager.close();
    clearTimeout(force);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('uncaughtException', () => { console.error('AFK Panel stopped after an internal error.'); process.exitCode = 1; void shutdown(); });
  process.on('unhandledRejection', () => { console.error('AFK Panel stopped after an internal error.'); process.exitCode = 1; void shutdown(); });
}

module.exports = { createServer, authorized };
