import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  daemonEnv, fallbackLog, parseLauncherConfig, runLauncher, WINDOWS_LAUNCHER_FORMAT, WITNESS_RETRY_SECONDS, windowsPowershell, type WindowsLauncherConfig,
} from './windows-service-launcher.js';

function config(dir: string, over: Partial<WindowsLauncherConfig> = {}): WindowsLauncherConfig {
  return {
    format: WINDOWS_LAUNCHER_FORMAT,
    node: process.execPath,
    args: ['-e', 'console.log("from stdout " + process.env.TIMON_PROBE); console.error("from stderr"); process.exit(3)'],
    cwd: dir,
    env: { TIMON_PROBE: 'set-by-the-config' },
    log: join(dir, 'tmp', 'daemon.log'),
    rotateBytes: 1024,
    witness: { file: join(dir, 'run', 'session-witness.dpapi'), args: ['-NoProfile', '-Command', 'exit 0'] },
    ...over,
  };
}

test('the launcher starts the daemon on daemon.log, output and errors appended, once the witness opens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-launcher-'));
  const c = config(dir);
  const code = await runLauncher(c, { checkWitness: () => ({ code: 0, stderr: '' }) });
  assert.equal(code, 0, 'the batch it replaces ended on 0 once its daemon had exited');
  const log = readFileSync(c.log, 'utf8');
  // What `>>daemon.log 2>&1` did, with the configuration's environment.
  assert.match(log, /from stdout set-by-the-config/);
  assert.match(log, /from stderr/);
  const lines = log.split('\n');
  const start = lines.findIndex((line) => /^\[timon-service\] \S+ starting the daemon$/.test(line));
  const exit = lines.findIndex((line) => /^\[timon-service\] \S+ daemon exited with code 3$/.test(line));
  assert.ok(start >= 0 && exit > start, log);
});

test('a witness that does not open yet is waited on, said once, then the daemon starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-launcher-'));
  const answers = [1, 1, 1, 0];
  const slept: number[] = [];
  let started = 0;
  const code = await runLauncher(config(dir), {
    checkWitness: () => ({ code: answers.shift() ?? 0, stderr: 'CryptographicException: Key not\r\n valid for use in specified state.' }),
    sleep: async (ms) => { slept.push(ms); },
    runDaemon: async () => { started += 1; return 0; },
  });
  assert.equal(code, 0);
  assert.equal(started, 1);
  assert.deepEqual(slept, [WITNESS_RETRY_SECONDS * 1000, WITNESS_RETRY_SECONDS * 1000, WITNESS_RETRY_SECONDS * 1000]);
  const log = readFileSync(config(dir).log, 'utf8');
  assert.equal(log.match(/session witness unreadable: CryptographicException: Key not valid for use in specified state\./g)?.length, 1, log);
  assert.equal(log.match(/waiting for the first logon since boot/g)?.length, 1, log);
});

test('a missing witness is refused, never skipped: no daemon, exit 2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-launcher-'));
  let started = false;
  const code = await runLauncher(config(dir), {
    checkWitness: () => ({ code: 2, stderr: '' }),
    runDaemon: async () => { started = true; return 0; },
  });
  assert.equal(code, 2);
  assert.equal(started, false);
  assert.match(readFileSync(config(dir).log, 'utf8'), /session witness missing, reinstall the service/);
});

test('a check that cannot run keeps the daemon waiting, and says why', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-launcher-'));
  const answers: Array<{ code: number | null; stderr: string; error?: Error }> = [
    { code: null, stderr: '', error: new Error('spawn powershell.exe ENOENT') }, { code: 0, stderr: '' }];
  await runLauncher(config(dir), { checkWitness: () => answers.shift()!, sleep: async () => {}, runDaemon: async () => 0 });
  assert.match(readFileSync(config(dir).log, 'utf8'), /session witness unreadable: the check could not run: spawn powershell\.exe ENOENT/);
});

test('a log past its limit is moved aside at start, once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-launcher-'));
  const c = config(dir);
  await runLauncher(c, { checkWitness: () => ({ code: 0, stderr: '' }), runDaemon: async () => 0 });
  writeFileSync(c.log, 'x'.repeat(2048));
  await runLauncher(c, { checkWitness: () => ({ code: 0, stderr: '' }), runDaemon: async () => 0 });
  assert.equal(readFileSync(`${c.log}.1`, 'utf8'), 'x'.repeat(2048));
  assert.doesNotMatch(readFileSync(c.log, 'utf8'), /x{10}/);
});

test('the configuration is validated, and its refusal names the file and the command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-launcher-'));
  const good = config(dir);
  assert.deepEqual(parseLauncherConfig(JSON.stringify(good), 'cfg.json'), good);
  assert.throws(() => parseLauncherConfig('{', 'cfg.json'), /cfg\.json is not valid JSON/);
  assert.throws(() => parseLauncherConfig(JSON.stringify({ ...good, format: 2 }), 'cfg.json'), /cfg\.json is not a Timon service configuration \(format\).*timon service install/);
  assert.throws(() => parseLauncherConfig(JSON.stringify({ ...good, env: { 'A B': '1' } }), 'cfg.json'), /env/);
  assert.equal(existsSync(good.log), false, 'parsing writes nothing');
});

test('PowerShell is named by its full path, the task\'s PATH being whatever it was at start', () => {
  assert.equal(windowsPowershell({ SystemRoot: 'C:\\Windows' }).replace(/\//g, '\\'), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(windowsPowershell({}), 'powershell.exe');
  assert.equal(fallbackLog(join('h', 'run', 'timon-service.json')), join('h', 'tmp', 'daemon.log'));
});

test('the daemon never inherits Electron\'s Node flag; only the configuration sets it', () => {
  assert.deepEqual(daemonEnv({ PATH: 'p', electron_run_as_node: '1' }, { TIMON_HOME: 'h' }), { PATH: 'p', TIMON_HOME: 'h' });
  assert.equal(daemonEnv({ ELECTRON_RUN_AS_NODE: '1' }, { ELECTRON_RUN_AS_NODE: '1' }).ELECTRON_RUN_AS_NODE, '1');
});
