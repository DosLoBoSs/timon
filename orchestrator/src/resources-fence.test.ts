/**
 * The fence layer of a mission launch (`resources.ts`): what `auto`, `enforce`
 * and `off` do with each state of the host's fence, where the policy goes,
 * that the fence is the innermost wrapper of the chain, and that the pid the
 * daemon spawns stays the CLI's through every `exec`ing layer.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TimonConfigSchema } from './config/schema.js';
import { findFenceBinary, probeFence } from './host/fence.js';
import { createLandlockFence } from './host/landlock.js';
import { createLinuxHost } from './host/linux.js';
import { hasSystemd } from './host/systemd.js';
import type { FencePolicy } from './host/isolation.js';
import type { HostFence, HostFenceProbe } from './host/types.js';
import {
  fenceLaunchFailure, fenceMissionCommand, fencePolicyFile, hostFenceStatus, MissionFenceRefusedError, noteFenceLaunchFailure,
  resetFenceLaunchFailureForTest, watchFencedLaunch, wrapMissionLaunch, type MissionFenceOutcome,
} from './resources.js';

// The fence checks every grant on the path it resolves to: the tree exists.
const TH = join(mkdtempSync(join(tmpdir(), 'fence-launch-')), '.timon');
const MISSION = 'cccccccc-0000-4000-8000-000000000003';
const TARGET = { timonHome: TH, cwd: join(TH, 'worktrees', 'task-1'), missionId: MISSION, platform: 'linux' as const };
mkdirSync(TARGET.cwd, { recursive: true });
mkdirSync(join(TH, 'agents', 'coder'), { recursive: true });

function fakeFence(probe: HostFenceProbe, wrap?: HostFence['wrap']): HostFence & { policies: FencePolicy[] } {
  const policies: FencePolicy[] = [];
  return {
    mechanism: 'landlock',
    policies,
    probe: () => probe,
    wrap: wrap ?? ((policy, cmd, args, policyFile) => {
      policies.push(policy);
      return { cmd: '/opt/timon/timon-fence', args: ['--policy', policyFile, '--', cmd, ...args] };
    }),
  };
}

test('a fence that answers wraps the CLI, with the policy under the folder no mission reaches', () => {
  const fence = fakeFence({ available: true, abi: 6 });
  const warnings: string[] = [];
  const launch = fenceMissionCommand('/usr/bin/claude', ['-p'], 'unit-1', TARGET, { mode: 'auto', fence, warn: (l) => warnings.push(l) });
  const policyFile = fencePolicyFile(TH, 'unit-1');
  assert.equal(policyFile, join(TH, 'run', 'fence', 'unit-1.policy'));
  assert.deepEqual(launch, {
    cmd: '/opt/timon/timon-fence',
    args: ['--policy', policyFile, '--', '/usr/bin/claude', '-p'],
    fence: { state: 'fenced', mechanism: 'landlock', policyFile, tmpDir: join(TH, 'tmp', 'missions', MISSION) },
  });
  assert.equal(fence.policies[0]?.enabled, true);
  assert.ok(fence.policies[0]?.rw.includes(TARGET.cwd), 'the policy is the daemon\'s own projection of the target');
  assert.deepEqual(warnings, []);
});

test('auto launches an unfenceable mission unfenced, and says why', () => {
  const warnings: string[] = [];
  const launch = fenceMissionCommand('/usr/bin/claude', [], 'u', TARGET, {
    mode: 'auto', fence: fakeFence({ available: false, reason: 'kernel without Landlock', abi: 0 }), warn: (l) => warnings.push(l),
  });
  assert.deepEqual([launch.cmd, launch.args], ['/usr/bin/claude', []]);
  assert.equal(launch.fence?.state, 'unfenced');
  assert.match(warnings[0] ?? '', /mission cccccccc: Mission launched unfenced: kernel without Landlock\./);
});

test('an altered launcher has its own words, in auto as in enforce', () => {
  const altered = fakeFence({ available: false, reason: 'the fence launcher this release ships (/x) is missing', abi: 0, tampered: true });
  const warnings: string[] = [];
  const launch = fenceMissionCommand('/usr/bin/claude', [], 'u', TARGET, { mode: 'auto', fence: altered, warn: (l) => warnings.push(l) });
  assert.ok(launch.fence?.state === 'unfenced' && launch.fence.tampered);
  assert.match(warnings[0] ?? '', /UNFENCED: .*missing\. The Timon package may have been altered/);
  assert.throws(
    () => fenceMissionCommand('/usr/bin/claude', [], 'u', TARGET, { mode: 'enforce', fence: altered, warn: () => {} }),
    (err: unknown) => err instanceof MissionFenceRefusedError && /"enforce".*altered/.test(err.message),
  );
});

test('enforce refuses a mission it cannot fence, with a sentence a person can act on', () => {
  for (const fence of [undefined, fakeFence({ available: false, reason: 'kernel with Landlock ABI 1, 2 or later is required', abi: 1 })]) {
    assert.throws(
      () => fenceMissionCommand('/usr/bin/claude', [], 'u', TARGET, { mode: 'enforce', fence, warn: () => {} }),
      (err: unknown) => err instanceof MissionFenceRefusedError && /Mission refused: host\.isolation\.filesystem is "enforce"/.test(err.message),
    );
  }
});

test('a policy the fence cannot render is a fence that cannot be applied', () => {
  const broken = fakeFence({ available: true }, () => { throw new Error('a fence path holds a control character'); });
  const warnings: string[] = [];
  const launch = fenceMissionCommand('/usr/bin/claude', [], 'u', TARGET, { mode: 'auto', fence: broken, warn: (l) => warnings.push(l) });
  assert.equal(launch.fence?.state, 'unfenced');
  assert.match(warnings[0] ?? '', /cannot be applied \(a fence path holds a control character\)/);
  assert.throws(() => fenceMissionCommand('/usr/bin/claude', [], 'u', TARGET, { mode: 'enforce', fence: broken, warn: () => {} }), MissionFenceRefusedError);
});

test('off fences nothing and warns about nothing; Windows has no fence to ask', () => {
  const warnings: string[] = [];
  const launch = fenceMissionCommand('/usr/bin/claude', [], 'u', TARGET, { mode: 'off', fence: fakeFence({ available: true }), warn: (l) => warnings.push(l) });
  assert.deepEqual(launch.fence, { state: 'unfenced', warning: null, tampered: false });
  assert.deepEqual(warnings, []);
  assert.deepEqual(hostFenceStatus(undefined), { state: 'unsupported', reason: 'no mission fence on this OS', abi: 0 });
});

test('a launcher that failed at launch is not trusted again until the daemon restarts', () => {
  try {
    noteFenceLaunchFailure('timon-fence: cannot apply the Landlock ruleset: Operation not permitted');
    const status = hostFenceStatus(fakeFence({ available: true, abi: 6 }));
    assert.deepEqual(status, { state: 'unsupported', reason: 'timon-fence: cannot apply the Landlock ruleset: Operation not permitted', abi: 0 });
  } finally {
    resetFenceLaunchFailureForTest();
  }
  assert.equal(hostFenceStatus(fakeFence({ available: true, abi: 6 })).state, 'ready');
});

test('a grant the policy dropped is reported, never silently lost', () => {
  writeFileSync(join(TH, 'daemon-token'), 'FAKE');
  const warnings: string[] = [];
  fenceMissionCommand('/usr/bin/claude', [], 'u', { ...TARGET, gitDirs: [join(TH, 'daemon-token')] }, {
    mode: 'auto', fence: fakeFence({ available: true }), warn: (l) => warnings.push(l),
  });
  assert.ok(warnings.some((l) => l.includes(`fence grant on ${join(TH, 'daemon-token')} dropped`)));
});

test('the wrapper\'s own probe carries no mission: nothing to fence, the line is unchanged', () => {
  const launch = wrapMissionLaunch('true', [], 'probe000');
  assert.equal(launch.fence, null);
  assert.equal(launch.args.at(-1) === 'true' || launch.cmd === 'true', true);
  assert.ok(!launch.args.includes('--policy'));
});

test('the fence is the innermost wrapper: under the scope, nice and ionice, right before the CLI', { skip: !hasSystemd() && 'no systemd here' }, () => {
  const fenced = fenceMissionCommand('/usr/bin/claude', ['-p', 'hi'], 'unit-2', TARGET, { mode: 'auto', fence: fakeFence({ available: true }), warn: () => {} });
  const host = createLinuxHost(TimonConfigSchema.parse({ host: { docker: 'disabled' } }));
  const chain = host.confine(fenced.cmd, fenced.args, 'unit-2', TARGET);
  if (chain.cmd !== 'systemd-run') return; // the resource guard is off in this environment
  const at = (word: string) => chain.args.indexOf(word);
  assert.ok(at('--scope') < at('nice') && at('nice') < at('ionice') && at('ionice') < at('/opt/timon/timon-fence'));
  assert.deepEqual(chain.args.slice(at('/opt/timon/timon-fence')), [
    '/opt/timon/timon-fence', '--policy', fencePolicyFile(TH, 'unit-2'), '--', '/usr/bin/claude', '-p', 'hi',
  ]);
});

test('through every exec-ing layer and a stand-in launcher, the pid spawned is the CLI\'s', { skip: process.platform === 'win32' && 'exec chains are a POSIX matter' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fence-chain-'));
  const script = (name: string, body: string) => {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  // Same shapes as the real chain: `nice -n N`, `ionice -c N`, then the launcher's `--policy F --`.
  const nice = script('nice', 'shift 2; exec "$@"');
  const ionice = script('ionice', 'shift 2; exec "$@"');
  const fence = fakeFence({ available: true }, (_policy, cmd, args, policyFile) => ({
    cmd: script('timon-fence', '[ "$1" = --policy ] && [ "$3" = -- ] || exit 64; shift 3; exec "$@"'),
    args: ['--policy', policyFile, '--', cmd, ...args],
  }));
  const fenced = fenceMissionCommand('/bin/sh', ['-c', 'echo $$'], 'unit-3', TARGET, { mode: 'auto', fence, warn: () => {} });
  const child = spawn(nice, ['-n', '10', ionice, '-c', '3', fenced.cmd, ...fenced.args], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  assert.equal(Number(out.trim()), child.pid);
});

test('the mission\'s own folders are made before the policy, so the fence grants them', () => {
  const fence = fakeFence({ available: true });
  const warnings: string[] = [];
  const launch = fenceMissionCommand('/usr/bin/claude', [], 'unit-4', { ...TARGET, agent: 'coder' }, {
    mode: 'auto', fence, warn: (l) => warnings.push(l),
  });
  const tmpDir = join(TH, 'tmp', 'missions', MISSION);
  assert.ok(launch.fence?.state === 'fenced' && launch.fence.tmpDir === tmpDir);
  assert.ok(existsSync(tmpDir) && existsSync(join(TH, 'agents', 'coder', 'memory')));
  assert.ok(fence.policies[0]?.rw.includes(tmpDir));
  assert.ok(fence.policies[0]?.rw.includes(join(TH, 'agents', 'coder', 'memory')));
  // Scratch folders this provider never made are not worth a line at every turn.
  assert.deepEqual(warnings, []);
});

test('a name alone never creates an agent folder', () => {
  fenceMissionCommand('/usr/bin/claude', [], 'unit-5', { ...TARGET, agent: 'nobody' }, { mode: 'auto', fence: fakeFence({ available: true }), warn: () => {} });
  assert.equal(existsSync(join(TH, 'agents', 'nobody')), false);
});

test('only the launcher\'s own words, with its "cannot fence here" codes, count as a fence failure', () => {
  assert.equal(fenceLaunchFailure('landlock', 71, 'timon-fence: cannot apply the Landlock ruleset: Operation not permitted\n'),
    'timon-fence: cannot apply the Landlock ruleset: Operation not permitted');
  assert.equal(fenceLaunchFailure('landlock', 69, 'timon-fence: Landlock ABI 2 or later is required (found 0)'), 'timon-fence: Landlock ABI 2 or later is required (found 0)');
  assert.equal(fenceLaunchFailure('landlock', 71, 'error: the CLI said something\n'), null, 'a CLI exiting 71 is not the launcher');
  assert.equal(fenceLaunchFailure('landlock', 127, 'timon-fence: cannot execute claude: No such file or directory'), null, 'a missing CLI is not a fence failure');
  assert.equal(fenceLaunchFailure('landlock', 78, 'timon-fence: policy truncated'), null, 'a bad policy is the daemon\'s bug, not the machine');
  assert.equal(fenceLaunchFailure('seatbelt', 71, 'sandbox-exec: sandbox_apply: Operation not permitted'), 'sandbox-exec: sandbox_apply: Operation not permitted');
});

test('a launcher that could not fence turns the fence off for the next launches, and its policy goes', () => {
  const policyFile = join(TH, 'run', 'fence', 'watched.policy');
  mkdirSync(join(TH, 'run', 'fence'), { recursive: true });
  writeFileSync(policyFile, 'x');
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stderr });
  const outcome: MissionFenceOutcome = { state: 'fenced', mechanism: 'landlock', policyFile, tmpDir: null };
  try {
    watchFencedLaunch(proc, outcome);
    stderr.write('timon-fence: cannot apply the Landlock ruleset: Operation not permitted\n');
    proc.emit('close', 71);
    assert.equal(existsSync(policyFile), false);
    const status = hostFenceStatus(fakeFence({ available: true, abi: 6 }));
    assert.equal(status.state, 'unsupported');
    assert.throws(
      () => fenceMissionCommand('/usr/bin/claude', [], 'u', TARGET, { mode: 'enforce', fence: fakeFence({ available: true, abi: 6 }), warn: () => {} }),
      (err: unknown) => err instanceof MissionFenceRefusedError && /Operation not permitted/.test(err.message),
    );
  } finally {
    resetFenceLaunchFailureForTest();
  }
});

test('a CLI that fails on its own leaves the fence on', () => {
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stderr });
  watchFencedLaunch(proc, { state: 'fenced', mechanism: 'landlock', policyFile: join(TH, 'run', 'fence', 'other.policy'), tmpDir: null });
  stderr.write('Error: invalid API key\n');
  proc.emit('close', 1);
  assert.equal(hostFenceStatus(fakeFence({ available: true, abi: 6 })).state, 'ready');
});

/* ── The real chain, on a kernel that can fence ─────────────────────────── */

