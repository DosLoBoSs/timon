import '../../test-home.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import express from 'express';
import { dbApi } from '../../db.js';
import { TIMON_HOME } from '../../paths.js';
import type { GhLoginOutcome } from '../../host/gh.js';
import { registerIntegrationRoutes } from './integration-routes.js';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'timon-integration-routes-')));
const ghDir = join(home, '.config', 'gh-work');
mkdirSync(ghDir, { recursive: true });
const repo = join(home, 'code', 'acme');
mkdirSync(repo, { recursive: true });
dbApi.upsertProject('acme', { cwd: repo });

let ghAnswer: GhLoginOutcome = { ok: true, login: 'ai-bot' };
const ghCalls: Array<string | null> = [];

const app = express();
app.use(express.json());
// Stand-in for the daemon's auth middleware: no header = anonymous, else an
// api-token holding the grants the header names.
app.use((req, _res, next) => {
  const who = req.header('x-test-who');
  if (who === 'manager') req.auth = { kind: 'api-token', user: null, isSuperadmin: false, permissions: ['projects:manage'] };
  else if (who === 'reader') req.auth = { kind: 'api-token', user: null, isSuperadmin: false, permissions: ['projects:read', 'kanban:write'] };
  next();
});
registerIntegrationRoutes(app, {
  home,
  ghLogin: async (dir) => { ghCalls.push(dir); return ghAnswer; },
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function call(method: string, path: string, who: 'anonymous' | 'reader' | 'manager', body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who !== 'anonymous') headers['x-test-who'] = who;
  return fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const URL_ = '/api/projects/acme/integration';

test('an anonymous caller is refused on every verb, and nothing is written', async () => {
  assert.equal((await call('GET', URL_, 'anonymous')).status, 401);
  assert.equal((await call('PUT', URL_, 'anonymous', { mode: 'pr', account: 'ai-bot' })).status, 401);
  assert.equal((await call('DELETE', URL_, 'anonymous')).status, 401);
  assert.equal((await call('POST', `${URL_}/check`, 'anonymous')).status, 401);
  assert.equal(dbApi.getProjectRow('acme')?.integration, null);
  assert.deepEqual(ghCalls, []);
});

test('a caller without projects:manage is refused, reads included', async () => {
  assert.equal((await call('GET', URL_, 'reader')).status, 403);
  assert.equal((await call('PUT', URL_, 'reader', { mode: 'pr', account: 'ai-bot' })).status, 403);
  assert.equal((await call('DELETE', URL_, 'reader')).status, 403);
  assert.equal((await call('POST', `${URL_}/check`, 'reader')).status, 403);
  assert.equal(dbApi.getProjectRow('acme')?.integration, null);
  assert.deepEqual(ghCalls, []);
});

test('a manager reads the default, sets, reads back and resets the setting', async () => {
  const first = await (await call('GET', URL_, 'manager')).json() as { configured: boolean; integration: { mode: string } };
  assert.equal(first.configured, false);
  assert.equal(first.integration.mode, 'local');
  const put = await call('PUT', URL_, 'manager', { mode: 'pr', account: 'ai-bot', gh_config_dir: ghDir, branch_prefix: 'sec/' });
  assert.equal(put.status, 200);
  const read = await (await call('GET', URL_, 'manager')).json() as { configured: boolean; integration: Record<string, unknown> };
  assert.equal(read.configured, true);
  assert.deepEqual(read.integration, {
    mode: 'pr', remote: 'origin', target: 'main', forge: 'github', account: 'ai-bot', gh_config_dir: ghDir, branch_prefix: 'sec/',
  });
  assert.ok(dbApi.listAuditLog(50).some((row) => row.action === 'project.integration_set' && row.target === 'acme:pr'));
  const cleared = await (await call('DELETE', URL_, 'manager')).json() as { configured: boolean };
  assert.equal(cleared.configured, false);
  assert.equal(dbApi.getProjectRow('acme')?.integration, null);
});

test('bodies and paths that do not validate are refused before the database', async () => {
  for (const body of [
    { mode: 'pr' },
    { mode: 'local-merge' },
    { forge: 'gitlab' },
    { account: 'not a login' },
    { branch_prefix: 'timon/' },
    { unknown: 1 },
    { gh_config_dir: 'relative/gh' },
    { gh_config_dir: join(tmpdir(), 'outside-home') },
    { gh_config_dir: home },
    { gh_config_dir: join(TIMON_HOME, 'gh') },
    { gh_config_dir: join(repo, '.gh') },
  ]) {
    const res = await call('PUT', URL_, 'manager', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    const text = await res.text();
    if (typeof body.gh_config_dir === 'string') assert.ok(!text.includes(body.gh_config_dir), 'the refusal does not echo the folder');
  }
  assert.equal(dbApi.getProjectRow('acme')?.integration, null);
});

test('an unknown project is 404, an invalid slug 400', async () => {
  assert.equal((await call('GET', '/api/projects/ghost/integration', 'manager')).status, 404);
  assert.equal((await call('PUT', '/api/projects/ghost/integration', 'manager', { mode: 'local' })).status, 404);
  assert.equal((await call('GET', '/api/projects/..%2Fetc/integration', 'manager')).status, 400);
  assert.equal(dbApi.getProjectRow('ghost'), undefined);
});

test('the check asks gh with the configured folder and compares the login, case aside', async () => {
  await call('PUT', URL_, 'manager', { mode: 'pr', account: 'AI-Bot', gh_config_dir: ghDir });
  ghCalls.length = 0;
  ghAnswer = { ok: true, login: 'ai-bot' };
  const good = await (await call('POST', `${URL_}/check`, 'manager')).json() as { ok: boolean; matches: boolean; login: string };
  assert.deepEqual([good.ok, good.matches, good.login], [true, true, 'ai-bot']);
  assert.deepEqual(ghCalls, [ghDir]);
  ghAnswer = { ok: true, login: 'someone-else' };
  const wrong = await (await call('POST', `${URL_}/check`, 'manager')).json() as { ok: boolean; matches: boolean };
  assert.deepEqual([wrong.ok, wrong.matches], [false, false]);
  ghAnswer = { ok: false, code: 'gh_missing', reason: 'the GitHub CLI (gh) was not found on this machine' };
  const missing = await (await call('POST', `${URL_}/check`, 'manager')).json() as { ok: boolean; code: string };
  assert.deepEqual([missing.ok, missing.code], [false, 'gh_missing']);
  await call('DELETE', URL_, 'manager');
});
