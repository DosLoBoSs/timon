/**
 * TODO #877 — `PATCH /api/agents/:name/config` takes `reasoningEffort`,
 * checked against the levels of the model the agent runs on. Isolated
 * TIMON_HOME, witness on 127.0.0.1:0.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-agent-effort-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
await import('../../../tests/helpers/claude-provider.js');

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { agentDir } = await import('../../paths.js');
const { catalogBackend } = await import('../../backends/catalog.js');
const { reasoningEffortsFor } = await import('./reasoning-effort.js');

const TOKEN = 'witness-daemon-token';
const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

const AGENT = 'effort.agent';
mkdirSync(agentDir(AGENT), { recursive: true });
writeFileSync(join(agentDir(AGENT), 'config.json'), JSON.stringify({ cwd: process.env.TIMON_HOME, backend: 'claude', model: 'opus' }));
const stored = (): unknown => (JSON.parse(readFileSync(join(agentDir(AGENT), 'config.json'), 'utf8')) as { reasoningEffort?: unknown }).reasoningEffort;

async function patch(body: unknown, bearer: string | null = TOKEN): Promise<Response> {
  return fetch(`${base}/api/agents/${AGENT}/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
}

test('the claude catalogue of the witness lists levels for opus', () => {
  assert.ok(catalogBackend('claude'), 'claude must be active in the witness');
  assert.ok(reasoningEffortsFor('claude', 'opus').includes('high'));
});

test('an anonymous request is refused and writes nothing', async () => {
  const res = await patch({ reasoningEffort: 'high' }, null);
  assert.equal(res.status, 401);
  assert.equal(stored(), undefined);
});

test('a level of the model is stored', async () => {
  const res = await patch({ reasoningEffort: 'high' });
  assert.equal(res.status, 200);
  assert.equal(stored(), 'high');
});

test('a level the model does not know is refused and keeps the stored one', async () => {
  const res = await patch({ reasoningEffort: 'ludicrous' });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /reasoningEffort must be one of/);
  assert.equal(stored(), 'high');
});

test('a non-string value is refused', async () => {
  assert.equal((await patch({ reasoningEffort: 3 })).status, 400);
  assert.equal(stored(), 'high');
});

test('the level is checked against the model sent in the same patch', async () => {
  const res = await patch({ model: 'no-such-model', reasoningEffort: 'high' });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /cannot be set/);
  assert.equal(stored(), 'high');
});

test('null or an empty string clears it, back to the model default', async () => {
  assert.equal((await patch({ reasoningEffort: '' })).status, 200);
  assert.equal(stored(), null);
  assert.equal((await patch({ reasoningEffort: 'low' })).status, 200);
  assert.equal((await patch({ reasoningEffort: null })).status, 200);
  assert.equal(stored(), null);
});
