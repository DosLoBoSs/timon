import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-mission-writable-'));
const HOME = process.env.TIMON_HOME;

const { TimonConfigSchema } = await import('../config/schema.js');
const { fenceWritableRoots, missionWritableProblem, setMissionWritableRootsSource } = await import('./mission-writable.js');

test('the Timon home holds executables only in the folders the daemon installs', () => {
  assert.equal(missionWritableProblem(join(HOME, 'plugins', 'p', 'bin', 'x')), null);
  assert.equal(missionWritableProblem(join(HOME, 'providers', 'acp-registry', 'agents', 'a', '1', 'x')), null);
  for (const zone of ['worktrees', 'tmp', 'backend-accounts', 'codex-runs', 'agents', 'workspace', 'a-folder-added-later']) {
    assert.ok(missionWritableProblem(join(HOME, zone, 'x')), zone);
  }
  assert.ok(missionWritableProblem('git'));
  assert.ok(missionWritableProblem(''));
  assert.equal(missionWritableProblem(join(tmpdir(), 'elsewhere', 'git')), null);
});

// POSIX paths written out: the arithmetic is the same on Windows.
test('the home folders the fence lets missions write are refused too', { skip: process.platform === 'win32' }, (t) => {
  const config = TimonConfigSchema.parse({
    host: {
      isolation: {
        writable: ['~/shared-bin'],
        exceptions: { agents: { a: { writable: ['/opt/agent-tools'] } }, projects: { p: { writable: ['~/proj-tools'] } } },
      },
    },
  });
  const roots = fenceWritableRoots(config, '/home/u');
  assert.deepEqual(roots, ['/home/u/shared-bin', '/opt/agent-tools', '/home/u/proj-tools']);
  setMissionWritableRootsSource(() => roots);
  t.after(() => setMissionWritableRootsSource(() => []));
  assert.ok(missionWritableProblem('/home/u/shared-bin/git', { platform: 'linux' }));
  assert.ok(missionWritableProblem('/opt/agent-tools/bin/git', { platform: 'linux' }));
  assert.equal(missionWritableProblem('/home/u/.local/bin/git', { platform: 'linux' }), null);
});
