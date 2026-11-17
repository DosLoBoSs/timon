/**
 * TODO #1060: a draft test run freezes the draft under its own version number
 * and leaves `published_version` alone. Only a publish moves it, and the
 * published runs that follow a draft run keep reading the published version.
 */
import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';
import type { RequestAuth } from '../users/identity.js';

const { dbApi } = await import('../db.js');
const { agentDir } = await import('../paths.js');
const { advance, createRun } = await import('./engine.js');
const { pinWorkflowScripts } = await import('./nodes/script.js');
const { registerRoutes } = await import('../plugins-bundled/workflows/routes.js');

const scripter = createTestAccount(dbApi, { email: `scripter-${randomUUID()}@example.test`, name: 'scripter', passwordHash: 'unused' });
grantTestPermissions(dbApi, scripter.id, ['scripts:run']);
const person = dbApi.getUserById(scripter.id)!;

const PILOT = 'draft-run-pilot';
mkdirSync(agentDir(PILOT), { recursive: true });
const markers = mkdtempSync(join(tmpdir(), 'timon-draft-run-'));

type Node = { id: string; type: string; position?: { x: number; y: number }; config: Record<string, unknown> };
function definition(nodes: Node[]) {
  return {
    schemaVersion: 1,
    nodes: [{ id: 'manual', type: 'trigger.manual', config: {} }, ...nodes],
    edges: nodes.map((node) => ({ id: `e-${node.id}`, from: 'manual', fromPort: 'out', to: node.id, toPort: 'in' })),
    variables: [], settings: {},
  };
}
const output = (text: string): Node => ({ id: 'out', type: 'output', position: { x: 0, y: 0 }, config: { template: text } });
/** A script node whose only effect is to leave a file behind: proof a process ran. */
const scriptNode = (marker: string): Node => ({ id: 'job', type: 'script', position: { x: 0, y: 0 }, config: { bin: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] } });

/** A workflow published once (version 1) whose draft holds `draft`. */
function seed(published: unknown, draft: unknown, owner: string | null = null) {
  const id = randomUUID(); const now = Date.now();
  dbApi.insertWorkflow({ id, slug: `draft-${id.slice(0, 8)}`, name: 'Draft witness', description: null, project: null, owner_user_id: owner, draft: JSON.stringify(draft), published_version: null, enabled: 1, created_at: now, updated_at: now, agent_name: PILOT });
  dbApi.insertWorkflowVersion({ workflow_id: id, version: 1, definition: JSON.stringify(published), published_at: now, published_by: owner });
  return id;
}

async function settle(runId: string) {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const row = dbApi.getWorkflowRun(runId)!;
    if (!['pending', 'running', 'waiting'].includes(row.status)) return row;
    assert.ok(performance.now() < deadline, `run did not settle (status: ${row.status})`);
    await advance(runId);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const nodeOf = (runId: string, nodeId: string) => dbApi.listWorkflowRunNodes(runId).find((row) => row.node_id === nodeId)!;

const IDENTITIES: Record<string, RequestAuth> = { scripter: { kind: 'session', user: person, isSuperadmin: false } };
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.auth = IDENTITIES[req.header('x-test-as') ?? 'scripter']; next(); });
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'x-test-as': 'scripter', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() as { error?: string; version?: number } };
}

test('a draft run leaves the published version in place for the runs that follow', async () => {
  const id = seed(definition([output('published')]), definition([output('draft')]));

  const draftRun = createRun(id, { trigger: { kind: 'manual' }, draft: true });
  assert.equal(dbApi.getWorkflow(id)!.published_version, 1, 'a draft run publishes nothing');
  assert.equal(draftRun.version, 2, 'the draft is frozen under its own number');
  assert.equal((JSON.parse(dbApi.getWorkflowVersion(id, 2)!.definition) as { draft?: boolean }).draft, true);
  await settle(draftRun.id);
  assert.equal(nodeOf(draftRun.id, 'out').output, JSON.stringify('draft'));

  const second = createRun(id, { trigger: { kind: 'manual' }, draft: true });
  assert.equal(second.version, 3, 'a second draft run takes the next free number');
  assert.equal(dbApi.getWorkflow(id)!.published_version, 1);

  const published = createRun(id, { trigger: { kind: 'manual' } });
  assert.equal(published.version, 1);
  await settle(published.id);
  assert.equal(nodeOf(published.id, 'out').output, JSON.stringify('published'));
});

test('publishing after draft runs takes a fresh number and moves the published version', async () => {
  const id = seed(definition([output('published')]), definition([output('draft')]), person.id);
  assert.equal((await call('POST', `/api/workflows/${id}/run`, { draft: true })).status, 201);
  assert.equal(dbApi.getWorkflow(id)!.published_version, 1);

  const published = await call('POST', `/api/workflows/${id}/publish`);
  assert.equal(published.status, 200, published.body.error);
  assert.equal(published.body.version, 3, 'past the draft run version, which stays untouched');
  assert.equal(dbApi.getWorkflow(id)!.published_version, 3);
  assert.equal((JSON.parse(dbApi.getWorkflowVersion(id, 2)!.definition) as { draft?: boolean }).draft, true);

  const run = createRun(id, { trigger: { kind: 'manual' } });
  assert.equal(run.version, 3);
  await settle(run.id);
  assert.equal(nodeOf(run.id, 'out').output, JSON.stringify('draft'));
});

test('a draft run of an unapproved script is refused and the published script keeps running', async () => {
  const publishedMarker = join(markers, 'published');
  const draftMarker = join(markers, 'draft');
  const publishedDef = definition([scriptNode(publishedMarker)]);
  const draftDef = definition([scriptNode(draftMarker)]);
  const id = seed(publishedDef, publishedDef, person.id);
  // The published script is approved; the draft is written behind the
  // approval's back, as nothing a person saved approved it.
  pinWorkflowScripts(dbApi.getWorkflow(id)!, { strict: publishedDef.nodes });
  dbApi.updateWorkflow(id, { draft: JSON.stringify(draftDef) });

  // `createRun` straight: the route's run is supervised by a pilot no test
  // backend can start; the script check sits in the engine either way.
  const refused = await settle(createRun(id, { trigger: { kind: 'manual' }, draft: true }).id);
  assert.equal(refused.status, 'failed');
  assert.match(nodeOf(refused.id, 'job').error ?? '', /not approved/);
  assert.equal(existsSync(draftMarker), false, 'the unapproved draft script never ran');
  assert.equal(dbApi.getWorkflow(id)!.published_version, 1);

  const publishedRun = createRun(id, { trigger: { kind: 'manual' } });
  assert.equal(publishedRun.version, 1);
  assert.equal((await settle(publishedRun.id)).status, 'completed');
  assert.equal(existsSync(publishedMarker), true);
  assert.equal(existsSync(draftMarker), false, 'the published run did not pick up the draft');
});
