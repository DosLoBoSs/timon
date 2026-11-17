/**
 * TIM-0149 follow-up — at boot, a task a recent system death left BLOCKED is
 * sent back to PENDING, within bounds: a replayable cause, blocked for less
 * than a day, and under the crash-loop ceiling, without resetting its count.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { db, dbApi, MAX_SYSTEM_REQUEUES, CRASH_LOOP_HARD_CEILING } = await import('./db.js');
const { requeueRecentSystemDeaths, handleTaskBlocked, BOOT_REQUEUE_MAX_AGE_MS } = await import('./wake.js');
type InterruptionReason = import('./interruption.js').InterruptionReason;

/** No agent of that name exists: a wake flush only expires its mail, it never spawns. */
const PILOT = 'boot-requeue-pilot';

/** A task whose missions died `deaths` times of `reason`, ending BLOCKED. Each
 *  death is a mission of PILOT's that ended, the last one left attached. */
function deadTask(title: string, deaths: number, reason: InterruptionReason = 'killed'): string {
  const id = randomUUID();
  dbApi.createTask(id, title, 'boot-requeue-worker', { type: 'review' });
  for (let i = 0; i < deaths; i++) {
    // A task already BLOCKED by its cap only dies again once someone replays it.
    if (dbApi.getTask(id)?.status === 'BLOCKED') dbApi.updateTaskStatus(id, 'PENDING');
    const missionId = randomUUID();
    dbApi.createMission(missionId, 'boot-requeue-worker', title);
    dbApi.setMissionLineage(missionId, { parentAgent: PILOT, taskId: id });
    dbApi.assignTaskMission(id, missionId);
    dbApi.finishMission(missionId, 'terminated', null);
    dbApi.setTaskInterrupted(id, reason, `mission ${reason}`);
  }
  const t = dbApi.getTask(id);
  assert.equal(t?.status, 'BLOCKED');
  assert.equal(t?.requeue_count, deaths);
  return id;
}

test('a recent replayable death is requeued once, its count kept', () => {
  const id = deadTask('review: killed at reboot', MAX_SYSTEM_REQUEUES + 1);
  const now = Date.now();

  requeueRecentSystemDeaths(now);
  const t = dbApi.getTask(id);
  assert.equal(t?.status, 'PENDING');
  assert.equal(t?.requeue_count, MAX_SYSTEM_REQUEUES + 1, 'the death count is never reset');
  assert.equal(t?.blocked_reason, null);
  assert.ok((t?.scheduled_at ?? 0) > now, 'it waits out the requeue backoff');

  // A second boot finds it PENDING: nothing more to replay.
  const before = dbApi.getTask(id)?.updated_at;
  requeueRecentSystemDeaths(now);
  assert.equal(dbApi.getTask(id)?.updated_at, before);
});

test('a task blocked for more than a day stays BLOCKED', () => {
  const id = deadTask('review: killed long ago', MAX_SYSTEM_REQUEUES + 1);
  const blockedAt = dbApi.getTask(id)!.updated_at;

  requeueRecentSystemDeaths(blockedAt + 25 * 60 * 60_000);
  assert.equal(dbApi.getTask(id)?.status, 'BLOCKED');
  requeueRecentSystemDeaths(blockedAt + BOOT_REQUEUE_MAX_AGE_MS);
  assert.equal(dbApi.getTask(id)?.status, 'BLOCKED', 'the day is an exclusive bound');
});

test('a task at the crash-loop ceiling stays BLOCKED: only a human restarts it', () => {
  const id = deadTask('review: dies every time', CRASH_LOOP_HARD_CEILING);

  requeueRecentSystemDeaths();
  const t = dbApi.getTask(id);
  assert.equal(t?.status, 'BLOCKED');
  assert.equal(t?.requeue_count, CRASH_LOOP_HARD_CEILING);
});

test('one death below the ceiling still gets its last boot replay', () => {
  const id = deadTask('review: one replay left', CRASH_LOOP_HARD_CEILING - 1);
  requeueRecentSystemDeaths();
  assert.equal(dbApi.getTask(id)?.status, 'PENDING');
});

