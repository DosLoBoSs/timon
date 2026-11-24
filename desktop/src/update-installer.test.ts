/**
 * The silent installation of a verified update (docs/AUTO-UPDATE.md §10,
 * volet F): which command each system gets, that nothing from the network is
 * ever part of a program text, and how each refusal falls back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHECKSUM_EXIT, MAC_ADMIN_SCRIPT, NSIS_SERVICE_PAUSE_FAILED, NSIS_SERVICE_STILL_RUNNING, NSIS_SILENT_ARGS, ROOT_INSTALL_SCRIPT, WINDOWS_NOT_STARTED, WINDOWS_RESULT_FILE,
  WINDOWS_LAUNCHER, WINDOWS_LAUNCH_CANCELLED, WINDOWS_LAUNCH_STANDARD_ACCOUNT, WINDOWS_WATCHER, debCommand, debOutcome, macCommand,
  macOutcome, silentInstall, takeWindowsInstallFailure, windowHandle, windowsCommand, windowsInstallFailureReason, windowsOutcome,
  windowsResultFile, windowsWatcherScript,
  type Command, type CommandResult, type InstallerSystem,
} from './update-installer.js';

const SHA = 'a'.repeat(64);
// Everything a hostile name could try on each shell: none of it may reach a program text.
const HOSTILE = `Timon Setup 'x' "y" $(id) \`id\` ; & | %PATH% !z`;

function fakeSystem(platform: NodeJS.Platform, overrides: Partial<InstallerSystem> = {}) {
  const ran: Command[] = [];
  const system: InstallerSystem = {
    platform,
    env: { SystemRoot: 'D:\\Win', ELECTRON_RUN_AS_NODE: '1', TIMON_HOME: 'C:\\Users\\Ana\\.timon' },
    appExe: platform === 'win32' ? 'C:\\Users\\Ana\\AppData\\Local\\Programs\\Timon\\Timon.exe' : '/opt/Timon/timon-desktop',
    executable: () => true,
    run: async (command) => { ran.push(command); return { code: 0, stderr: '' }; },
    ownerWindow: () => '197322',
    ...overrides,
  };
  return { system, ran };
}

/** The values `windowsWatcherScript` put in front of the watcher, decoded as PowerShell would. */
function watcherValues(script: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of script.split('\n')) {
    const literal = /^\$(installer|app|result) = \[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('([A-Za-z0-9+/=]*)'\)\)$/.exec(line);
    if (literal) values[literal[1]!] = Buffer.from(literal[2]!, 'base64').toString('utf8');
    const sha = /^\$sha = '([a-f0-9]{64})'$/.exec(line);
    if (sha) values.sha = sha[1]!;
  }
  return values;
}

