/**
 * The silent installation of a verified update (docs/AUTO-UPDATE.md §10,
 * volet F): which command each system gets, that nothing from the network is
 * ever part of a program text, and how each refusal falls back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHECKSUM_EXIT, MAC_ADMIN_SCRIPT, NSIS_SILENT_ARGS, ROOT_INSTALL_SCRIPT, WINDOWS_WATCHER,
  debCommand, debOutcome, macCommand, macOutcome, silentInstall, windowsCommand,
  type Command, type CommandResult, type InstallerSystem,
} from './update-installer.js';

const SHA = 'a'.repeat(64);
// Everything a hostile name could try on each shell: none of it may reach a program text.
const HOSTILE = `Timon Setup 'x' "y" $(id) \`id\` ; & | %PATH% !z`;

function fakeSystem(platform: NodeJS.Platform, overrides: Partial<InstallerSystem> = {}) {
  const ran: Command[] = [];
  const detached: Command[] = [];
  const system: InstallerSystem = {
    platform,
    env: { SystemRoot: 'D:\\Win', ELECTRON_RUN_AS_NODE: '1', TIMON_HOME: 'C:\\Users\\Ana\\.timon' },
    appExe: platform === 'win32' ? 'C:\\Users\\Ana\\AppData\\Local\\Programs\\Timon\\Timon.exe' : '/opt/Timon/timon-desktop',
    executable: () => true,
    run: async (command) => { ran.push(command); return { code: 0, stderr: '' }; },
    spawnDetached: async (command) => { detached.push(command); },
    ...overrides,
  };
  return { system, ran, detached };
}

test('Windows: a detached PowerShell watcher, by absolute path, runs the installer with the silent update flags', async () => {
  const path = `C:\\Users\\Ana\\.timon\\updates\\0.1.9\\${HOSTILE}.exe`;
  const { system, detached, ran } = fakeSystem('win32');
  assert.deepEqual(await silentInstall({ format: 'nsis', path, sha256: SHA, prompt: '' }, system), { status: 'handed_over' });
  assert.deepEqual(ran, []);
  const [command] = detached;
  assert.equal(command!.file, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  // I6 of audit-packaged-os: no profile, no prompt, no policy in the way.
  assert.deepEqual(command!.args.slice(0, 7), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand']);
  const script = Buffer.from(command!.args[7]!, 'base64').toString('utf16le');
  assert.equal(script, WINDOWS_WATCHER);
  assert.ok(!script.includes(path) && !script.includes('Ana'), 'the path travels in the environment only');
  assert.equal(command!.env!.TIMON_UPDATE_INSTALLER, path);
  assert.equal(command!.env!.TIMON_UPDATE_SHA256, SHA);
  assert.equal(command!.env!.TIMON_UPDATE_APP, system.appExe);
  assert.equal(command!.env!.ELECTRON_RUN_AS_NODE, undefined, 'Timon started again is the application, never Node');
  assert.equal(command!.env!.TIMON_HOME, 'C:\\Users\\Ana\\.timon');
  assert.equal(command!.cwd, 'C:\\Users\\Ana\\.timon\\updates\\0.1.9', 'never inside the folder being replaced');
});

test('Windows: the watcher hashes the file it holds, starts it with the flags, and starts Timon again when nothing runs', () => {
  assert.deepEqual([...NSIS_SILENT_ARGS], ['/S', '--updated', '--force-run', '--timon-app-update']);
  assert.ok(WINDOWS_WATCHER.includes(`$info.Arguments = '/S --updated --force-run --timon-app-update'`));
  // Read-only sharing from the hash to the installer's exit: nothing rewrites or renames it in between.
  const hold = WINDOWS_WATCHER.indexOf('[IO.FileShare]::Read)');
  const hash = WINDOWS_WATCHER.indexOf('ComputeHash($hold)');
  const start = WINDOWS_WATCHER.indexOf('[Diagnostics.Process]::Start($info)');
  const release = WINDOWS_WATCHER.indexOf('$hold.Dispose()');
  assert.ok(hold > 0 && hold < hash && hash < start && start < WINDOWS_WATCHER.indexOf('WaitForExit()') && WINDOWS_WATCHER.indexOf('WaitForExit()') < release);
  assert.match(WINDOWS_WATCHER, /\$actual -ne \$env:TIMON_UPDATE_SHA256\) \{ throw/);
  // Literal paths: no wildcard or provider interpretation of what comes from the environment.
  assert.doesNotMatch(WINDOWS_WATCHER, /Start-Process|Invoke-Expression|iex /);
  assert.match(WINDOWS_WATCHER, /\$running\.Count -eq 0 -and \[IO\.File\]::Exists\(\$app\)/);
  assert.match(WINDOWS_WATCHER, /SessionId -eq \$session/, 'only a Timon of this session counts');
});

test('macOS: the administrator prompt runs root\'s script; the file, its hash and the prompt are arguments, never script', async () => {
  const path = `/Users/ana/.timon/updates/0.1.9/${HOSTILE}.pkg`;
  const prompt = 'Timon needs your password to install version 0.1.9.';
  const { system, ran } = fakeSystem('darwin');
  assert.deepEqual(await silentInstall({ format: 'pkg', path, sha256: SHA, prompt }, system), { status: 'installed' });
  const [command] = ran;
  assert.deepEqual(command, macCommand({ path, sha256: SHA, prompt }));
  assert.equal(command!.file, '/usr/bin/osascript');
  const lines = MAC_ADMIN_SCRIPT.flatMap((line) => ['-e', line]);
  assert.deepEqual(command!.args.slice(0, lines.length), lines);
  assert.deepEqual(command!.args.slice(lines.length), [ROOT_INSTALL_SCRIPT, path, SHA, prompt]);
  for (const line of MAC_ADMIN_SCRIPT) assert.ok(!line.includes('Users'), 'no value inside the AppleScript');
  // Each value reaches the shell quoted by AppleScript itself.
  assert.match(MAC_ADMIN_SCRIPT[1]!, /quoted form of \(item 1 of argv\).*quoted form of \(item 2 of argv\).*quoted form of \(item 3 of argv\).*with prompt \(item 4 of argv\) with administrator privileges/);
});

test('Linux: pkexec runs root\'s script with apt-get, or dpkg on a system without apt', async () => {
  const path = `/home/ana/.timon/updates/0.1.9/${HOSTILE}.deb`;
  const { system, ran } = fakeSystem('linux');
  assert.deepEqual(await silentInstall({ format: 'deb', path, sha256: SHA, prompt: 'ignored' }, system), { status: 'installed' });
  assert.deepEqual(ran[0], { file: '/usr/bin/pkexec', args: ['/bin/sh', '-c', ROOT_INSTALL_SCRIPT, 'timon-update', path, SHA, 'apt'], cwd: '/home/ana/.timon/updates/0.1.9' });
  const noApt = fakeSystem('linux', { executable: (p) => !p.endsWith('apt-get') });
  await silentInstall({ format: 'deb', path, sha256: SHA, prompt: '' }, noApt.system);
  assert.equal(noApt.ran[0]!.args.at(-1), 'dpkg');
  assert.deepEqual(debCommand({ path, sha256: SHA, pkexec: '/bin/pkexec', apt: false }).file, '/bin/pkexec');
});

test('root\'s script installs only a copy that hashes to the signed sha256, whatever the file name', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon silent '));
  const file = join(dir, `${HOSTILE}.deb`);
  writeFileSync(file, 'a verified package');
  const good = createHash('sha256').update('a verified package').digest('hex');
  const run = (sha: string, how: string) => spawnSync('/bin/sh', ['-c', ROOT_INSTALL_SCRIPT, 'timon-update', file, sha, how], { encoding: 'utf8' });
  // A wrong hash stops before any installer runs; the right one reaches the dispatch (64 = no such installer).
  assert.equal(run('b'.repeat(64), 'dpkg').status, CHECKSUM_EXIT);
  assert.equal(run(good, 'neither').status, 64);
  assert.equal(run(`${good}; touch pwned`, 'neither').status, CHECKSUM_EXIT);
});

test('a dismissed prompt is a cancel, not an error; a refusal or a failure falls back', () => {
  const r = (code: number | null, stderr = ''): CommandResult => ({ code, stderr });
  assert.deepEqual(macOutcome(r(0)), { status: 'installed' });
  assert.deepEqual(macOutcome(r(1, '0:250: execution error: User canceled. (-128)\n')), { status: 'cancelled' });
  assert.equal(macOutcome(r(1, 'execution error: installer: Error - the package path specified was invalid. (1)')).status, 'failed');
  assert.match((macOutcome(r(1, `execution error:  (${CHECKSUM_EXIT})`)) as { reason: string }).reason, /changed/);
  assert.deepEqual(debOutcome(r(0)), { status: 'installed' });
  assert.deepEqual(debOutcome(r(126)), { status: 'cancelled' });
  assert.equal(debOutcome(r(127, 'Error executing command as another user: No authentication agent found.')).status, 'unavailable');
  assert.match((debOutcome(r(CHECKSUM_EXIT)) as { reason: string }).reason, /changed/);
  assert.equal(debOutcome(r(100, 'E: Could not get lock /var/lib/dpkg/lock-frontend.')).status, 'failed');
  assert.equal(debOutcome(r(null)).status, 'failed');
});

test('no tool, a program that cannot start, a bad checksum or another system: never silent', async () => {
  const deb = { format: 'deb' as const, path: '/home/ana/u.deb', sha256: SHA, prompt: '' };
  assert.equal((await silentInstall(deb, fakeSystem('linux', { executable: () => false }).system)).status, 'unavailable');
  const enoent = fakeSystem('linux', { run: async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); } });
  assert.equal((await silentInstall(deb, enoent.system)).status, 'unavailable');
  const noPowershell = fakeSystem('win32', { executable: () => false });
  assert.equal((await silentInstall({ format: 'nsis', path: 'C:\\u.exe', sha256: SHA, prompt: '' }, noPowershell.system)).status, 'unavailable');
  assert.deepEqual(noPowershell.detached, []);
  const spawnFails = fakeSystem('win32', { spawnDetached: async () => { throw new Error('EPERM'); } });
  assert.deepEqual(await silentInstall({ format: 'nsis', path: 'C:\\u.exe', sha256: SHA, prompt: '' }, spawnFails.system), { status: 'unavailable', reason: 'EPERM' });
  const other = fakeSystem('linux');
  assert.equal((await silentInstall({ ...deb, format: 'pkg' }, other.system)).status, 'unavailable');
  assert.equal((await silentInstall({ ...deb, sha256: 'not-a-hash' }, other.system)).status, 'failed');
  assert.equal((await silentInstall({ ...deb, path: 'u.deb' }, other.system)).status, 'failed');
  assert.deepEqual(other.ran, []);
});

test('the watcher is detached and never runs from the install folder', () => {
  const command = windowsCommand({ path: 'C:\\Users\\Ana\\.timon\\updates\\0.1.9\\Timon Setup 0.1.9.exe', sha256: SHA, appExe: 'C:\\Program Files\\Timon\\Timon.exe', env: {} });
  assert.equal(command.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(command.cwd, 'C:\\Users\\Ana\\.timon\\updates\\0.1.9');
});
