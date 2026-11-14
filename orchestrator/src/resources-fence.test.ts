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
import { createSeatbeltFence } from './host/darwin.js';
import { SANDBOX_EXEC } from './host/seatbelt.js';
import { createLinuxHost } from './host/linux.js';
import { hasSystemd } from './host/systemd.js';
import type { FencePolicy } from './host/isolation.js';
import type { HostFence, HostFenceProbe, HostFenceWitness } from './host/types.js';
import {
  fenceLaunchFailure, fenceMissionCommand, fencePolicyFile, fenceWitnessFailure, hostFenceStatus, MissionFenceRefusedError, noteFenceLaunchFailure,
  resetFenceLaunchFailureForTest, watchFencedLaunch, wrapMissionLaunch, type MissionFenceOutcome,
} from './resources.js';

// The fence checks every grant on the path it resolves to: the tree exists.
const TH = join(mkdtempSync(join(tmpdir(), 'fence-launch-')), '.timon');
const MISSION = 'cccccccc-0000-4000-8000-000000000003';
const TARGET = { timonHome: TH, cwd: join(TH, 'worktrees', 'task-1'), missionId: MISSION, platform: 'linux' as const };
mkdirSync(TARGET.cwd, { recursive: true });
mkdirSync(join(TH, 'agents', 'coder'), { recursive: true });

const WITNESS_OK: HostFenceWitness = { ran: true, status: 0, stderr: '' };

function fakeFence(
  probe: HostFenceProbe,
  wrap?: HostFence['wrap'],
  witness: HostFenceWitness = WITNESS_OK,
): HostFence & { policies: FencePolicy[]; witnessed: string[] } {
  const policies: FencePolicy[] = [];
  const witnessed: string[] = [];
  return {
    mechanism: 'landlock',
    policies,
    witnessed,
    probe: () => probe,
    wrap: wrap ?? ((policy, cmd, args, policyFile) => {
      policies.push(policy);
      return { cmd: '/opt/timon/timon-fence', args: ['--policy', policyFile, '--', cmd, ...args] };
    }),
    witness: async (policyFile) => {
      witnessed.push(policyFile);
      return witness;
    },
  };
}

/** A fenced launch the test ends by hand: what its CLI wrote on stderr, then its exit code. */
async function endLaunch(outcome: MissionFenceOutcome, fence: HostFence | undefined, stderrText: string, code: number | null): Promise<string> {
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stderr });
  const settled = watchFencedLaunch(proc, outcome, { fence });
  let read = '';
  stderr.on('data', (chunk: Buffer) => { read += chunk.toString(); }); // the mission's own reader
  stderr.write(stderrText);
  await new Promise((resolve) => setImmediate(resolve));
  proc.emit('close', code);
  await settled;
  return read;
}

