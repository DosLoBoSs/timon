/**
 * DELETE /api/agents/:name — Express decodes the parameter, so `%2e%2e` reaches
 * the handler as `..`, the Timon home. It is a 400 that leaves the home intact,
 * and an anonymous caller is refused before anything, even on the first-run
 * loopback.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const HOME = mkdtempSync(join(tmpdir(), 'timon-agent-delete-traversal-'));
process.env.TIMON_HOME = HOME;
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
await import('../../../tests/helpers/claude-provider.js');

const { registerRoutes } = await import('./routes.js');
const { agentDir } = await import('../../paths.js');
const { dbApi } = await import('../../db.js');

const TOKEN = 'witness-daemon-token';
const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: false }));
app.use(express.json());
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = (server.address() as AddressInfo).port;
test.after(() => { server.close(); });

const WITNESS = join(HOME, 'witness.txt');
writeFileSync(WITNESS, 'still here');

function seed(name: string): void {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'system-prompt.md'), 'test');
  writeFileSync(join(agentDir(name), 'config.json'), '{}');
}
seed('bystander');

// `node:http`, not `fetch`: the WHATWG URL parser folds `%2e%2e` into `..` and
// resolves it before sending, and a caller with a raw client does not.
function del(rawName: string, bearer?: string): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const req = request({
      host: '127.0.0.1', port, method: 'DELETE', path: `/api/agents/${rawName}`,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    }, (res) => { res.resume(); res.on('end', () => resolveStatus(res.statusCode ?? 0)); });
    req.on('error', reject);
    req.end();
  });
}

function homeIntact(): void {
  assert.equal(existsSync(WITNESS), true, 'the home root was not touched');
  assert.equal(existsSync(agentDir('bystander')), true, 'the other agents are still there');
}

test('an anonymous caller is refused on the first-run loopback', async () => {
  assert.equal(dbApi.countUsers(), 0, 'first run: the middleware lets an anonymous request through');
  assert.equal(await del('bystander'), 401);
  assert.equal(await del('%2e%2e'), 401);
  homeIntact();
});

test('`..` and `.` encoded in the path are a 400 and the home stays', async () => {
  for (const raw of ['%2e%2e', '%2E%2E', '%2e', '..%2f..', '%2e%2e%5c']) {
    assert.equal(await del(raw, TOKEN), 400, raw);
    homeIntact();
  }
});

test('a legitimate dotted name is still deleted', async () => {
  seed('foo.bar');
  assert.equal(await del('foo.bar', TOKEN), 200);
  assert.equal(existsSync(agentDir('foo.bar')), false);
  homeIntact();
});
