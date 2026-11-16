/**
 * The guards on WebSocket upgrades. Upgrades bypass Express and its auth
 * middleware, so `handleUpgrade` applies the daemon's `Host` policy itself (a
 * page that rebound its own domain onto the loopback must not reach the web
 * terminal with the session cookie the browser attaches), exempts only a
 * bearer the daemon recognises, and refuses an anonymous upgrade to a route
 * that declared `auth: 'required'` before the route runs.
 */
// Isolate TIMON_HOME BEFORE any module that touches TIMON state (cf. test-home.ts).
import '../test-home.js';
import http from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RequestAuth } from '../users/identity.js';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createHttpPlugin } = await import('./http-service.js');
const { daemonHostPolicy } = await import('../http-host.js');

const policy = daemonHostPolicy({
  daemon: { listen: { host: '127.0.0.1' }, behindTlsProxy: false },
  app: { listen: { host: '127.0.0.1' }, publicUrl: 'http://timon.localhost' },
});

/** Stands in for `users/upgrade-auth.ts`: one valid bearer, one live session. */
const VALID_BEARER = 'tdev_valid';
function fakeUpgradeAuth(req: IncomingMessage): RequestAuth | undefined {
  if (req.headers.authorization === `Bearer ${VALID_BEARER}`) return { kind: 'device', user: null, isSuperadmin: false, deviceId: 'd1' };
  if (req.headers.cookie === 'timon_session=live') return { kind: 'session', user: null, isSuperadmin: false };
  if (req.headers.authorization === 'Bearer explode') throw new Error('resolver failed');
  return undefined;
}

const ctx = new Context();
await ctx.plugin(createHttpPlugin(express(), { upgradeAuth: fakeUpgradeAuth }));
let reached = 0;
let lastAuth: RequestAuth | undefined;
const witness = (status: string) => (_req: IncomingMessage, socket: Duplex, _head: Buffer, auth: RequestAuth | undefined): void => {
  reached += 1;
  lastAuth = auth;
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};
ctx.http.upgrade({ match: (req) => req.url?.startsWith('/api/terminal/') ?? false, auth: 'required', handle: witness('418 Witness') });
ctx.http.upgrade({ match: (req) => req.url === '/public/ws', auth: 'public', handle: witness('418 Public') });

const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
server.on('upgrade', (req, socket, head) => ctx.http.handleUpgrade(req, socket, head, () => policy));
let port = 0;

before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as AddressInfo).port;
});
after(() => { server.close(); });

const TERMINAL_PATH = '/api/terminal/web/sessions/00000000-0000-0000-0000-000000000000/ws';

/** Sends a raw WebSocket handshake and returns the status line of the answer ('' when the socket was dropped). */
async function upgradeStatus(headers: Record<string, string>, path = TERMINAL_PATH): Promise<string> {
  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  const lines = [
    `GET ${path} HTTP/1.1`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ];
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  let answer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => { answer += chunk; });
  await once(socket, 'close');
  return answer.split('\r\n')[0] ?? '';
}

