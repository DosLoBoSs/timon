/**
 * `POST /api/missions/:id/fence-grants/:refusalId` (TODO #1162): who may answer
 * the "Allow for this agent" card of a fence refusal, and what an answer does.
 *
 * Access first: an anonymous caller is refused whether or not auth is
 * required, the daemon token and a mission token are refused (a person's
 * gesture only), and a person without the rights of the folder list cannot
 * allow. Then the answer: an accord adds the folder and relaunches the
 * mission, once; a refusal changes nothing; a refusal with no offer, or an
 * offer forged into the journal toward the Timon home, opens nothing. Real
 * auth middleware, isolated TIMON_HOME, witness on :0.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-fence-grant-routes-'));
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const TOKEN = 'witness-daemon-token';
writeFileSync(join(process.env.TIMON_HOME, 'daemon-token'), TOKEN, { encoding: 'utf8', mode: 0o600 });

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerAgentRoutes } = await import('../agents/routes.js');
const { registerFenceGrantRoutes } = await import('./fence-grant-routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { issueMissionApiToken } = await import('../../users/api-tokens.js');
const { agentConfig, TIMON_HOME } = await import('../../paths.js');

const relaunched: Array<{ missionId: string; text: string }> = [];

async function serve(required: boolean): Promise<{ base: string; close: () => void }> {
  const app = express();
  app.use(createDaemonAuthMiddleware({ token: TOKEN, required }));
  app.use(express.json());
  registerUserRoutes(app, { setupPolicy: 'free' });
  registerAgentRoutes(app);
  registerFenceGrantRoutes(app, {
    relaunch: async (mission, text) => { relaunched.push({ missionId: mission.id, text }); return true; },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  assert.notEqual(port, 3001, 'the witness must not take the production port');
  return { base: `http://127.0.0.1:${port}`, close: () => { server.close(); } };
}

const strict = await serve(true);
const open = await serve(false);
test.after(() => { strict.close(); open.close(); });

type Result = { status: number; json: Record<string, unknown>; res: Response };

async function call(method: string, path: string, opts: { body?: unknown; bearer?: string; cookie?: string; base?: string } = {}): Promise<Result> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  const res = await fetch(`${opts.base ?? strict.base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { json = { raw: text }; }
  return { status: res.status, json, res };
}

function sessionCookie(res: Response): string {
  for (const line of res.headers.getSetCookie()) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  throw new Error('no session cookie');
}

const setup = await call('POST', '/api/auth/setup', { body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' } });
assert.equal(setup.status, 201);
const adminCookie = sessionCookie(setup.res);
const adminId = dbApi.getUserByEmail('admin@example.com')!.id;
await postTestAccount(dbApi, { email: 'mgr@example.com', name: 'Manager', password: 'mgr-secret' });
const managerId = dbApi.getUserByEmail('mgr@example.com')!.id;
grantTestPermissions(dbApi, managerId, ['agents:manage', 'agents:read', 'missions:read', 'missions:spawn']);
const managerCookie = sessionCookie((await call('POST', '/api/auth/login', { body: { email: 'mgr@example.com', password: 'mgr-secret' } })).res);

for (const name of ['lib.coder', 'lib.other']) {
  const made = await call('POST', '/api/agents', { bearer: TOKEN, body: { name, system_prompt: 'p', config: { role: 'coder' } } });
  assert.equal(made.status, 200, JSON.stringify(made.json));
}

const folder = mkdtempSync(join(tmpdir(), 'timon-fence-grant-folder-'));
const storedOf = (agent: string): unknown => (JSON.parse(readFileSync(agentConfig(agent), 'utf8')) as { extra_dirs?: unknown }).extra_dirs;

function mission(agent: string, owner: string): string {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'work', undefined, owner);
  return id;
}

/** A refusal as `logFenceRefused` stores it, with or without an offer. */
function refusal(missionId: string, agent: string, grant: { path: string; display: string; mode: 'read' | 'write' } | null, extra: Record<string, unknown> = {}): string {
  const id = randomUUID();
  dbApi.insertEvent(missionId, 'fence_refused', {
    type: 'fence_refused', id, path: join(grant?.path ?? folder, 'state.db'), display: '~/state.db', access: 'write',
    mechanism: 'landlock', stage: 'run', missionId, agent, backend: 'claude', timonHome: false, grantable: true,
    dropped: null, setting: { category: 'system', tab: 'security' }, grant, ...extra,
  });
  return id;
}

const route = (missionId: string, refusalId: string): string => `/api/missions/${missionId}/fence-grants/${refusalId}`;
const offer = { path: folder, display: folder, mode: 'write' as const };

test('an anonymous caller is refused, whether or not auth is required', async () => {
  const m = mission('lib.coder', adminId);
  const id = refusal(m, 'lib.coder', offer);
  for (const base of [strict.base, open.base]) {
    assert.equal((await call('POST', route(m, id), { base, body: { decision: 'allow' } })).status, 401);
  }
  assert.equal((await call('POST', route(m, id), { bearer: 'wrong-token', body: { decision: 'allow' } })).status, 401);
  assert.equal(storedOf('lib.coder'), undefined);
  assert.equal(relaunched.length, 0);
});

