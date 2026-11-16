/**
 * GET /api/auth/theme — the palette the sign-in page wears, asked before any
 * session exists. Public, and it names nothing but one of the two built-in
 * themes: never an account, never a third-party package.
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

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-users-public-theme-'));
// Two accounts, one the owner: a single-user licence would refuse the second.
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { attachPluginLoader } = await import('../../plugins/runtime.js');

const app = express();
app.use(createDaemonAuthMiddleware({ token: 'witness-public-theme-token', required: true }));
app.use(express.json());
registerRoutes(app, { setupPolicy: 'free' });

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;

test.after(() => { server.close(); });

function stubTheme(id: string, state: 'active' | 'disabled' = 'active') {
  return {
    id,
    pkg: id,
    dir: `/tmp/${id}`,
    version: '0.1.0',
    state,
    reason: null,
    error: null,
    manifest: {
      id,
      apiVersion: 1,
      kind: ['theme'],
      label: id,
      permissions: [],
      client: { slots: ['theme'], external: [] as string[], mode: 'esm' as const },
      settings: [],
      license: { required: false },
      declares: {},
      modifies: [],
      contains: [],
      screenshots: [],
    },
    client: true,
    signed: false,
  };
}

let timonState: 'active' | 'disabled' = 'active';
attachPluginLoader(app, {
  list: () => [stubTheme('theme-timon', timonState), stubTheme('secret-nord-theme')],
  bundles: { get: () => null },
  covers: { get: () => null },
} as Parameters<typeof attachPluginLoader>[1]);

async function anonymousTheme(): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}/api/auth/theme`);
  return { status: res.status, json: await res.json() };
}

test('before any account, an anonymous caller gets the Timon theme and nothing else', async () => {
  const out = await anonymousTheme();
  assert.equal(out.status, 200, 'public: the sign-in page has no session');
  assert.deepEqual(out.json, { theme: 'theme-timon' });
});

test('the owner\'s choice is the installation\'s, a third-party theme is never named', async () => {
  const owner = createTestAccount(dbApi, { email: 'owner-theme@example.com', name: 'Owner', passwordHash: 'x', isSuperadmin: true });
  // A second account's choice is not the installation's.
  const other = createTestAccount(dbApi, { email: 'other-theme@example.com', name: 'Other', passwordHash: 'x', isSuperadmin: false });
  dbApi.userPrefsSet(other.id, { theme: '@timon/ui-theme' });

  assert.deepEqual((await anonymousTheme()).json, { theme: 'theme-timon' });

  dbApi.userPrefsSet(owner.id, { theme: '@timon/ui-theme' });
  assert.deepEqual((await anonymousTheme()).json, { theme: '@timon/ui-theme' });

  dbApi.userPrefsSet(owner.id, { theme: 'secret-nord-theme' });
  const third = await anonymousTheme();
  assert.deepEqual(third.json, { theme: '@timon/ui-theme' });
  assert.ok(!JSON.stringify(third.json).includes('secret-nord-theme'), 'an installed package must not be confirmed to an anonymous caller');

  dbApi.userPrefsSet(owner.id, { theme: 'theme-timon' });
  assert.deepEqual((await anonymousTheme()).json, { theme: 'theme-timon' });
});

test('a switched-off Timon theme reads as the product\'s', async (t) => {
  timonState = 'disabled';
  t.after(() => { timonState = 'active'; });
  assert.deepEqual((await anonymousTheme()).json, { theme: '@timon/ui-theme' });
});

test('only that exact read is public', async () => {
  assert.equal((await fetch(`${base}/api/auth/theme`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/api/auth/theme/x`)).status, 401);
});
