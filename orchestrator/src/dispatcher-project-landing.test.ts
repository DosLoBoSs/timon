/**
 * The project's integration setting reaches the chain at dispatch
 * (`docs/KANBAN-PR-PIPELINE.md` §2.2, §7.2): a task that starts a chain in a
 * project set to `pr` is cut from `<remote>/<target>` on the job's integration
 * branch; a project without a setting, or in `local`, sees nothing change.
 *
 * `npm test -- src/dispatcher-project-landing.test.ts`
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// The bare remotes live under the system temporary folder: the daemon's git
// accepts such a local remote only when no filesystem fence is configured.
writeFileSync(join(process.env.TIMON_HOME!, 'timon.config.json'), JSON.stringify({ host: { isolation: { filesystem: 'off' } } }));

const { dbApi } = await import('./db.js');
type TaskRow = import('./db.js').TaskRow;
const { agentDir } = await import('./paths.js');
const { blockIfBaseUnavailable, projectLanding } = await import('./dispatcher.js');
const { updateProjectIntegration, clearProjectIntegration } = await import('./project-integration.js');
const { decodeDaemonMessage } = await import('./daemon-message.js');

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
}

/** A checkout on `main` and a bare `origin` one commit ahead of it. */
function mkRepo(): { repo: string; remoteMain: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'timon-landing-'));
  const repo = join(dir, 'repo');
  const bare = join(dir, 'remote.git');
  const other = join(dir, 'other');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'remote', 'add', 'origin', bare);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', bare, other]);
  git(other, 'config', 'user.name', 'Test');
  git(other, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(other, 'b.txt'), 'b\n');
  git(other, 'add', 'b.txt');
  git(other, 'commit', '-q', '-m', 'landed elsewhere');
  git(other, 'push', '-q', 'origin', 'main');
  return { repo, remoteMain: git(other, 'rev-parse', 'HEAD'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A project and its coder in `repo`; `pr` sets the project to land by pull request. */
function mkProject(repo: string, opts: { pr?: boolean; prefix?: string } = {}): { slug: string; agent: string } {
  const slug = `landing-${randomUUID().slice(0, 8)}`;
  const agent = `${slug}.coder`;
  dbApi.upsertProject(slug, { cwd: repo });
  mkdirSync(agentDir(agent), { recursive: true });
  writeFileSync(join(agentDir(agent), 'config.json'), JSON.stringify({ cwd: repo, role: 'coder', project: slug }));
  writeFileSync(join(agentDir(agent), 'system-prompt.md'), 'Test');
  if (opts.pr) {
    updateProjectIntegration(slug, {
      mode: 'pr', account: 'octocat', ...(opts.prefix ? { branch_prefix: opts.prefix } : {}),
    });
  }
  return { slug, agent };
}

function mkTask(
  project: { slug: string; agent: string },
  type: TaskRow['type'],
  title: string,
  opts: { deps?: string[]; base?: string } = {},
): TaskRow {
  const id = randomUUID();
  dbApi.createTask(id, title, project.agent, { type, project: project.slug, deps: opts.deps ?? [], baseBranch: opts.base });
  return dbApi.getTask(id)!;
}

function blocked(id: string): { code: string | undefined; reason: string } {
  const task = dbApi.getTask(id)!;
  assert.equal(task.status, 'BLOCKED');
  return { code: decodeDaemonMessage(task.blocked_reason_code)?.code, reason: task.blocked_reason ?? '' };
}

test('pr project: a root task without a base gets the branch named after its title, cut from the remote', async () => {
  const { repo, remoteMain, cleanup } = mkRepo();
  try {
    const project = mkProject(repo, { pr: true });
    const task = mkTask(project, 'code', 'Add the pull request task');
    assert.equal(await blockIfBaseUnavailable(task), false);
    const row = dbApi.getTask(task.id)!;
    assert.equal(row.integration_mode, 'pr');
    assert.equal(row.base_ref, 'origin/main');
    assert.equal(row.base_branch, 'feat/add-the-pull-request-task');
    assert.equal(git(repo, 'rev-parse', 'feat/add-the-pull-request-task'), remoteMain);
    assert.equal(git(repo, 'branch', '--show-current'), 'main');
    const integration = dbApi.getIntegration(repo, 'feat/add-the-pull-request-task');
    assert.equal(integration?.mode, 'pr');
    assert.equal(integration?.project, project.slug);
  } finally {
    cleanup();
  }
});

test('pr project: the base the plan gave is kept, the prefix of the setting names a derived one', async () => {
  const { repo, cleanup } = mkRepo();
  try {
    const project = mkProject(repo, { pr: true, prefix: 'feature/' });
    const planned = mkTask(project, 'code', 'Volet A', { base: 'feature/the-job' });
    assert.equal(await blockIfBaseUnavailable(planned), false);
    assert.equal(dbApi.getTask(planned.id)!.base_branch, 'feature/the-job');
    assert.equal(dbApi.getTask(planned.id)!.integration_mode, 'pr');

    const derived = mkTask(project, 'code', 'Volet B');
    assert.equal(projectLanding(derived).kind, 'integration');
    assert.equal(await blockIfBaseUnavailable(derived), false);
    assert.equal(dbApi.getTask(derived.id)!.base_branch, 'feature/volet-b');
  } finally {
    cleanup();
  }
});

test('pr project: a branch under embargo lands by hand, never through a pull request', async () => {
  const { repo, cleanup } = mkRepo();
  try {
    const project = mkProject(repo, { pr: true });
    const task = mkTask(project, 'code', 'Fix a leak', { base: 'sec/fix-a-leak' });
    assert.equal(await blockIfBaseUnavailable(task), false);
    assert.equal(dbApi.getTask(task.id)!.integration_mode, 'branch');
  } finally {
    cleanup();
  }
});

test('pr project: a base that is the target, or no usable name, blocks the task', async () => {
  const { repo, cleanup } = mkRepo();
  try {
    const project = mkProject(repo, { pr: true });
    const onTarget = mkTask(project, 'code', 'Straight to main', { base: 'main' });
    assert.equal(await blockIfBaseUnavailable(onTarget), true);
    const target = blocked(onTarget.id);
    assert.equal(target.code, 'integration_branch_unavailable');
    assert.match(target.reason, /never from main itself/);
    assert.equal(dbApi.getTask(onTarget.id)!.integration_mode, null);

    const withId = mkTask(project, 'code', 'Volet', { base: 'feat/4943a04e' });
    assert.equal(await blockIfBaseUnavailable(withId), true);
    assert.match(blocked(withId.id).reason, /carries an id/);

    const nameless = mkTask(project, 'code', '—');
    assert.equal(await blockIfBaseUnavailable(nameless), true);
    assert.match(blocked(nameless.id).reason, /no branch name can be drawn/);
  } finally {
    cleanup();
  }
});

test('a stored setting that no longer validates blocks the task instead of passing for local', async () => {
  const { repo, cleanup } = mkRepo();
  try {
    const project = mkProject(repo);
    dbApi.setProjectIntegration(project.slug, JSON.stringify({ mode: 'pr', remote: 'origin' }));
    const task = mkTask(project, 'code', 'Anything');
    assert.equal(await blockIfBaseUnavailable(task), true);
    assert.match(blocked(task.id).reason, /integration setting of project .* is invalid/);
  } finally {
    cleanup();
  }
});

test('non-regression: a project without a setting, or in local mode, writes nothing', async () => {
  const { repo, cleanup } = mkRepo();
  try {
    const bare = mkProject(repo);
    for (const base of [undefined, 'main']) {
      const task = mkTask(bare, 'code', 'Plain job', { base });
      assert.deepEqual(projectLanding(task), { kind: 'local' });
      assert.equal(await blockIfBaseUnavailable(task), false);
      const row = dbApi.getTask(task.id)!;
      assert.equal(row.status, 'PENDING');
      assert.equal(row.integration_mode, null);
      assert.equal(row.base_ref, null);
      assert.equal(row.base_branch, base ?? null);
    }

    const local = mkProject(repo, { pr: true });
    updateProjectIntegration(local.slug, { mode: 'local' });
    const task = mkTask(local, 'code', 'Plain job');
    assert.equal(await blockIfBaseUnavailable(task), false);
    assert.equal(dbApi.getTask(task.id)!.integration_mode, null);
    assert.equal(dbApi.getTask(task.id)!.base_branch, null);
    assert.throws(() => git(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/feat/plain-job'));

    clearProjectIntegration(local.slug);
    assert.deepEqual(projectLanding(task), { kind: 'local' });
  } finally {
    cleanup();
  }
});

test('a chain already under way keeps its local mode when the project switches to pr', async () => {
  const { repo, cleanup } = mkRepo();
  try {
    const project = mkProject(repo);
    const code = mkTask(project, 'code', 'Started locally', { base: 'main' });
    assert.equal(await blockIfBaseUnavailable(code), false);
    dbApi.setTaskWorktree(code.id, '/wt/x', `timon/task/${code.id}`, 'main');
    updateProjectIntegration(project.slug, { mode: 'pr', account: 'octocat' });
    const merge = mkTask(project, 'merge', 'Its merge', { deps: [code.id] });
    assert.equal(await blockIfBaseUnavailable(merge), false);
    const row = dbApi.getTask(merge.id)!;
    assert.equal(row.integration_mode, null);
    assert.equal(row.base_branch, null);
  } finally {
    cleanup();
  }
});