test('a cause a restart does not cure is left to the pilot', () => {
  const id = deadTask('review: denied', 1, 'permission_denied');
  requeueRecentSystemDeaths();
  assert.equal(dbApi.getTask(id)?.status, 'BLOCKED');
});

test('a business block is never replayed', () => {
  const id = randomUUID();
  dbApi.createTask(id, 'review: agent gave up', 'boot-requeue-worker', { type: 'review' });
  dbApi.updateTaskStatus(id, 'BLOCKED', { blockedReason: 'API key missing' });
  requeueRecentSystemDeaths();
  assert.equal(dbApi.getTask(id)?.status, 'BLOCKED');
});

test('a task that died more than a day ago stays BLOCKED even if edited since', () => {
  const id = deadTask('review: killed long ago, retitled today', MAX_SYSTEM_REQUEUES + 1);
  const missionId = dbApi.getTask(id)!.mission_id!;
  db.prepare('UPDATE missions SET ended_at = ? WHERE id = ?').run(Date.now() - 25 * 60 * 60_000, missionId);
  dbApi.updateTask(id, { title: 'review: retitled today' });

  requeueRecentSystemDeaths();
  assert.equal(dbApi.getTask(id)?.status, 'BLOCKED', 'the death is old, the edit is not a block');
});

test('an unread "Task blocked" recap of a requeued task is expired', () => {
  const id = deadTask('review: recap pending at reboot', MAX_SYSTEM_REQUEUES + 1);
  handleTaskBlocked(id, dbApi.getTask(id)!.blocked_reason);
  const recaps = () => dbApi.listInbox(PILOT, { limit: 200 }).filter((m) => {
    const p = JSON.parse(m.payload) as { kind?: string; task_id?: string };
    return p.kind === 'wake_recap' && p.task_id === id;
  });
  assert.equal(recaps().filter((m) => m.status === 'pending').length, 1);

  requeueRecentSystemDeaths();
  assert.equal(dbApi.getTask(id)?.status, 'PENDING');
  assert.deepEqual(recaps().map((m) => m.status), ['expired'], 'the pilot is not woken on a stale block');
});

test('a replay consumes the death: a person who blocks it before dispatch is not overruled', () => {
  const id = deadTask('review: replayed, then cancelled by hand', MAX_SYSTEM_REQUEUES + 1);
  const now = Date.now();

  requeueRecentSystemDeaths(now);
  let t = dbApi.getTask(id);
  assert.equal(t?.status, 'PENDING');
  assert.equal(t?.interrupted_reason, null, 'the cause of the replayed death is cleared');
  assert.equal(t?.mission_id, null, 'the dead mission is detached');

  // Still waiting out its backoff, the task is blocked from the board.
  dbApi.updateTaskStatus(id, 'BLOCKED', { blockedReason: 'do not relaunch', byPerson: true });
  requeueRecentSystemDeaths(now + 60_000);
  t = dbApi.getTask(id);
  assert.equal(t?.status, 'BLOCKED', 'the next boot leaves the human decision alone');
  assert.equal(t?.blocked_reason, 'do not relaunch');
});

test('a replayed task that dies again is still counted and bounded by the ceiling', () => {
  const id = deadTask('review: replayed, dies again', CRASH_LOOP_HARD_CEILING - 1);
  requeueRecentSystemDeaths();
  assert.equal(dbApi.getTask(id)?.status, 'PENDING');

  const missionId = randomUUID();
  dbApi.createMission(missionId, 'boot-requeue-worker', 'review: replayed, dies again');
  dbApi.setMissionLineage(missionId, { parentAgent: PILOT, taskId: id });
  dbApi.assignTaskMission(id, missionId);
  dbApi.finishMission(missionId, 'terminated', null);
  dbApi.setTaskInterrupted(id, 'killed', 'mission killed');
  const t = dbApi.getTask(id);
  assert.equal(t?.status, 'BLOCKED');
  assert.equal(t?.interrupted_reason, 'killed');
  assert.equal(t?.requeue_count, CRASH_LOOP_HARD_CEILING);

  requeueRecentSystemDeaths();
  assert.equal(dbApi.getTask(id)?.status, 'BLOCKED', 'at the ceiling only a human restarts it');
});
