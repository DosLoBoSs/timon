/**
 * TIM-0149 follow-up — at boot, a task a recent system death left BLOCKED is
 * sent back to PENDING, within bounds: a replayable cause, blocked for less
 * than a day, and under the crash-loop ceiling, without resetting its count.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { dbApi, MAX_SYSTEM_REQUEUES, CRASH_LOOP_HARD_CEILING } = await import('./db.js');
const { requeueRecentSystemDeaths, BOOT_REQUEUE_MAX_AGE_MS } = await import('./wake.js');
type InterruptionReason = import('./interruption.js').InterruptionReason;

/** A task whose missions died `deaths` times of `reason`, ending BLOCKED. */
function deadTask(title: string, deaths: number, reason: InterruptionReason = 'killed'): string {
  const id = randomUUID();
  dbApi.createTask(id, title, 'boot-requeue-worker', { type: 'review' });
  for (let i = 0; i < deaths; i++) {
    // A task already BLOCKED by its cap only dies again once someone replays it.
    if (dbApi.getTask(id)?.status === 'BLOCKED') dbApi.updateTaskStatus(id, 'PENDING');
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
