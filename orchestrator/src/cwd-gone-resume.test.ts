/**
 * A working directory that is gone is no crash when a mission is resumed,
 * relaunched for its permission mode or restarted by a steer (TIM-0148).
 *
 * The first launch already refused such a folder without a cause
 * (`cwd-missing-launch.test.ts`). These three relaunches still wrote `crash`:
 * a task mission resumed on a vanished folder died as a system death, the
 * dispatcher replayed it once, and only that replay's first launch blocked it.
 * Asserted here: no process is started, the mission carries no `crash`, and
 * the reconciliation blocks its task for a person with no requeue.
 *
 * The folder is made unusable by pointing the agent at a path that does not
 * exist rather than by deleting the live process's folder, which Windows
 * refuses. Witness CLI, throwaway TIMON_HOME.
 */
import './test-home.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Dialect, NormalizedEvent } from './backends/types.js';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const { witnessCli } = await import('../tests/helpers/witness-cli.js');
const WITNESS_CLI = witnessCli(tmpdir());

const {
  spawnAgent, upsertAgent, sendToAgent, steerMission, respawnWithResume, killAgent, getTurnState,
} = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { CwdUnusableError } = await import('./cwd-check.js');
const { reconcileOrphanedTasks } = await import('./dispatcher.js');
const { registerDialect, registerProfile } = await import('./backends/registry.js');

/** Each launch the dialect was asked for. */
let launches = 0;

// Opens its session, answers the first message, then one `result` per stdin
// line — except `hold`, which leaves the turn running until the process dies.
const SCRIPT = `
const out = (e) => console.log(JSON.stringify(e));
const turn = () => out({ type: 'result', payload: { subtype: 'success', is_error: false, result: 'ok' } });
out({ type: 'system', payload: { subtype: 'init', session_id: 'cwd-gone-session' } });
if (process.env.CWD_GONE_HOLD !== '1') turn();
let buf = '';
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { buf = buf.slice(i + 1); turn(); } });
setInterval(() => {}, 1000);
`;

function dialectOf(persistentProcess: boolean, hold: boolean): Dialect {
  return {
    defaultCmd: WITNESS_CLI, persistentProcess, finishMissionOnExit: persistentProcess,
    sessionResumable: true, sessionStore: 'global', permissionModel: 'mcp-bridge', rateLimitReporting: 'none', hostedConnectors: false,
    async buildSpawn(opts) {
      launches++;
      return {
        cmd: WITNESS_CLI, args: ['-e', SCRIPT], cwd: opts.cfg.cwd, initialStdin: null,
        env: hold ? { CWD_GONE_HOLD: '1' } : {},
      };
    },
    writeUserInput(proc, text) { proc.stdin.write(`${text.replace(/\n/g, ' ')}\n`); },
    parseLine(line) { return [JSON.parse(line) as NormalizedEvent]; },
    extractSessionId(event) { const payload = event.payload as { session_id?: string }; return payload.session_id ?? null; },
  };
}

const OWNER = 'cwd-gone-resume-test';
const disposers = [
  registerDialect(OWNER, 'cwd-gone-persistent', dialectOf(true, false)),
  registerProfile(OWNER, {
    id: 'cwd-gone-persistent', dialect: 'cwd-gone-persistent', label: 'Persistent', vendor: 'Test', custom: true,
    defaultModel: 'witness', models: [{ slug: 'witness', label: 'Witness' }],
  }),
  // One-shot, no session protocol: a steer can only stop the turn and restart it.
  registerDialect(OWNER, 'cwd-gone-oneshot', dialectOf(false, true)),
  registerProfile(OWNER, {
    id: 'cwd-gone-oneshot', dialect: 'cwd-gone-oneshot', label: 'One-shot', vendor: 'Test', custom: true,
    defaultModel: 'witness', models: [{ slug: 'witness', label: 'Witness' }],
  }),
];

const missions: string[] = [];
after(() => {
  for (const id of missions) killAgent(id, { source: 'test' });
  for (const dispose of disposers.reverse()) dispose();
});