function fencedOutcome(name: string, mechanism: 'landlock' | 'seatbelt' = 'landlock'): MissionFenceOutcome & { state: 'fenced' } {
  const policyFile = join(TH, 'run', 'fence', `${name}.policy`);
  mkdirSync(join(TH, 'run', 'fence'), { recursive: true });
  writeFileSync(policyFile, 'x');
  return { state: 'fenced', mechanism, policyFile, tmpDir: null };
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

test('only the launcher\'s own words, with its "cannot fence here" codes, raise the suspicion of a fence failure', () => {
  assert.equal(fenceLaunchFailure('landlock', 71, 'timon-fence: cannot apply the Landlock ruleset: Operation not permitted\n'),
    'timon-fence: cannot apply the Landlock ruleset: Operation not permitted');
  assert.equal(fenceLaunchFailure('landlock', 69, 'timon-fence: Landlock ABI 2 or later is required (found 0)'), 'timon-fence: Landlock ABI 2 or later is required (found 0)');
  assert.equal(fenceLaunchFailure('landlock', 71, 'error: the CLI said something\n'), null, 'a CLI exiting 71 is not the launcher');
  assert.equal(fenceLaunchFailure('landlock', 127, 'timon-fence: cannot execute claude: No such file or directory'), null, 'a missing CLI is not a fence failure');
  assert.equal(fenceLaunchFailure('landlock', 78, 'timon-fence: policy truncated'), null, 'a bad policy is the daemon\'s bug, not the machine');
  assert.equal(fenceLaunchFailure('seatbelt', 71, 'sandbox-exec: sandbox_apply: Operation not permitted'), 'sandbox-exec: sandbox_apply: Operation not permitted');
});

test('a launcher that could not fence, and fails its witness run too, turns the fence off for the next launches', async () => {
  const outcome = fencedOutcome('watched');
  const fence = fakeFence({ available: true, abi: 6 }, undefined, {
    ran: true, status: 71, stderr: 'timon-fence: cannot apply the Landlock ruleset: Operation not permitted\n',
  });
  try {
    const read = await endLaunch(outcome, fence, 'timon-fence: cannot apply the Landlock ruleset: Operation not permitted\n', 71);
    assert.match(read, /Operation not permitted/, 'the mission\'s reader still gets every byte');
    assert.deepEqual(fence.witnessed, [outcome.policyFile], 'the witness runs on the launch\'s own policy');
    assert.equal(existsSync(outcome.policyFile), false, 'the policy goes once the witness is done');
    assert.equal(hostFenceStatus(fakeFence({ available: true, abi: 6 })).state, 'unsupported');
    assert.throws(
      () => fenceMissionCommand('/usr/bin/claude', [], 'u', TARGET, { mode: 'enforce', fence: fakeFence({ available: true, abi: 6 }), warn: () => {} }),
      (err: unknown) => err instanceof MissionFenceRefusedError && /Operation not permitted/.test(err.message),
    );
    // A real failure is said once: a second one finds the fence already off and asks nothing.
    const again = fencedOutcome('watched-again');
    await endLaunch(again, fence, 'timon-fence: cannot apply the Landlock ruleset: Operation not permitted\n', 71);
    assert.equal(fence.witnessed.length, 1);
  } finally {
    resetFenceLaunchFailureForTest();
  }
});

test('a CLI that prints the launcher\'s words and exits 69 or 71 does not turn the fence off', async () => {
  for (const [code, line] of [
    [71, 'timon-fence: cannot apply the Landlock ruleset: Operation not permitted'],
    [69, 'timon-fence: Landlock ABI 2 or later is required (found 0)'],
  ] as const) {
    const outcome = fencedOutcome(`forged-${code}`);
    const fence = fakeFence({ available: true, abi: 6 });
    await endLaunch(outcome, fence, `some output\n${line}\n`, code);
    assert.deepEqual(fence.witnessed, [outcome.policyFile], 'the launcher is asked, not the mission');
    assert.equal(existsSync(outcome.policyFile), false);
    assert.equal(hostFenceStatus(fence).state, 'ready', `a forged ${code} leaves the fence on`);
    const next = fenceMissionCommand('/usr/bin/claude', [], 'u', TARGET, { mode: 'enforce', fence, warn: () => {} });
    assert.equal(next.fence?.state, 'fenced', 'the next mission is still fenced');
  }
});

test('macOS: a CLI exiting non-zero with sandbox-exec\'s words does not turn the fence off; a profile the OS rejects does', async () => {
  const witnessed: Array<[string, readonly string[]]> = [];
  let answer: HostFenceWitness = WITNESS_OK;
  const seatbelt = createSeatbeltFence({
    run: () => ({ status: 0, stderr: '' }),
    writeProfile: () => {},
    realpath: (path) => path,
    runWitness: async (file, args) => {
      witnessed.push([file, args]);
      return answer;
    },
  });
  try {
    const forged = fencedOutcome('mac-forged', 'seatbelt');
    await endLaunch(forged, seatbelt, 'sandbox-exec: sandbox_apply: Operation not permitted\n', 1);
    assert.deepEqual(witnessed, [[SANDBOX_EXEC, ['-f', forged.policyFile, '--', '/usr/bin/true']]], 'sandbox-exec is run on the launch\'s profile, with /usr/bin/true');
    assert.equal(hostFenceStatus(seatbelt).state, 'ready', 'a CLI exit code proves nothing under Seatbelt');

    answer = { ran: true, status: 65, stderr: 'sandbox-exec: /x.sb:12: unbound variable: file-read-xattr (cutoff)\n' };
    const rejected = fencedOutcome('mac-rejected', 'seatbelt');
    await endLaunch(rejected, seatbelt, 'sandbox-exec: /x.sb:12: unbound variable: file-read-xattr (cutoff)\n', 65);
    assert.deepEqual(hostFenceStatus(seatbelt), { state: 'unsupported', reason: 'sandbox-exec: /x.sb:12: unbound variable: file-read-xattr (cutoff)', abi: 0 });
    const lines: string[] = [];
    for (let i = 0; i < 3; i += 1) fenceMissionCommand('/usr/bin/claude', [], 'u', TARGET, { mode: 'auto', fence: seatbelt, warn: (l) => lines.push(l) });
    assert.equal(lines.filter((l) => l.includes('unbound variable')).length, 3, 'each launch carries the cause');
  } finally {
    resetFenceLaunchFailureForTest();
  }
});

test('auto: a real launcher failure is warned about once in the log', async () => {
  const warned: string[] = [];
  const original = console.warn;
  const fence = fakeFence({ available: true, abi: 6 }, undefined, { ran: true, status: 71, stderr: 'timon-fence: cannot set no_new_privs: Invalid argument (once)\n' });
  try {
    await endLaunch(fencedOutcome('warn-once'), fence, 'timon-fence: cannot set no_new_privs: Invalid argument (once)\n', 71);
    console.warn = (line: string) => { warned.push(line); };
    for (let i = 0; i < 3; i += 1) fenceMissionCommand('/usr/bin/claude', [], 'u', TARGET, { mode: 'auto', fence });
  } finally {
    console.warn = original;
    resetFenceLaunchFailureForTest();
  }
  assert.equal(warned.filter((l) => l.includes('(once)')).length, 1);
});

test('a launcher that cannot even start at the witness run turns the fence off', async () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'fence-missing-')), 'timon-fence');
  const fence = createLandlockFence({ status: () => ({ state: 'ready', binary: missing, abi: 6, seccomp: true }) });
  try {
    await endLaunch(fencedOutcome('missing'), fence, 'timon-fence: cannot apply the Landlock ruleset: Operation not permitted\n', 71);
    const status = hostFenceStatus(fence);
    assert.equal(status.state, 'unsupported');
    assert.ok(status.state === 'unsupported' && /the fence launcher cannot run \(.*ENOENT/.test(status.reason), JSON.stringify(status));
  } finally {
    resetFenceLaunchFailureForTest();
  }
});