const REPO = fileURLToPath(new URL('../..', import.meta.url));

/** The launcher of this checkout, or one built for the test when a C compiler is around. */
function realLauncher(): string | null {
  if (process.platform !== 'linux') return null;
  const found = findFenceBinary();
  if (found) return found;
  const out = join(mkdtempSync(join(tmpdir(), 'fence-chain-bin-')), 'timon-fence');
  try {
    execFileSync(process.execPath, [join(REPO, 'native', 'timon-fence', 'build.mjs'), '--out', out, '--optional'], { stdio: 'ignore', timeout: 120_000 });
  } catch { return null; }
  return existsSync(out) ? out : null;
}

function onPath(name: string): boolean {
  try {
    execFileSync('/bin/sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const REAL = realLauncher();
const REAL_PROBE = REAL ? probeFence(REAL) : null;
const realSkip = !REAL ? 'no timon-fence for this machine (Linux with a C compiler only)'
  : !REAL_PROBE?.available ? `no fence on this kernel: ${REAL_PROBE?.reason}`
  : !onPath('nice') || !onPath('ionice') ? 'nice or ionice missing' : false;

const CHAIN_SCRIPT = String.raw`
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const [TH] = process.argv.slice(1);
const out = { pid: process.pid, tmp: os.tmpdir() };
const t = (name, fn) => { try { fn(); out[name] = 'ok'; } catch (e) { out[name] = e.code || String(e.message); } };
t('readToken', () => fs.readFileSync(path.join(TH, 'daemon-token')));
t('readPolicy', () => fs.readdirSync(path.join(TH, 'run', 'fence')));
t('writeTmp', () => fs.writeFileSync(path.join(os.tmpdir(), 'scratch'), 'x'));
process.stdout.write(JSON.stringify(out));
`;

test('the real chain: nice, ionice and timon-fence exec down to the CLI, which keeps its pid and reads nothing private', { skip: realSkip }, async () => {
  // Not under /tmp when avoidable: every mission writes it, so a home inside it is listed whole.
  const runtime = process.env.XDG_RUNTIME_DIR;
  const base = runtime && existsSync(runtime) ? runtime : tmpdir();
  const root = realpathSync(mkdtempSync(join(base, 'fence-chain-')));
  try {
    const home = join(root, 'home');
    const th = join(home, '.timon');
    const cwd = join(th, 'worktrees', 'task-r');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(th, 'daemon-token'), 'FAKE-TOKEN');
    const fence = createLandlockFence({ status: () => ({ state: 'ready', binary: REAL as string, abi: REAL_PROBE?.abi ?? 0, seccomp: true }) });
    const launch = fenceMissionCommand(process.execPath, ['-e', CHAIN_SCRIPT, th], 'unit-real', {
      timonHome: th, home, cwd, missionId: MISSION, platform: 'linux',
    }, { mode: 'enforce', fence, warn: () => {} });
    assert.ok(launch.fence?.state === 'fenced' && launch.fence.tmpDir);
    const child = spawn('nice', ['-n', '5', 'ionice', '-c', '3', launch.cmd, ...launch.args], {
      cwd, env: { ...process.env, TMPDIR: launch.fence.tmpDir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    assert.equal(code, 0, stderr);
    const out = JSON.parse(stdout) as Record<string, string | number>;
    assert.equal(out.pid, child.pid, 'the pid the daemon spawned is the CLI\'s');
    assert.equal(out.readToken, 'EACCES');
    assert.equal(out.readPolicy, 'EACCES', 'the policies of other launches are out of reach');
    assert.equal(out.tmp, launch.fence.tmpDir);
    assert.equal(out.writeTmp, 'ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