test('an upgrade naming a foreign Host is refused with a neutral 421, before any handler', async () => {
  const before = reached;
  const status = await upgradeStatus({ Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` });
  assert.equal(status, 'HTTP/1.1 421 Misdirected Request');
  assert.equal(reached, before, 'the handler never saw the request');
});

test('an identified upgrade naming a local Host reaches the route, with its identity', async () => {
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `timon.localhost:${port}`]) {
    const before = reached;
    assert.equal(await upgradeStatus({ Host: host, Cookie: 'timon_session=live' }), 'HTTP/1.1 418 Witness', host);
    assert.equal(reached, before + 1, host);
    assert.equal(lastAuth?.kind, 'session', host);
  }
});

test('an anonymous upgrade is refused with 401 before a route that requires an identity runs', async () => {
  const before = reached;
  assert.equal(await upgradeStatus({ Host: `127.0.0.1:${port}` }), 'HTTP/1.1 401 Unauthorized');
  assert.equal(await upgradeStatus({ Host: `127.0.0.1:${port}`, Cookie: 'timon_session=dead' }), 'HTTP/1.1 401 Unauthorized');
  assert.equal(await upgradeStatus({ Host: `127.0.0.1:${port}`, Authorization: 'Bearer forged' }), 'HTTP/1.1 401 Unauthorized');
  assert.equal(reached, before, 'the route never saw the request');
});

test('a route that declared itself public receives anonymous upgrades', async () => {
  const before = reached;
  assert.equal(await upgradeStatus({ Host: `127.0.0.1:${port}` }, '/public/ws'), 'HTTP/1.1 418 Public');
  assert.equal(reached, before + 1);
  assert.equal(lastAuth, undefined);
});

test('a valid bearer credential exempts the upgrade from the Host guard, as it does any other request', async () => {
  const before = reached;
  const status = await upgradeStatus({ Host: `machine.example:${port}`, Authorization: `Bearer ${VALID_BEARER}` });
  assert.equal(status, 'HTTP/1.1 418 Witness');
  assert.equal(reached, before + 1);
  assert.equal(lastAuth?.kind, 'device');
});

test('a forged bearer does not exempt the upgrade from the Host guard, even toward a public route', async () => {
  const before = reached;
  for (const path of [TERMINAL_PATH, '/public/ws']) {
    const status = await upgradeStatus({ Host: `evil.example:${port}`, Authorization: 'Bearer forged' }, path);
    assert.equal(status, 'HTTP/1.1 421 Misdirected Request', path);
  }
  assert.equal(reached, before, 'no route saw the request');
});

test('a session cookie never exempts the upgrade from the Host guard, bearer header or not', async () => {
  const before = reached;
  const status = await upgradeStatus({ Host: `evil.example:${port}`, Cookie: 'timon_session=live', Authorization: 'Bearer forged' });
  assert.equal(status, 'HTTP/1.1 421 Misdirected Request');
  assert.equal(reached, before);
});

test('an upgrade no route claims, or whose identity cannot be resolved, is dropped', async () => {
  const before = reached;
  assert.equal(await upgradeStatus({ Host: `127.0.0.1:${port}`, Cookie: 'timon_session=live' }, '/nowhere/ws'), '');
  assert.equal(await upgradeStatus({ Host: `127.0.0.1:${port}`, Authorization: 'Bearer explode' }), '');
  assert.equal(reached, before);
});

test('a kernel built without an identity resolver knows nobody', async () => {
  const bare = new Context();
  await bare.plugin(createHttpPlugin(express()));
  let seen = 0;
  bare.http.upgrade({ match: () => true, auth: 'required', handle: (_req, socket) => { seen += 1; socket.destroy(); } });
  const other = http.createServer();
  other.on('upgrade', (req, socket, head) => bare.http.handleUpgrade(req, socket, head, () => policy));
  other.listen(0, '127.0.0.1');
  await once(other, 'listening');
  const saved = port;
  port = (other.address() as AddressInfo).port;
  try {
    assert.equal(await upgradeStatus({ Host: `127.0.0.1:${port}`, Authorization: `Bearer ${VALID_BEARER}` }), 'HTTP/1.1 401 Unauthorized');
    assert.equal(await upgradeStatus({ Host: `evil.example:${port}`, Authorization: `Bearer ${VALID_BEARER}` }), 'HTTP/1.1 421 Misdirected Request');
    assert.equal(seen, 0);
  } finally {
    port = saved;
    other.close();
  }
});

test('the default policy is the daemon\'s own, read from its config', async () => {
  const other = http.createServer();
  other.on('upgrade', (req, socket, head) => ctx.http.handleUpgrade(req, socket, head));
  other.listen(0, '127.0.0.1');
  await once(other, 'listening');
  const saved = port;
  port = (other.address() as AddressInfo).port;
  try {
    assert.equal(await upgradeStatus({ Host: 'evil.example' }), 'HTTP/1.1 421 Misdirected Request');
  } finally {
    port = saved;
    other.close();
  }
});