test('an altered launcher that fails whatever it runs turns the fence off', { skip: process.platform === 'win32' && 'a stand-in launcher is a shell script' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fence-altered-'));
  const launcher = join(dir, 'timon-fence');
  writeFileSync(launcher, '#!/bin/sh\necho "timon-fence: cannot apply the Landlock ruleset: Operation not permitted" >&2\nexit 71\n');
  chmodSync(launcher, 0o755);
  const fence = createLandlockFence({ status: () => ({ state: 'ready', binary: launcher, abi: 6, seccomp: true }) });
  try {
    await endLaunch(fencedOutcome('altered'), fence, 'timon-fence: cannot apply the Landlock ruleset: Operation not permitted\n', 71);
    assert.deepEqual(hostFenceStatus(fence), { state: 'unsupported', reason: 'timon-fence: cannot apply the Landlock ruleset: Operation not permitted', abi: 0 });
  } finally {
    resetFenceLaunchFailureForTest();
  }
});

test('a witness that gives no answer in time proves nothing: the fence stays on', async () => {
  const fence = fakeFence({ available: true, abi: 6 }, undefined, { ran: false, reason: 'no answer within 5000 ms', timedOut: true });
  await endLaunch(fencedOutcome('slow'), fence, 'timon-fence: cannot apply the Landlock ruleset: Operation not permitted\n', 71);
  assert.equal(fence.witnessed.length, 1);
  assert.equal(hostFenceStatus(fence).state, 'ready');
});