test('Windows: the shell waits for a PowerShell launcher, by absolute path, which starts the elevated watcher', async () => {
  const path = `C:\\Users\\Ana\\.timon\\updates\\0.1.9\\${HOSTILE}.exe`;
  const { system, ran } = fakeSystem('win32');
  assert.deepEqual(await silentInstall({ format: 'nsis', path, sha256: SHA, prompt: '' }, system), { status: 'handed_over' });
  assert.equal(ran.length, 1, 'run to completion: the shell is still open while the permission is asked');
  const [command] = ran;
  assert.equal(command!.file, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  // I6 of audit-packaged-os: no profile, no prompt, no policy in the way.
  assert.deepEqual(command!.args.slice(0, 7), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand']);
  assert.equal(Buffer.from(command!.args[7]!, 'base64').toString('utf16le'), WINDOWS_LAUNCHER);
  const env = command!.env!;
  assert.equal(env.TIMON_UPDATE_POWERSHELL, command!.file, 'the elevated watcher runs on the same system PowerShell');
  assert.equal(env.TIMON_UPDATE_OWNER, '197322', 'the prompt is owned by the window the person clicked in');
  assert.equal(env.TIMON_UPDATE_DIR, 'C:\\Users\\Ana\\.timon\\updates\\0.1.9', 'never inside the folder being replaced');
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined, 'nothing started from here is Node');
  assert.equal(env.TIMON_HOME, 'C:\\Users\\Ana\\.timon');
  assert.equal(command!.cwd, 'C:\\Users\\Ana\\.timon\\updates\\0.1.9');
  // The elevated command line: the same flags, then the watcher with its values as base64 literals.
  const elevated = env.TIMON_UPDATE_ELEVATED!.split(' ');
  assert.deepEqual(elevated.slice(0, 7), [...command!.args.slice(0, 7)]);
  assert.equal(elevated.length, 8);
  const script = Buffer.from(elevated[7]!, 'base64').toString('utf16le');
  assert.ok(script.endsWith(WINDOWS_WATCHER));
  assert.ok(!script.includes(path) && !script.includes('Ana'), 'no character of a name reaches the program text');
  assert.deepEqual(watcherValues(script), {
    installer: path,
    sha: SHA,
    app: system.appExe,
    result: `C:\\Users\\Ana\\.timon\\updates\\0.1.9\\${WINDOWS_RESULT_FILE}`,
  });
});

test('Windows: only a granted permission lets the shell quit', async () => {
  const input = { format: 'nsis' as const, path: 'C:\\u\\Timon Setup 0.1.9.exe', sha256: SHA, prompt: '' };
  const outcome = async (code: number | null, stderr = '') => silentInstall(input, fakeSystem('win32', { run: async () => ({ code, stderr }) }).system);
  assert.deepEqual(await outcome(0), { status: 'handed_over' });
  assert.deepEqual(await outcome(WINDOWS_LAUNCH_CANCELLED), { status: 'cancelled' }, 'a "No" on the prompt keeps Timon open');
  const standard = await outcome(WINDOWS_LAUNCH_STANDARD_ACCOUNT);
  assert.equal(standard.status, 'unavailable', 'a standard account gets the visible installer');
  assert.deepEqual(await outcome(1, 'Access is denied.\r\n'), { status: 'failed', reason: 'Access is denied.' });
  assert.equal((await outcome(null)).status, 'failed');
  assert.deepEqual(windowsOutcome({ code: 0, stderr: '' }), { status: 'handed_over' });
});

test('Windows: the launcher checks the account, asks for the permission owned by the window, and tells a refusal apart', () => {
  const admin = WINDOWS_LAUNCHER.indexOf("Select-String -SimpleMatch 'S-1-5-32-544')) { exit 3 }");
  const runas = WINDOWS_LAUNCHER.indexOf("$info.Verb = 'runas'");
  assert.ok(admin > 0 && admin < runas, 'a standard account is sent to the installer before any prompt');
  assert.ok(WINDOWS_LAUNCHER.includes("[IO.Path]::Combine($env:SystemRoot, 'System32', 'whoami.exe')"), 'whoami by absolute path');
  assert.ok(WINDOWS_LAUNCHER.includes('$info.ErrorDialog = $true; $info.ErrorDialogParentHandle = [IntPtr][Int64]$env:TIMON_UPDATE_OWNER'));
  assert.ok(WINDOWS_LAUNCHER.includes('$info.Arguments = $env:TIMON_UPDATE_ELEVATED'));
  assert.match(WINDOWS_LAUNCHER, /NativeErrorCode -eq 1223\) \{ exit 4 \}/, 'ERROR_CANCELLED is the person saying no');
  assert.doesNotMatch(WINDOWS_LAUNCHER, /Start-Process|Invoke-Expression|iex /);
});

test('Windows: the owner window is a plain number or nothing', () => {
  const base = { path: 'C:\\u\\Timon Setup 0.1.9.exe', sha256: SHA, appExe: 'C:\\Timon\\Timon.exe' };
  assert.equal(windowsCommand({ ...base, env: { TIMON_UPDATE_OWNER: '12' }, owner: null }).env!.TIMON_UPDATE_OWNER, undefined, 'never inherited');
  assert.equal(windowsCommand({ ...base, env: {}, owner: '1; calc' }).env!.TIMON_UPDATE_OWNER, undefined);
  assert.equal(windowsCommand({ ...base, env: {}, owner: '4242' }).env!.TIMON_UPDATE_OWNER, '4242');
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(0x2_0a_3cn);
  assert.equal(windowHandle(handle), String(0x2_0a_3c));
  const short = Buffer.alloc(4);
  short.writeUInt32LE(77);
  assert.equal(windowHandle(short), '77');
  assert.equal(windowHandle(Buffer.alloc(8)), null);
  assert.equal(windowHandle(Buffer.alloc(2)), null);
  assert.equal(windowHandle(undefined), null);
  assert.throws(() => windowsWatcherScript({ installer: 'C:\\u.exe', sha256: "a' ; calc", app: 'C:\\t.exe', result: 'C:\\r.txt' }));
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
  assert.match(WINDOWS_WATCHER, /\$actual -ne \$sha\) \{ throw/);
  // Literal paths: no wildcard or provider interpretation of what comes from the environment.
  assert.doesNotMatch(WINDOWS_WATCHER, /Start-Process|Invoke-Expression|iex /);
  assert.match(WINDOWS_WATCHER, /\$running\.Count -eq 0 -and \[IO\.File\]::Exists\(\$app\)/);
  assert.match(WINDOWS_WATCHER, /SessionId -eq \$session/, 'only a Timon of this session counts');
  // Elevated: Timon started again goes through Explorer, which starts it as the person.
  assert.ok(WINDOWS_WATCHER.includes("$again.FileName = [IO.Path]::Combine($env:SystemRoot, 'explorer.exe')"));
  assert.doesNotMatch(WINDOWS_WATCHER, /\$env:TIMON_UPDATE_/, 'an elevated process does not get the shell\'s environment');
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
  assert.deepEqual(noPowershell.ran, []);
  const spawnFails = fakeSystem('win32', { run: async () => { throw new Error('EPERM'); } });
  assert.deepEqual(await silentInstall({ format: 'nsis', path: 'C:\\u.exe', sha256: SHA, prompt: '' }, spawnFails.system), { status: 'unavailable', reason: 'EPERM' });
  const other = fakeSystem('linux');
  assert.equal((await silentInstall({ ...deb, format: 'pkg' }, other.system)).status, 'unavailable');
  assert.equal((await silentInstall({ ...deb, sha256: 'not-a-hash' }, other.system)).status, 'failed');
  assert.equal((await silentInstall({ ...deb, path: 'u.deb' }, other.system)).status, 'failed');
  assert.deepEqual(other.ran, []);
});

