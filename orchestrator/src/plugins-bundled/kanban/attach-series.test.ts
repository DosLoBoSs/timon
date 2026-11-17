/**
 * TODO #1013 — a chain created outside a mission (a `curl` with the
 * daemon-token, a board click) has no series: its returns reach no pilot and its
 * reviews ignore the series' roles. `POST /api/tasks/:id/attach-series` attaches
 * the root and every follow-up below it, with the series' current pilot.
 */
import '../../test-home.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import express from 'express';
import { db, dbApi, type TaskType } from '../../db.js';
import { registerRoutes } from './routes.js';
await import('../../../tests/helpers/claude-provider.js');

const OWNER = randomUUID();
const STRANGER = randomUUID();
const ACTORS: Record<string, { actor: string; permissions: string[] }> = {
  writer: { actor: OWNER, permissions: ['kanban:read', 'kanban:write'] },
  reader: { actor: OWNER, permissions: ['kanban:read'] },
  stranger: { actor: STRANGER, permissions: ['kanban:read', 'kanban:write'] },
};

const app = express();
app.use((req, _res, next) => {
  const who = ACTORS[req.header('x-test-as') ?? ''];
  if (who) req.auth = { kind: 'api-token', isSuperadmin: false, actorId: who.actor, permissions: who.permissions };
  next();
});
app.use(express.json());
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function attach(id: string, as: string | null, body: unknown, mission?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (as) headers['x-test-as'] = as;
  if (mission) headers['X-TIMON-Mission'] = mission;
  return fetch(`${base}/api/tasks/${id}/attach-series`, { method: 'POST', headers, body: JSON.stringify(body) });
}

function pilot(owner = OWNER): string {
  const id = randomUUID();
  dbApi.createMission(id, 'p.main', 'plan the night', undefined, owner);
  return id;
}

/** A series piloted by a fresh mission: one task created from inside it. */
function series(owner = OWNER): string {
  const p = pilot(owner);
  dbApi.createTask(randomUUID(), 'planned', 'witness', { type: 'code', creatorMissionId: p, ownerUserId: owner });
  return p;
}

function task(type: TaskType, opts: { deps?: string[]; parent?: string; root?: string } = {}): string {
  const id = randomUUID();
  dbApi.createTask(id, `${type} witness`, 'witness', {
    type, ownerUserId: OWNER, deps: opts.deps, parentTaskId: opts.parent ?? null,
  });
  if (opts.root) dbApi.setTaskVerificationMeta(id, 2, opts.root);
  return id;
}

/** code → review → merge → doc, a repair iteration, and a doc on a review created by hand (deps only). */
function orphanChain() {
  const root = task('code');
  const review = task('review', { deps: [root], parent: root, root });
  const iteration = task('code', { parent: review, root });
  const merge = task('merge', { deps: [review], parent: review });
  const doc = task('doc', { deps: [merge], parent: merge });
  const handReview = task('review', { deps: [iteration] });
  // Depends on the root, but is its own work: never part of the chain.
  const next = task('code', { deps: [root] });
  return { root, review, iteration, merge, doc, handReview, next };
}

function lineage(ids: string[]) {
  return ids.map((id) => {
    const t = dbApi.getTask(id);
    return { series: t?.series_id ?? null, pilot: t?.creator_mission_id ?? null };
  });
}

test('anonymous 401, kanban:read alone 403, nothing written', async () => {
  const s = series();
  const { root } = orphanChain();
  assert.equal((await attach(root, null, { series: s })).status, 401);
  const r = await attach(root, 'reader', { series: s });
  assert.equal(r.status, 403);
  assert.equal(((await r.json()) as { permission?: string }).permission, 'kanban:write');
  assert.deepEqual(lineage([root]), [{ series: null, pilot: null }]);
});

test('attaches the root and every follow-up, from any task of the chain', async () => {
  const s = series();
  const c = orphanChain();
  const r = await attach(c.merge, 'writer', { series: s });
  assert.equal(r.status, 200);
  const json = (await r.json()) as { series_id: string; pilot_mission_id: string; attached: string[] };
  assert.equal(json.series_id, s);
  assert.equal(json.pilot_mission_id, s);
  const chain = [c.root, c.review, c.iteration, c.merge, c.doc, c.handReview];
  assert.deepEqual(new Set(json.attached), new Set(chain));
  assert.deepEqual(lineage(chain), chain.map(() => ({ series: s, pilot: s })));
  assert.deepEqual(lineage([c.next]), [{ series: null, pilot: null }]);
});

test('the pilot stored is the one piloting the series now', async () => {
  const s = series();
  const relay = pilot();
  dbApi.remapSeriesOrchestratorMission(s, s, relay);
  const { root, review } = orphanChain();
  // Named by its current pilot or by its id, the series is the same.
  const r = await attach(root, 'writer', { series: relay });
  assert.equal(r.status, 200);
  assert.deepEqual(lineage([root, review]), [{ series: s, pilot: relay }, { series: s, pilot: relay }]);
});

test('"current" is the caller\'s mission, and a mission with no task yet starts its series', async () => {
  const fresh = pilot();
  const { root, review } = orphanChain();
  const r = await attach(root, 'writer', { series: 'current' }, fresh);
  assert.equal(r.status, 200);
  assert.deepEqual(lineage([root, review]), [{ series: fresh, pilot: fresh }, { series: fresh, pilot: fresh }]);
  const none = await attach(root, 'writer', { series: 'current' });
  assert.equal(none.status, 400);
});

test('a series that does not exist is refused and nothing is written', async () => {
  const { root, review } = orphanChain();
  const r = await attach(root, 'writer', { series: randomUUID() });
  assert.equal(r.status, 404);
  assert.equal(((await r.json()) as { code: string }).code, 'series_not_found');
  assert.deepEqual(lineage([root, review]), [{ series: null, pilot: null }, { series: null, pilot: null }]);
});

test('someone else\'s series answers like a missing one, someone else\'s task 404', async () => {
  const theirs = series(STRANGER);
  const { root } = orphanChain();
  const r = await attach(root, 'writer', { series: theirs });
  assert.equal(r.status, 404);
  assert.equal(((await r.json()) as { code: string }).code, 'series_not_found');
  const mine = series();
  assert.equal((await attach(root, 'stranger', { series: mine })).status, 404);
  assert.deepEqual(lineage([root]), [{ series: null, pilot: null }]);
});

test('a mission running a task is no pilot', async () => {
  const worker = pilot();
  db.prepare('UPDATE missions SET task_id = ? WHERE id = ?').run(task('code'), worker);
  const { root } = orphanChain();
  const r = await attach(root, 'writer', { series: worker });
  assert.equal(r.status, 400);
  assert.equal(((await r.json()) as { code: string }).code, 'series_pilot_is_task');
  assert.deepEqual(lineage([root]), [{ series: null, pilot: null }]);
});

test('a malformed body or series is a 400', async () => {
  const s = series();
  const { root } = orphanChain();
  assert.equal((await attach(root, 'writer', {})).status, 400);
  assert.equal((await attach(root, 'writer', { series: 'a/b' })).status, 400);
  const stray = await attach(root, 'writer', { series: s, pilot: 'x' });
  assert.equal(stray.status, 400);
  assert.equal(((await stray.json()) as { code: string }).code, 'task_body_invalid');
});