test('a launcher the probe no longer finds is left to the next launch\'s probe, without a witness', async () => {
  let available = true;
  const fence: HostFence & { witnessed: string[] } = {
    ...fakeFence({ available: true, abi: 6 }),
    probe: () => (available ? { available: true, abi: 6 } : { available: false, reason: 'the launcher is gone', abi: 0, tampered: true }),
  };
  available = false;
  await endLaunch(fencedOutcome('gone'), fence, 'timon-fence: cannot apply the Landlock ruleset: Operation not permitted\n', 71);
  assert.deepEqual(fence.witnessed, []);
  available = true;
  assert.equal(hostFenceStatus(fence).state, 'ready', 'a launcher put back is trusted again: nothing sticky was noted');
});

test('launches that end alike at the same time share one witness run', async () => {
  let release: (() => void) | undefined;
  const witnessed: string[] = [];
  const fence: HostFence = {
    ...fakeFence({ available: true, abi: 6 }),
    witness: (policyFile) => {
      witnessed.push(policyFile);
      return new Promise((resolve) => { release = () => resolve(WITNESS_OK); });
    },
  };
  const first = endLaunch(fencedOutcome('pair-1'), fence, 'timon-fence: cannot apply the Landlock ruleset: Operation not permitted\n', 71);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = fencedOutcome('pair-2');
  await endLaunch(second, fence, 'timon-fence: cannot apply the Landlock ruleset: Operation not permitted\n', 71);
  assert.equal(existsSync(second.policyFile), false, 'the second launch does not wait for the first one\'s witness');
  release?.();
  await first;
  assert.equal(witnessed.length, 1);
  assert.equal(hostFenceStatus(fence).state, 'ready');
});

test('a CLI that fails on its own leaves the fence on, without asking the launcher', async () => {
  const fence = fakeFence({ available: true, abi: 6 });
  await endLaunch(fencedOutcome('other'), fence, 'Error: invalid API key\n', 1);
  assert.deepEqual(fence.witnessed, []);
  assert.equal(hostFenceStatus(fence).state, 'ready');
});