const usable = mkdtempSync(join(tmpdir(), 'timon-cwd-gone-resume-'));
const gone = join(usable, 'moved-away', 'project-a');

function agentIn(name: string, backend: string, cwd: string): void {
  upsertAgent({
    name,
    system_prompt: 'You are a witness.',
    config: { backend, cwd, skills: [], mcp_servers: [], memory_scope: 'NONE', permission_mode: 'default' },
  });
}

/** A task whose mission is `missionId`, as the dispatcher leaves it. */
function taskOn(agent: string, missionId: string): string {
  const taskId = randomUUID();
  dbApi.createTask(taskId, 'review the night', agent, { type: 'chore' });
  dbApi.assignTaskMission(taskId, missionId);
  return taskId;
}

/** The mission died without a system cause, and its task waits for a person. */
async function assertSurfacedNotReplayed(missionId: string, taskId: string): Promise<void> {
  const mission = dbApi.getMission(missionId);
  assert.equal(mission?.status, 'failed');
  assert.notEqual(mission?.interrupted_reason, 'crash', 'a folder that is gone is no system death');
  await reconcileOrphanedTasks(0);
  const task = dbApi.getTask(taskId);
  // A `crash` would have put it back in PENDING, on a backoff.
  assert.equal(task?.status, 'BLOCKED', 'nothing replays it');
  assert.equal(task?.interrupted_reason, 'unknown');
  assert.equal(task?.scheduled_at ?? null, null);
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('a resume on a folder that is gone starts nothing and is not replayed', async () => {
  const agent = 'cwd-gone-resume';
  agentIn(agent, 'cwd-gone-persistent', gone);
  const missionId = randomUUID();
  dbApi.createMission(missionId, agent, 'review the night');
  dbApi.setMissionSession(missionId, 'cwd-gone-session');
  dbApi.finishMission(missionId, 'failed', 1, 'killed');
  const taskId = taskOn(agent, missionId);
  const before = launches;

  await assert.rejects(respawnWithResume(missionId, 'Continue.'), (err: unknown) => err instanceof CwdUnusableError);
  assert.equal(launches, before, 'no process for a folder that is gone');
  await assertSurfacedNotReplayed(missionId, taskId);
});

test('a permission relaunch on a folder that is gone is not a crash', async () => {
  const agent = 'cwd-gone-permission';
  agentIn(agent, 'cwd-gone-persistent', usable);
  const missionId = await spawnAgent(agent, 'hello');
  missions.push(missionId);
  await until(() => dbApi.getMission(missionId)?.session_id === 'cwd-gone-session', 'the session id');
  await until(() => getTurnState(missionId)?.turnActive === false, 'the end of the first turn');
  const taskId = taskOn(agent, missionId);

  agentIn(agent, 'cwd-gone-persistent', gone);
  dbApi.setMissionPermissionModeOverride(missionId, 'plan');
  const before = launches;
  await assert.rejects(sendToAgent(missionId, 'now in plan'), (err: unknown) => err instanceof CwdUnusableError);
  assert.equal(launches, before);
  await assertSurfacedNotReplayed(missionId, taskId);
});

test('a steer that restarts the turn on a folder that is gone is not a crash', async () => {
  const agent = 'cwd-gone-steer';
  agentIn(agent, 'cwd-gone-oneshot', usable);
  const missionId = await spawnAgent(agent, 'hello');
  missions.push(missionId);
  await until(() => dbApi.getMission(missionId)?.session_id === 'cwd-gone-session', 'the session id');
  assert.equal(getTurnState(missionId)?.turnActive, true);
  const taskId = taskOn(agent, missionId);

  agentIn(agent, 'cwd-gone-oneshot', gone);
  const before = launches;
  await assert.rejects(steerMission(missionId, 'look elsewhere'), (err: unknown) => err instanceof CwdUnusableError);
  assert.equal(launches, before);
  await assertSurfacedNotReplayed(missionId, taskId);
});
