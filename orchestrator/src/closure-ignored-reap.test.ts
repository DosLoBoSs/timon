/**
 * TIM-0149: a task mission that ends a clean turn, ignores both closure
 * questions, then is reaped idle has finished its work. Its task closes
 * (verdict `unknown` for a review, which escalates) instead of being replayed
 * as a system death; every other death keeps the system-death path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-closure-ignored-test-'));

const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');
const { watchMissionComplete, reconcileOrphanedTasks } = await import('./dispatcher.js');
const { askUnclosedTaskMission, handleTurnStarted } = await import('./wake.js');
const { parseReviewVerdict, runVerificationChain } = await import('./verification-loop.js');

const delivered = async (): Promise<string> => 'delivered';

function reviewMission(): { taskId: string; missionId: string } {
  const rootId = randomUUID();
  const taskId = randomUUID();
  const missionId = randomUUID();
  dbApi.createTask(rootId, 'feature', 'p.coder', { type: 'code' });
  dbApi.createTask(taskId, 'review feature', 'p.reviewer', { type: 'review' });
  dbApi.setTaskVerificationMeta(taskId, 1, rootId);
  dbApi.createMission(missionId, 'p.reviewer', 'review', { channel: 'dispatcher' });
  dbApi.setMissionLineage(missionId, { taskId });
  dbApi.assignTaskMission(taskId, missionId);
  return { taskId, missionId };
}

/** Each call stands for a clean `turn_complete` with the task still open. */
async function cleanTurnsEnd(missionId: string, turns: number, send = delivered): Promise<void> {
  for (let i = 0; i < turns; i++) await askUnclosedTaskMission(missionId, send);
}

function reapedIdle(missionId: string): void {
  const reason = dbApi.finishMission(missionId, 'terminated', 0, 'killed');
  bus.publish({ kind: 'mission_complete', missionId, status: 'terminated', exitCode: 0, reason });
}

test('a clean turn after two ignored questions, then an idle reap: DONE, verdict unknown, escalated', async () => {
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId } = reviewMission();
    // Turn 1 ends → question 1; turn 2 ends → question 2; turn 3 ends: ignored.
    await cleanTurnsEnd(missionId, 3);
    assert.equal(dbApi.getMission(missionId)?.closure_ignored, 1);
    reapedIdle(missionId);
    const task = dbApi.getTask(taskId);
    assert.equal(task?.status, 'DONE');
    assert.match(task?.done_comment ?? '', /auto-closed by the orchestrator/);
    assert.equal(parseReviewVerdict(task?.done_comment ?? null).verdict, 'unknown');
    assert.equal(task?.requeue_count, 0);
    assert.equal(task?.interrupted_reason, null);
    // The existing unknown-verdict path escalates it: never a fabricated pass.
    if (task) await runVerificationChain(task);
    const escalated = dbApi.getTask(taskId);
    assert.equal(escalated?.status, 'BLOCKED');
    assert.match(escalated?.blocked_reason ?? '', /verdict not parsable/);
    assert.equal(dbApi.listTasks().some((t) => t.type === 'merge' && t.verification_root_id === task?.verification_root_id), false);
  } finally { stop(); }
});

test('a turn started after the ignored questions: the reap stays a system death', async () => {
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId } = reviewMission();
    await cleanTurnsEnd(missionId, 3);
    // A new turn began and never ended cleanly before the process was killed.
    handleTurnStarted(missionId);
    assert.equal(dbApi.getMission(missionId)?.closure_ignored, 0);
    reapedIdle(missionId);
    const task = dbApi.getTask(taskId);
    // Replayed as a system death: requeued, and the death counted.
    assert.equal(task?.status, 'PENDING');
    assert.equal(task?.requeue_count, 1);
  } finally { stop(); }
});

test('a turn cut short (hung) after the ignored questions stays a system death', async () => {
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId } = reviewMission();
    await cleanTurnsEnd(missionId, 3);
    const reason = dbApi.finishMission(missionId, 'failed', 1, 'timeout');
    bus.publish({ kind: 'mission_complete', missionId, status: 'failed', exitCode: 1, reason });
    const task = dbApi.getTask(taskId);
    assert.equal(task?.status, 'PENDING');
    assert.equal(task?.requeue_count, 1);
  } finally { stop(); }
});

test('a single question asked: the idle reap is unchanged', async () => {
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId } = reviewMission();
    await cleanTurnsEnd(missionId, 1);
    assert.equal(dbApi.getMission(missionId)?.closure_ignored, 0);
    reapedIdle(missionId);
    const task = dbApi.getTask(taskId);
    // Replayed as a system death: requeued, and the death counted.
    assert.equal(task?.status, 'PENDING');
    assert.equal(task?.requeue_count, 1);
  } finally { stop(); }
});

test('questions that never reached the agent were not ignored', async () => {
  const { missionId } = reviewMission();
  await cleanTurnsEnd(missionId, 3, async () => 'queued');
  assert.equal(dbApi.getMission(missionId)?.closure_ignored, 0);
});

test('reconciliation at boot reads the mark the same way', async () => {
  const { taskId, missionId } = reviewMission();
  await cleanTurnsEnd(missionId, 3);
  // The daemon stopped before the mission_complete event was handled.
  dbApi.finishMission(missionId, 'terminated', 0, 'killed');
  await reconcileOrphanedTasks();
  const task = dbApi.getTask(taskId);
  assert.equal(task?.status, 'DONE');
  assert.equal(parseReviewVerdict(task?.done_comment ?? null).verdict, 'unknown');
  assert.equal(task?.requeue_count, 0);
});