test('what a witness run proves', () => {
  assert.equal(fenceWitnessFailure('landlock', { ran: true, status: 0, stderr: '' }), null);
  assert.equal(fenceWitnessFailure('landlock', { ran: true, status: 127, stderr: 'timon-fence: cannot execute /bin/true: No such file or directory' }), null,
    '127 comes after every fence step succeeded');
  assert.equal(fenceWitnessFailure('landlock', { ran: true, status: 78, stderr: 'timon-fence: policy truncated' }), null, 'the daemon\'s bug, not the machine');
  assert.equal(fenceWitnessFailure('landlock', { ran: true, status: 69, stderr: 'timon-fence: Landlock ABI 2 or later is required (found 0)\n' }),
    'timon-fence: Landlock ABI 2 or later is required (found 0)');
  assert.equal(fenceWitnessFailure('landlock', { ran: true, status: 71, stderr: '' }), 'timon-fence exited with 71');
  assert.equal(fenceWitnessFailure('seatbelt', { ran: true, status: 0, stderr: '' }), null);
  assert.equal(fenceWitnessFailure('seatbelt', { ran: true, status: 1, stderr: '' }), 'sandbox-exec exited with 1');
  assert.equal(fenceWitnessFailure('seatbelt', { ran: true, status: 71, stderr: 'sandbox-exec: sandbox_apply: Operation not permitted\n' }),
    'sandbox-exec: sandbox_apply: Operation not permitted');
  assert.equal(fenceWitnessFailure('seatbelt', { ran: false, reason: 'spawn /usr/bin/sandbox-exec ENOENT', timedOut: false }),
    'the fence launcher cannot run (spawn /usr/bin/sandbox-exec ENOENT)');
  assert.equal(fenceWitnessFailure('landlock', { ran: false, reason: 'no answer within 5000 ms', timedOut: true }), null);
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

const FORGING_CLI = String.raw`
process.stderr.write('timon-fence: cannot apply the Landlock ruleset: Operation not permitted\n');
process.exit(71);
`;

test('the real launcher: a fenced CLI that imitates its failure does not turn the fence off', { skip: realSkip }, async () => {
  const runtime = process.env.XDG_RUNTIME_DIR;
  const base = runtime && existsSync(runtime) ? runtime : tmpdir();
  const root = realpathSync(mkdtempSync(join(base, 'fence-forge-')));
  try {
    const home = join(root, 'home');
    const th = join(home, '.timon');
    const cwd = join(th, 'worktrees', 'task-f');
    mkdirSync(cwd, { recursive: true });
    const fence = createLandlockFence({ status: () => ({ state: 'ready', binary: REAL as string, abi: REAL_PROBE?.abi ?? 0, seccomp: true }) });
    fence.probe();
    const target = { timonHome: th, home, cwd, missionId: MISSION, platform: 'linux' as const };
    const launch = fenceMissionCommand(process.execPath, ['-e', FORGING_CLI], 'unit-forge', target, { mode: 'enforce', fence, warn: () => {} });
    assert.ok(launch.fence?.state === 'fenced');
    const child = spawn(launch.cmd, launch.args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    const settled = watchFencedLaunch(child, launch.fence, { fence });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    await settled;
    assert.equal(code, 71, stderr);
    assert.match(stderr, /^timon-fence: cannot apply the Landlock ruleset/, 'the CLI ran inside the fence and printed the forged line');
    assert.equal(fenceLaunchFailure('landlock', code, stderr) !== null, true, 'the old reading would have turned the fence off');
    assert.equal(existsSync(launch.fence.policyFile), false);
    assert.equal(hostFenceStatus(fence).state, 'ready', 'the real launcher applied the fence at its witness run');
    const next = fenceMissionCommand(process.execPath, ['-e', ''], 'unit-forge-2', target, { mode: 'enforce', fence, warn: () => {} });
    assert.equal(next.fence?.state, 'fenced');
  } finally {
    resetFenceLaunchFailureForTest();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the real launcher, run as a witness on a policy, answers 0 or 127 and nothing a failure is read from', { skip: realSkip }, async () => {
  const fence = createLandlockFence({ status: () => ({ state: 'ready', binary: REAL as string, abi: REAL_PROBE?.abi ?? 0, seccomp: true }) });
  fence.probe();
  const launch = fenceMissionCommand('/bin/true', [], 'unit-witness', TARGET, { mode: 'enforce', fence, warn: () => {} });
  assert.ok(launch.fence?.state === 'fenced');
  const witness = await fence.witness(launch.fence.policyFile);
  assert.ok(witness.ran && (witness.status === 0 || witness.status === 127), JSON.stringify(witness));
  assert.equal(fenceWitnessFailure('landlock', witness), null);
  rmSync(launch.fence.policyFile, { force: true });
});

test('what the CLI says before the mission reads its stderr waits for the mission\'s reader', async () => {
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stderr });
  watchFencedLaunch(proc, { state: 'fenced', mechanism: 'landlock', policyFile: join(TH, 'run', 'fence', 'early.policy'), tmpDir: null });
  stderr.write('early line\n');
  await new Promise((resolve) => setImmediate(resolve));
  let read = '';
  stderr.on('data', (chunk: Buffer) => { read += chunk.toString(); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(read, 'early line\n');
  proc.emit('close', 0);
});

test('the log says a missing fence once per cause, an altered package at every launch', () => {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (line: string) => { lines.push(line); };
  try {
    const missing = fakeFence({ available: false, reason: 'kernel without Landlock (once)', abi: 0 });
    const altered = fakeFence({ available: false, reason: 'the launcher is missing (every time)', abi: 0, tampered: true });
    for (let i = 0; i < 3; i += 1) fenceMissionCommand('/usr/bin/claude', [], 'u', TARGET, { mode: 'auto', fence: missing });
    for (let i = 0; i < 2; i += 1) fenceMissionCommand('/usr/bin/claude', [], 'u', TARGET, { mode: 'auto', fence: altered });
  } finally {
    console.warn = original;
  }
  assert.equal(lines.filter((l) => l.includes('(once)')).length, 1);
  assert.equal(lines.filter((l) => l.includes('(every time)')).length, 2);
});