test('the launcher never runs from the install folder', () => {
  const command = windowsCommand({ path: 'C:\\Users\\Ana\\.timon\\updates\\0.1.9\\Timon Setup 0.1.9.exe', sha256: SHA, appExe: 'C:\\Program Files\\Timon\\Timon.exe', env: {} });
  assert.equal(command.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(command.cwd, 'C:\\Users\\Ana\\.timon\\updates\\0.1.9');
});

// 0.1.7 to 0.1.8 update: the installer went on over a daemon it had not ended.
// It now stops with a code of its own, silently under /S: the watcher is the
// only witness, and the shell had quit.
test('Windows: the watcher writes how the installer ended, unless it ended well', () => {
  const started = WINDOWS_WATCHER.indexOf('[Diagnostics.Process]::Start($info)');
  const waited = WINDOWS_WATCHER.indexOf('$process.WaitForExit()');
  const read = WINDOWS_WATCHER.indexOf('$outcome = [string]$process.ExitCode');
  const written = WINDOWS_WATCHER.indexOf("if ($result -and $outcome -ne '0') { try { [IO.File]::WriteAllText($result, $outcome) } catch { } }");
  assert.ok(started > 0 && started < waited && waited < read && read < written, WINDOWS_WATCHER);
  assert.ok(written < WINDOWS_WATCHER.indexOf('Start-Sleep -Seconds 5'), 'written before Timon is started again, which reads it');
  // An installer that never ran (changed bytes, a start Windows refused) is said too, and a stale verdict is not kept.
  assert.ok(WINDOWS_WATCHER.includes(`$outcome = '${WINDOWS_NOT_STARTED}'`));
  const cleared = WINDOWS_WATCHER.indexOf('if ($result) { try { [IO.File]::Delete($result) } catch { } }');
  assert.ok(cleared > 0 && cleared < started);
  assert.equal(windowsResultFile('D:\\Data\\updates\\0.1.9\\Timon Setup 0.1.9.exe'), `D:\\Data\\updates\\0.1.9\\${WINDOWS_RESULT_FILE}`);
});

test('Windows: the next launch reports the installer\'s failure code once, and says what to do', () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-updates-'));
  assert.equal(takeWindowsInstallFailure(root), null);
  assert.equal(takeWindowsInstallFailure(join(root, 'absent')), null);
  const dir = join(root, '0.1.9');
  mkdirSync(dir);
  const file = join(dir, WINDOWS_RESULT_FILE);

  writeFileSync(file, `${NSIS_SERVICE_STILL_RUNNING}\r\n`);
  const failure = takeWindowsInstallFailure(root);
  assert.deepEqual(failure, { version: '0.1.9', outcome: '5', reason: windowsInstallFailureReason('5') });
  assert.match(failure!.reason, /still running in the background.*nothing was installed.*permission prompt.*restart the computer/);
  assert.equal(existsSync(file), false, 'said once');
  assert.equal(takeWindowsInstallFailure(root), null);

  // The installer that could not run its check stopped too, and says something else to do.
  writeFileSync(file, String(NSIS_SERVICE_PAUSE_FAILED));
  const unchecked = takeWindowsInstallFailure(root);
  assert.deepEqual(unchecked, { version: '0.1.9', outcome: '6', reason: windowsInstallFailureReason('6') });
  assert.match(unchecked!.reason, /could not check that Timon was stopped.*nothing was installed.*restart the computer/);
  assert.notEqual(unchecked!.reason, windowsInstallFailureReason(String(NSIS_SERVICE_STILL_RUNNING)));

  writeFileSync(file, WINDOWS_NOT_STARTED);
  assert.match(takeWindowsInstallFailure(root)!.reason, /could not be started/);
  writeFileSync(file, '2');
  assert.match(takeWindowsInstallFailure(root)!.reason, /ended with code 2/);
  // Only an exit code or the watcher's own word is ever shown: the file sits in a folder the user can write.
  writeFileSync(file, 'Run this: <script>');
  assert.equal(takeWindowsInstallFailure(root), null);
  assert.equal(existsSync(file), false);
});
