/**
 * A BLOCKED task reaches its pilot once. Two paths re-sent it: the boot sweep
 * handed every BLOCKED task back at each start (three "Task blocked" for one
 * cancellation over a night of restarts), and a task a person blocked from the
 * board woke the pilot, which was then asked to undo their decision.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { RequestAuth } from './users/identity.js';

const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');
type BusEvent = import('./bus.js').BusEvent;
const { handleTaskBlocked, representBlockedTasks } = await import('./wake.js');
const { registerRoutes } = await import('./plugins-bundled/kanban/routes.js');

/** No agent of that name exists: a wake flush only expires its mail, it never spawns. */
const PILOT = 'blocked-once-pilot';

const admin = createTestAccount(dbApi, { email: 'blocked-once@example.com', name: 'Admin', passwordHash: 'x', isSuperadmin: true });
const IDENTITIES: Record<string, RequestAuth> = {
  person: { kind: 'session', user: admin, isSuperadmin: true },
  operator: { kind: 'daemon-token', user: null, isSuperadmin: true },
};

/** A task dispatched under PILOT, then blocked without going through the wake loop. */
function blockedTask(title: string): string {
  const taskId = randomUUID();
  const missionId = randomUUID();
  dbApi.createTask(taskId, title, 'worker', { type: 'code' });
  dbApi.createMission(missionId, 'worker', title);
  dbApi.setMissionLineage(missionId, { parentAgent: PILOT, taskId });
  dbApi.assignTaskMission(taskId, missionId);
  dbApi.updateTaskStatus(taskId, 'IN_PROGRESS');
  return taskId;
}

function recapsFor(taskId: string) {
  return dbApi.listInbox(PILOT, { limit: 200 })
    .filter((m) => {
      const p = JSON.parse(m.payload) as { kind?: string; task_id?: string };
      return p.kind === 'wake_recap' && p.task_id === taskId;
    });
}

async function withApi<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use((req, _res, next) => { req.auth = IDENTITIES[req.header('x-test-as') ?? 'operator']; next(); });
  app.use(express.json());
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try { return await fn(`http://127.0.0.1:${port}`); } finally { server.close(); }
}

/** Runs `fn` while the wake loop's `task_blocked` handler listens, as in the daemon. */
async function withWakeHandler<T>(fn: () => Promise<T>): Promise<T> {
  const onEvent = (ev: BusEvent) => {
    if (ev.kind === 'task_blocked') handleTaskBlocked(ev.taskId, ev.reason, { byPerson: ev.byPerson === true });
  };
  bus.on('event', onEvent);
  try { return await fn(); } finally { bus.off('event', onEvent); }
}

test('the boot sweep presents a BLOCKED task once, not at every restart', () => {
  const taskId = blockedTask('releases: cancelled');
  // Written behind the wake loop's back, as during a restart.
  dbApi.setTaskStatusOnly(taskId, 'BLOCKED');
  assert.equal(recapsFor(taskId).length, 0);

  representBlockedTasks();
  assert.equal(recapsFor(taskId).length, 1, 'never told: the first boot presents it');
  representBlockedTasks();
  representBlockedTasks();
  assert.equal(recapsFor(taskId).length, 1, 'two more restarts must not repeat it');
});

test('a recap that expired unread is presented again at the next boot', () => {
  const taskId = blockedTask('releases: recap lost');
  dbApi.setTaskStatusOnly(taskId, 'BLOCKED');
  representBlockedTasks();
  const [recap] = recapsFor(taskId);
  assert.ok(recap);
  dbApi.expirePendingMessages([recap.id]);

  representBlockedTasks();
  const recaps = recapsFor(taskId);
  assert.equal(recaps.length, 2, 'the pilot never read the first one');
  assert.equal(recaps.filter((m) => m.status === 'pending').length, 1);
});

test('a task a person blocks from the board does not wake the pilot, now or at boot', async () => {
  const taskId = blockedTask('releases: do not relaunch');
  await withWakeHandler(() => withApi(async (base) => {
    const r = await fetch(`${base}/api/tasks/${taskId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-as': 'person' },
      body: JSON.stringify({ status: 'BLOCKED', blocked_reason: 'cancelled, do not relaunch' }),
    });
    assert.equal(r.status, 200);
  }));
  assert.equal(dbApi.getTask(taskId)?.status, 'BLOCKED');
  assert.equal(recapsFor(taskId).length, 0, 'the decision is the person\'s: no recap');
  assert.equal(dbApi.isTaskReturnNotified(taskId), true, 'nor a return at the death of its mission');

  representBlockedTasks();
  assert.equal(recapsFor(taskId).length, 0, 'nor at the next boot');
});

test('a task blocked by an agent or the CLI still reaches the pilot, once', async () => {
  const taskId = blockedTask('releases: agent gave up');
  await withWakeHandler(() => withApi(async (base) => {
    const r = await fetch(`${base}/api/tasks/${taskId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-as': 'operator' },
      body: JSON.stringify({ status: 'BLOCKED', blocked_reason: 'API key missing' }),
    });
    assert.equal(r.status, 200);
  }));
  assert.equal(recapsFor(taskId).length, 1);

  representBlockedTasks();
  assert.equal(recapsFor(taskId).length, 1, 'already told when it blocked');
});
