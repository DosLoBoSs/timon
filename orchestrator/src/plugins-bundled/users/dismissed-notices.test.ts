/**
 * Closed notices — GET / POST /api/prefs/dismissed-notices. Anonymous is
 * refused by the route itself (the witness middleware lets anonymous through,
 * as on a fresh install), two accounts never see each other's list, a
 * daemon-token with no account reads `[]` and cannot write, and the body is
 * zod-strict.
 *
 * Witness server on 127.0.0.1:0, never :3000.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-dismissed-notices-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE, hashSessionToken, issueSessionToken } = await import('../../users/session.js');
const { DISMISSED_NOTICES_MAX, addDismissedNotice, parseStoredDismissedNotices } = await import('../../users/dismissed-notices.js');

const TOKEN = 'witness-dismissed-notices-daemon-token';
const PATH = '/api/prefs/dismissed-notices';

const app = express();
// `required: false`: anonymous reaches the route while no account exists, so
// the refusal tested first is the route's own, not the middleware's.
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: false }));
app.use(express.json());
registerRoutes(app, { setupPolicy: 'free' });

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;

test.after(() => { server.close(); });

function sessionFor(userId: string): string {
  const raw = issueSessionToken();
  dbApi.createSession({ tokenHash: hashSessionToken(raw), userId, expiresAt: Date.now() + 60_000 });
  return raw;
}

async function call(
  method: string,
  opts: { body?: unknown; cookie?: string; bearer?: string } = {},
): Promise<{ status: number; json: { dismissed?: unknown; error?: unknown } }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${PATH}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  return { status: res.status, json: await res.json() as { dismissed?: unknown; error?: unknown } };
}

test('anonymous is refused by the route, on read and on write', async () => {
  assert.equal(dbApi.countUsers(), 0, 'the middleware lets anonymous through only with no account');
  assert.equal((await call('GET')).status, 401);
  assert.equal((await call('POST', { body: { id: '@timon/settings:github-star' } })).status, 401);
});

test('daemon-token without an account: GET is empty, POST is 403', async () => {
  const get = await call('GET', { bearer: TOKEN });
  assert.equal(get.status, 200);
  assert.deepEqual(get.json.dismissed, []);
  assert.equal((await call('POST', { bearer: TOKEN, body: { id: '@timon/settings:github-star' } })).status, 403);
});

test('a closed notice stays closed for its account only', async () => {
  const ada = createTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', passwordHash: 'x', isSuperadmin: false });
  const bob = createTestAccount(dbApi, { email: 'bob@example.com', name: 'Bob', passwordHash: 'x', isSuperadmin: false });
  const adaCookie = sessionFor(ada.id);
  const bobCookie = sessionFor(bob.id);

  const first = await call('POST', { cookie: adaCookie, body: { id: '@timon/settings:github-star' } });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json.dismissed, ['@timon/settings:github-star']);
  const second = await call('POST', { cookie: adaCookie, body: { id: 'example-notice:update-0.2.0' } });
  assert.deepEqual(second.json.dismissed, ['@timon/settings:github-star', 'example-notice:update-0.2.0']);
  const again = await call('POST', { cookie: adaCookie, body: { id: '@timon/settings:github-star' } });
  assert.deepEqual(again.json.dismissed, ['example-notice:update-0.2.0', '@timon/settings:github-star'], 'closing twice keeps one key');

  // A second session of the same account (another client) reads the same list.
  const elsewhere = await call('GET', { cookie: sessionFor(ada.id) });
  assert.deepEqual(elsewhere.json.dismissed, again.json.dismissed);

  const bobRead = await call('GET', { cookie: bobCookie });
  assert.equal(bobRead.status, 200);
  assert.deepEqual(bobRead.json.dismissed, [], 'B does not see what A closed');

  // Anonymous, once accounts exist, is the middleware's 401.
  assert.equal((await call('GET')).status, 401);
  // The chrome prefs of a row created by a dismissal stay the defaults.
  assert.equal(dbApi.userPrefsGet(ada.id).scheme, dbApi.userPrefsGet(null).scheme);
});

test('the body is strict', async () => {
  const carl = createTestAccount(dbApi, { email: 'carl@example.com', name: 'Carl', passwordHash: 'x', isSuperadmin: false });
  const cookie = sessionFor(carl.id);
  for (const body of [{}, { id: '' }, { id: 'x'.repeat(201) }, { id: 'a b' }, { id: '<script>' }, { id: 'ok', user: 'someone' }, { id: 3 }]) {
    assert.equal((await call('POST', { cookie, body })).status, 400, JSON.stringify(body));
  }
  assert.deepEqual((await call('GET', { cookie })).json.dismissed, []);
});

test('the list keeps the newest keys past its ceiling, and a malformed value reads as empty', () => {
  let list: string[] = [];
  for (let i = 0; i < DISMISSED_NOTICES_MAX + 5; i += 1) list = addDismissedNotice(list, `p:n${i}`);
  assert.equal(list.length, DISMISSED_NOTICES_MAX);
  assert.equal(list[0], 'p:n5');
  assert.deepEqual(parseStoredDismissedNotices('not json'), []);
  assert.deepEqual(parseStoredDismissedNotices('{"id":"p:a"}'), []);
  assert.deepEqual(parseStoredDismissedNotices('["p:a", 3, "bad key", "p:a", "p:b"]'), ['p:a', 'p:b']);
});
