/**
 * `/api/providers/overview`: who may read it, and what it groups. A superadmin
 * signed in to the app reads one record per provider; anonymous, a plain
 * session, the daemon token and a mission token are refused before anything
 * is gathered.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import express from 'express';
import type { RequestAuth } from '../../users/identity.js';
import type { AgentView } from '../../providers/acp-registry/service.js';

const { dbApi } = await import('../../db.js');
const { agentDir } = await import('../../paths.js');
const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { createBodyParser } = await import('../../kernel/body-parser.js');
const { attachPluginLoader } = await import('../../plugins/runtime.js');
const { orchestratorRoot, readBuiltinList } = await import('../../plugins/builtin.js');
const { readManifest } = await import('../../plugins/manifest.js');
const { registerFileProfile } = await import('../../backends/registry.js');
const { registerProviderOverviewRoutes } = await import('./provider-overview-routes.js');
const { mountOfficialProviders } = await import('../../../tests/helpers/official-providers.js');
await mountOfficialProviders();

const posix = process.platform !== 'win32';
const DAEMON = 'daemon-overview-token';
function user(name: string, superadmin: boolean) {
  const id = randomUUID();
  return createTestAccount(dbApi, { id, email: `${name}-${id}@example.test`, name, passwordHash: 'x', isSuperadmin: superadmin });
}
const admin = user('admin', true);
const bob = user('bob', false);
const IDENTITIES: Record<string, RequestAuth> = {
  admin: { kind: 'session', user: admin, isSuperadmin: true },
  bob: { kind: 'session', user: bob, isSuperadmin: false, permissions: ['plugins:manage'] },
  mission: { kind: 'api-token', user: admin, isSuperadmin: true, missionId: 'm-1' },
};

// A third-party provider whose program is on the PATH but was never accepted.
const BIN_DIR = mkdtempSync(join(tmpdir(), 'timon-overview-'));
const AGENT = join(BIN_DIR, 'acme-overview-agent');
if (posix) {
  writeFileSync(AGENT, '#!/bin/sh\nexit 0\n');
  chmodSync(AGENT, 0o755);
}
const PATH_BEFORE = process.env.PATH;
process.env.PATH = `${BIN_DIR}${delimiter}${PATH_BEFORE ?? ''}`;

const root = orchestratorRoot();
const official = readBuiltinList(root).flatMap(({ source }) => {
  const json = JSON.parse(readFileSync(join(resolve(root, source), 'package.json'), 'utf8')) as Record<string, unknown>;
  const res = readManifest(json);
  if (!res.ok || !res.manifest.kind.includes('provider')) return [];
  return [{ id: res.manifest.id, pkg: res.manifest.id, dir: '', version: '0.1.0', state: 'active', reason: null, error: null, signed: true, manifest: res.manifest, builtin: true }];
});
const loader = {
  list: () => [
    ...official,
    {
      id: 'acme-overview', pkg: '@acme/overview', version: '1.0.0', state: 'failed', reason: 'failed', error: 'not allowed', signed: true,
      manifest: { id: 'acme-overview', kind: ['provider'], label: 'Acme', provider: { binaries: [{ name: 'acme-overview-agent', aliases: [] }], osCredentials: [], credentialDirs: [] } },
    },
    {
      id: 'acme-off', pkg: '@acme/off', version: '1.0.0', state: 'disabled', reason: 'disabled', error: null, signed: true,
      manifest: { id: 'acme-off', kind: ['provider'], label: 'Acme Off', provider: { binaries: [], osCredentials: [], credentialDirs: [], backends: [{ id: 'acme-off' }] } },
    },
    { id: 'plain-widget', pkg: '@acme/w', version: '1.0.0', state: 'active', reason: null, error: null, signed: true, manifest: { id: 'plain-widget', kind: ['widget'] } },
  ],
};

// A backend added by hand that reads a vault entry nobody created.
registerFileProfile('local-file', {
  id: 'my-endpoint', dialect: 'codex', label: 'My endpoint', models: [{ slug: 'my-model', label: 'My model' }], defaultModel: 'my-model',
  env: { OPENAI_API_KEY: { secret: 'MY_ENDPOINT_KEY' } },
});

// Two agents run on the hand-added backend: the page header says so.
for (const name of ['overview-one', 'overview-two']) {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ backend: 'my-endpoint' }));
}

const tampered: AgentView = {
  id: 'acme-acp', name: 'Acme ACP', version: '2.0.0', description: null, website: null, license: null, supported: true, reason: null,
  integrity: 'sha256', installed: { version: '1.0.0', integrity: 'sha256', updateAvailable: true, verifiedUpdate: false, state: 'tampered', profileId: 'acp-acme-acp' },
};

const app = express();
attachPluginLoader(app, loader as never);
app.use((req, res, next) => {
  const as = req.header('x-test-as');
  if (as && IDENTITIES[as]) { req.auth = IDENTITIES[as]; next(); return; }
  createDaemonAuthMiddleware({ token: DAEMON, required: true })(req, res, next);
});
app.use(createBodyParser());
registerProviderOverviewRoutes(app, { acpAgents: async () => [tampered] });
const server: Server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); process.env.PATH = PATH_BEFORE; });

type Caller = 'admin' | 'bob' | 'mission' | 'daemon' | null;
type Provider = {
  id: string; name: string; origin: string; status: string; enabled: boolean; pluginId: string | null; updateAvailable: boolean;
  backends: { id: string }[]; programs: { name: string; path: string | null; authorization: string | null }[];
  secret: { required: boolean; present: boolean; names: string[] };
  agentCount: number;
};
async function call(path: string, as: Caller = 'admin') {
  const headers: Record<string, string> = {};
  if (as === 'daemon') headers.authorization = `Bearer ${DAEMON}`;
  else if (as) headers['x-test-as'] = as;
  const res = await fetch(`${base}/api/providers/overview${path}`, { headers });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text) as { providers?: Provider[]; provider?: Provider; error?: string }, text };
}

test('anonymous, a plain session, the daemon token and a mission token are refused', async () => {
  for (const path of ['', '/provider-claude']) {
    assert.equal((await call(path, null)).status, 401);
    assert.equal((await call(path, 'bob')).status, 403);
    assert.equal((await call(path, 'daemon')).status, 403);
    assert.equal((await call(path, 'mission')).status, 403);
  }
});

test('one record per provider: plugins, split multi-backend plugins, hand-added backends, catalog agents', async () => {
  const res = await call('');
  assert.equal(res.status, 200);
  const providers = res.json.providers!;
  const byId = new Map(providers.map((p) => [p.id, p]));

  const claude = byId.get('provider-claude');
  assert.ok(claude, 'a single-backend plugin is one provider under the plugin id');
  assert.equal(claude.origin, 'built-in');
  assert.equal(claude.pluginId, 'provider-claude');
  assert.deepEqual(claude.backends.map((b) => b.id), ['claude']);
  assert.ok(claude.programs.some((p) => p.name === 'claude'));
  assert.ok(claude.programs.every((p) => p.authorization === null), 'a provider shipped in the release asks no authorization');
  assert.notEqual(claude.status, 'blocked');

  for (const backend of ['opencode', 'hermes', 'antigravity']) {
    const split = byId.get(`provider-acp.${backend}`);
    assert.ok(split, `the ACP agents plugin is one provider per agent (${backend})`);
    assert.deepEqual(split.backends.map((b) => b.id), [backend]);
  }
  assert.equal(byId.has('provider-acp'), false);
  assert.equal(byId.has('plain-widget'), false, 'a plugin that brings no backend is not a provider');

  const off = byId.get('acme-off')!;
  assert.equal(off.status, 'disabled');
  assert.equal(off.enabled, false);
  assert.equal(off.origin, 'plugin');

  const mine = byId.get('user:my-endpoint')!;
  assert.equal(mine.origin, 'user');
  assert.deepEqual(mine.secret, { required: true, present: false, names: ['MY_ENDPOINT_KEY'] });
  assert.equal(mine.agentCount, 2, 'the agents whose backend it brings');
  assert.equal(off.agentCount, 0);

  const agent = byId.get('catalog:acme-acp')!;
  assert.equal(agent.origin, 'catalog');
  assert.equal(agent.status, 'blocked', 'an install whose files changed is blocked, not offered for sign-in');
  assert.equal(agent.updateAvailable, true);

  if (posix) {
    const acme = byId.get('acme-overview')!;
    assert.equal(acme.status, 'needs-authorization');
    assert.deepEqual(acme.programs.map((p) => [p.name, p.path, p.authorization]), [['acme-overview-agent', AGENT, 'authorize']]);
  }
});

test('one provider by id; unknown is 404, malformed is 400', async () => {
  const one = await call('/provider-claude');
  assert.equal(one.status, 200);
  assert.equal(one.json.provider!.id, 'provider-claude');
  assert.equal((await call(`/${encodeURIComponent('user:my-endpoint')}`)).json.provider!.origin, 'user');
  assert.equal((await call('/no-such-provider')).status, 404);
  assert.equal((await call(`/${encodeURIComponent('<script>')}`)).status, 400);
});