test('the daemon token and a mission token are refused: a person answers the card', async () => {
  const m = mission('lib.coder', adminId);
  const id = refusal(m, 'lib.coder', offer);
  const daemon = await call('POST', route(m, id), { bearer: TOKEN, body: { decision: 'allow' } });
  assert.equal(daemon.status, 403);
  assert.equal(daemon.json.code ?? daemon.json.error, 'fence_grant_session_required');
  const own = await call('POST', route(m, id), { bearer: issueMissionApiToken(m), body: { decision: 'allow' } });
  assert.equal(own.status, 403);
  assert.equal(storedOf('lib.coder'), undefined);
  assert.equal(relaunched.length, 0);
});

test('a person without agents:privileged-config cannot allow, and may still close the card', async () => {
  const m = mission('lib.other', managerId);
  const allowId = refusal(m, 'lib.other', offer);
  const r = await call('POST', route(m, allowId), { cookie: managerCookie, body: { decision: 'allow' } });
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.equal(storedOf('lib.other'), undefined);
  const refuseId = refusal(m, 'lib.other', offer);
  const closed = await call('POST', route(m, refuseId), { cookie: managerCookie, body: { decision: 'refuse' } });
  assert.equal(closed.status, 200, JSON.stringify(closed.json));
  assert.equal(relaunched.length, 0);
});

test('an accord adds the folder, records the answer and relaunches the mission, once', async () => {
  const m = mission('lib.coder', adminId);
  const id = refusal(m, 'lib.coder', offer);
  const r = await call('POST', route(m, id), { cookie: adminCookie, body: { decision: 'allow' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.relaunched, true);
  assert.deepEqual(storedOf('lib.coder'), [{ path: folder, mode: 'write' }]);
  const answer = dbApi.listEvents(m).find((e) => e.type === 'fence_grant_resolved');
  assert.ok(answer);
  assert.deepEqual(
    (({ id: rid, status, path, mode }) => ({ id: rid, status, path, mode }))(JSON.parse(answer.payload) as Record<string, unknown>),
    { id, status: 'allowed', path: folder, mode: 'write' },
  );
  assert.equal(relaunched.length, 1);
  assert.equal(relaunched[0]!.missionId, m);
  assert.match(relaunched[0]!.text, /may now read and write/);
  const again = await call('POST', route(m, id), { cookie: adminCookie, body: { decision: 'allow' } });
  assert.equal(again.status, 409);
  assert.equal(relaunched.length, 1);
});

test('a refusal of the card changes nothing and relaunches nothing', async () => {
  const before = storedOf('lib.coder');
  const m = mission('lib.coder', adminId);
  const id = refusal(m, 'lib.coder', { path: mkdtempSync(join(tmpdir(), 'timon-fence-grant-no-')), display: 'x', mode: 'write' });
  const r = await call('POST', route(m, id), { cookie: adminCookie, body: { decision: 'refuse' } });
  assert.equal(r.status, 200);
  assert.equal((r.json.resolution as { status: string }).status, 'refused');
  assert.deepEqual(storedOf('lib.coder'), before);
  assert.equal(relaunched.length, 1);
});

test('no card to answer: no offer, the Timon home, another mission\'s refusal, an unknown id', async () => {
  const m = mission('lib.coder', adminId);
  const before = storedOf('lib.coder');
  const none = refusal(m, 'lib.coder', null);
  assert.equal((await call('POST', route(m, none), { cookie: adminCookie, body: { decision: 'allow' } })).status, 404);
  const home = refusal(m, 'lib.coder', { path: join(TIMON_HOME, 'agents'), display: '~/.timon/agents', mode: 'write' }, { timonHome: true, grantable: false });
  assert.equal((await call('POST', route(m, home), { cookie: adminCookie, body: { decision: 'allow' } })).status, 404);
  const elsewhere = refusal(mission('lib.coder', adminId), 'lib.coder', offer);
  assert.equal((await call('POST', route(m, elsewhere), { cookie: adminCookie, body: { decision: 'allow' } })).status, 404);
  assert.equal((await call('POST', route(m, randomUUID()), { cookie: adminCookie, body: { decision: 'allow' } })).status, 404);
  assert.equal((await call('POST', route(m, none), { cookie: adminCookie, body: { decision: 'maybe' } })).status, 400);
  assert.deepEqual(storedOf('lib.coder'), before);
});

test('an offer forged toward the Timon home is refused by the folder checks, nothing stored', async () => {
  const m = mission('lib.other', adminId);
  const forged = refusal(m, 'lib.other', { path: TIMON_HOME, display: '~/.timon', mode: 'write' });
  const r = await call('POST', route(m, forged), { cookie: adminCookie, body: { decision: 'allow' } });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.equal(r.json.code ?? r.json.error, 'extra_dir_refused');
  assert.equal(storedOf('lib.other'), undefined);
  assert.equal(dbApi.listEvents(m).some((e) => e.type === 'fence_grant_resolved'), false);
});
