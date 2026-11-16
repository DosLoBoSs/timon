/**
 * A working directory that is gone stops a launch with its own reason (TIM-0148).
 *
 * The tester's case: two agents whose project folders vanished in a server
 * migration. Node reported each folder as `spawn <binary> ENOENT`, the thread
 * blamed an installed CLI, the mission died as a `crash`, the dispatcher
 * replayed it ("retry 1/3 in 120 s") and a fallback moved it to another backend
 * that failed the same way. Asserted here: the launch is refused before any
 * process, the notice names the folder, the task is blocked for a person, and
 * no backend switch or requeue follows. A binary that is really missing keeps
 * its own cause (`spawn-failed-visible.test.ts`).
 *
 * Fake host, stand-in CLIs, throwaway TIMON_HOME.
 */
import '../tests/helpers/no-load-gate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-cwd-missing-test-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
process.env.TIMON_FALLBACK_ENABLED = '1';

const { db, dbApi } = await import('./db.js');
import type { MissionRow } from './db.js';
const { mountOfficialProviders, stubCliBinaries } = await import('../tests/helpers/official-providers.js');
await stubCliBinaries('claude', 'codex');
await mountOfficialProviders();
const { getHost } = await import('./host/index.js');
const { spawnAgent, upsertAgent } = await import('./agent.js');
const { assertUsableCwd, CwdUnusableError } = await import('./cwd-check.js');
const { clearBackendCooldown, noteBackendRateLimit } = await import('./backend-fallback.js');
const { lastMissionError, startDispatcher } = await import('./dispatcher.js');
const { launchErrorStatus, missionLaunchErrorBody } = await import('./resources.js');

const root = mkdtempSync(join(tmpdir(), 'timon-cwd-missing-'));
const gone = join(root, 'projects', 'project-a');

function missionsOf(agent: string): MissionRow[] {
  return db.prepare(`SELECT * FROM missions WHERE agent_name = ? ORDER BY started_at`).all(agent) as MissionRow[];
}

function agentIn(name: string, cwd: string): void {
  upsertAgent({
    name,
    system_prompt: 'cwd witness — does nothing.',
    config: { backend: 'claude', cwd, skills: [], mcp_servers: [], memory_scope: 'NONE' },
  });
}

/** Counts the processes the host is asked for while `run` runs. */
async function spawnsDuring<T>(run: () => Promise<T>): Promise<{ result: T | Error; spawns: number }> {
  const host = getHost();
  const original = host.spawn;
  let spawns = 0;
  host.spawn = ((...args: Parameters<typeof host.spawn>) => {
    spawns++;
    return original(...args);
  }) as typeof host.spawn;
  try {
    return { result: await run(), spawns };
  } catch (err) {
    return { result: err as Error, spawns };
  } finally {
    host.spawn = original;
  }
}

test('a missing working directory refuses the launch and names the folder', async () => {
  agentIn('cwd-gone', gone);
  const { result, spawns } = await spawnsDuring(() => spawnAgent('cwd-gone', 'ping'));

  assert.ok(result instanceof CwdUnusableError, `expected CwdUnusableError, got ${String(result)}`);
  assert.equal(result.message, `working directory not found: ${gone}`);
  assert.doesNotMatch(result.message, /spawn \S+ ENOENT/);
  assert.equal(spawns, 0, 'no process is started for a folder that is gone');

  const [mission] = missionsOf('cwd-gone');
  assert.ok(mission);
  assert.equal(mission.status, 'failed');
  assert.notEqual(mission.interrupted_reason, 'crash');
  const events = dbApi.listEvents(mission.id);
  assert.deepEqual(events.map((e) => e.type), ['spawn_failed']);
  const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
  assert.equal(payload.cause, 'cwd_missing');
  assert.equal(payload.cwd, gone);
  assert.equal(payload.backend, 'claude');
  assert.equal(payload.binary, null);
  assert.equal(lastMissionError(mission.id), `the working directory ${gone} could not be used (cwd_missing).`);
});

test('the folder is checked before the quota guard: a gone folder never reads as a dry backend', async () => {
  agentIn('cwd-gone-dry', gone);
  noteBackendRateLimit('claude', { kind: 'rate_limit', window: 'five_hour', resetsAt: Date.now() + 3_600_000, source: 'event', pending: false });
  try {
    const { result } = await spawnsDuring(() => spawnAgent('cwd-gone-dry', 'ping'));
    assert.ok(result instanceof CwdUnusableError, `expected CwdUnusableError, got ${String(result)}`);
  } finally {
    clearBackendCooldown('claude');
  }
});

test('the dispatcher blocks the task with the folder, with no requeue and no fallback', async () => {
  agentIn('cwd-gone-task', gone);
  const taskId = randomUUID();
  dbApi.createTask(taskId, 'review the night', 'cwd-gone-task', {
    type: 'chore', backendOverride: 'claude', fallbackBackendOverride: 'codex',
  });

  const stop = startDispatcher(30);
  try {
    for (let i = 0; i < 100 && dbApi.getTask(taskId)?.status !== 'BLOCKED'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // A few more ticks: a requeue or a retry would show now.
    await new Promise((resolve) => setTimeout(resolve, 150));
  } finally {
    stop();
  }

  const task = dbApi.getTask(taskId);
  assert.equal(task?.status, 'BLOCKED');
  assert.equal(task?.interrupted_reason, null, 'not a system death: nothing replays it');
  assert.equal(task?.requeue_count ?? 0, 0);
  assert.equal(task?.scheduled_at ?? null, null);
  assert.equal(task?.mission_id, null);
  assert.equal(task?.backend_override, 'claude', 'no switch to the fallback backend');
  assert.match(task?.blocked_reason ?? '', /^Working directory not found: /);
  assert.ok(task?.blocked_reason?.includes(gone));
  // Every attempt was refused before a process: one mission, one notice, no codex.
  const missions = missionsOf('cwd-gone-task');
  assert.equal(missions.length, 1);
  assert.ok(missions.every((m) => m.backend_override !== 'codex'));
});

test('the reasons a folder cannot be used keep their errno', () => {
  const file = join(root, 'a-file');
  writeFileSync(file, '');
  assert.throws(() => assertUsableCwd(file), (err: unknown) =>
    err instanceof CwdUnusableError && err.error === 'not-a-directory'
    && err.message === `working directory is not a directory: ${file}`);
  const denied = (): Stats => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
  assert.throws(() => assertUsableCwd('/protected', denied), (err: unknown) =>
    err instanceof CwdUnusableError && err.error === 'denied' && err.code === 'EPERM'
    && err.message === 'working directory access denied (EPERM): /protected');
  assert.doesNotThrow(() => assertUsableCwd(root));
});

test('a route answers 409 with a code the webview translates', () => {
  const err = new CwdUnusableError(gone, 'missing', 'ENOENT');
  assert.equal(launchErrorStatus(err, 500), 409);
  assert.deepEqual(missionLaunchErrorBody(err), {
    error: `working directory not found: ${gone}`, code: 'cwd_unusable', params: { path: gone },
  });
});
