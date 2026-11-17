import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, win32 } from 'node:path';

/**
 * The silent installation of a verified update, from inside the app
 * (docs/AUTO-UPDATE.md §10, volet F), without any certificate:
 *
 *  - Windows: the NSIS installer runs with `/S --updated --force-run`, from a
 *    detached watcher; the shell quits, and the installer starts the new
 *    Timon itself (`--force-run`). Every OS command of this file lives here.
 *  - macOS: `installer -pkg … -target /` behind the system's administrator
 *    prompt (`osascript … with administrator privileges`).
 *  - Linux `.deb`: `pkexec`, then `apt-get` (or `dpkg` without apt).
 *
 * The bytes were verified by the shell; they are verified once more by the
 * process that installs them, at the last moment and out of the user's reach:
 * root copies the file into a folder it alone can write, hashes the copy and
 * installs that copy (macOS, Linux); on Windows the watcher holds the file
 * open with read-only sharing, hashes it and starts it while nothing can
 * replace it. A file swapped after the shell's check is therefore never run
 * with the rights the person granted for an update.
 *
 * Nothing from the network is ever interpreted by a shell: every program text
 * below is a constant, and the file, its sha256 and the prompt reach it as
 * arguments (`$1`, `item 1 of argv`) or environment variables.
 *
 * Anything that does not end in an installation answers `cancelled` (the
 * person dismissed the prompt: nothing to report) or `unavailable` / `failed`
 * (with a reason for the log): the caller then falls back to the assisted
 * flow, which opens the installer for the person.
 */

export type SilentFormat = 'nsis' | 'pkg' | 'deb';

export type SilentOutcome =
  /** macOS, Linux: the new version is installed; the shell restarts into it. */
  | { status: 'installed' }
  /** Windows: the watcher runs the silent installer; the shell must quit now, the installer starts Timon again. */
  | { status: 'handed_over' }
  /** The person dismissed the system's password prompt: the verified file stays ready. */
  | { status: 'cancelled' }
  /** No tool to install silently on this machine (no pkexec, no PowerShell). */
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; reason: string };

export type Command = { file: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string };

export type CommandResult = { code: number | null; stderr: string };

export type InstallerSystem = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** The running shell's executable: started again on Windows when the installer leaves no Timon running. */
  appExe: string;
  /** An executable file at this path. */
  executable: (path: string) => boolean;
  /** Runs to completion; never rejects for a non-zero exit, only when the program cannot start. */
  run: (command: Command) => Promise<CommandResult>;
  /** Starts a process that outlives this one; resolves once it runs. */
  spawnDetached: (command: Command) => Promise<void>;
};

export type SilentInput = {
  format: SilentFormat;
  /** The verified file, in Timon's data folder. */
  path: string;
  sha256: string;
  /** The line the macOS administrator prompt shows, in the person's language. */
  prompt: string;
};

const SHA256 = /^[a-f0-9]{64}$/;

/**
 * The flags the downloaded NSIS installer runs with. `/S` and the two
 * double-dash flags are electron-builder 25's (`NsisTarget.js` turns
 * `updated` and `force-run` into `isUpdated` / `isForceRun`): pages skipped,
 * the previous install mode and folder reused (`initMultiUser` reads them from
 * the registry, a per-machine install elevates by itself), the application
 * started once installed. `--timon-app-update` is ours (`installer.nsh`): it
 * lets the installer pause the Timon service under `/S`, which it never does
 * for an unattended install.
 */
export const NSIS_SILENT_ARGS = ['/S', '--updated', '--force-run', '--timon-app-update'] as const;

/** Exit status of the root scripts below when the copy does not hash to the signed sha256. */
export const CHECKSUM_EXIT = 65;

/**
 * Exit status of the NSIS installer when something of Timon still ran after
 * its service pause (`TIMON_SERVICE_STILL_RUNNING` in `installer.nsh`): it
 * replaced nothing, since a daemon left alive keeps the port and the new
 * version cannot start. `packaging.test.ts` holds the two together.
 */
export const NSIS_SERVICE_STILL_RUNNING = 5;

/**
 * Exit status of the NSIS installer when its service pause did not run to its
 * verdict (`TIMON_SERVICE_PAUSE_FAILED` in `installer.nsh`): Windows would not
 * start PowerShell, or the script ended on an error. Nothing checked that the
 * daemon was gone, so the installer replaced nothing either.
 */
export const NSIS_SERVICE_PAUSE_FAILED = 6;

/** Written by the Windows watcher beside the installer when it did not end with 0; the next launch reads it. */
export const WINDOWS_RESULT_FILE = 'install-result.txt';
/** What the watcher writes when the installer never ran: its bytes changed, or Windows would not start it. */
export const WINDOWS_NOT_STARTED = 'not-started';

/**
 * Windows watcher, run by PowerShell from a constant text: the installer, its
 * sha256 and Timon's executable come from the environment, as strings that
 * are never parsed. The file is held with read-only sharing from its hash
 * until the installer has exited, so nothing can rewrite or rename it in
 * between. Once the installer is done, if no Timon runs in this session (a
 * refused elevation, a failed install), the installed Timon is started again:
 * the person is never left without the app.
 *
 * A silent installer says nothing on screen, and this shell has quit by then:
 * the watcher writes how the installer ended to `TIMON_UPDATE_RESULT` unless
 * it ended with 0, and the Timon that starts next reports it
 * (`takeWindowsInstallFailure`). Without that, an update the installer refused
 * (the previous service could not be stopped) only looked like an app that
 * closed and opened again on the same version.
 */
export const WINDOWS_WATCHER = [
  "$ErrorActionPreference = 'Stop'",
  '$installer = $env:TIMON_UPDATE_INSTALLER',
  '$app = $env:TIMON_UPDATE_APP',
  '$result = $env:TIMON_UPDATE_RESULT',
  `$outcome = '${WINDOWS_NOT_STARTED}'`,
  // An earlier attempt's verdict must not be read as this one's.
  'if ($result) { try { [IO.File]::Delete($result) } catch { } }',
  '$hold = $null',
  'try {',
  '  $hold = [IO.File]::Open($installer, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)',
  '  $digest = [Security.Cryptography.SHA256]::Create().ComputeHash($hold)',
  "  $actual = -join ($digest | ForEach-Object { $_.ToString('x2') })",
  "  if ($actual -ne $env:TIMON_UPDATE_SHA256) { throw 'checksum' }",
  '  $info = New-Object System.Diagnostics.ProcessStartInfo',
  '  $info.FileName = $installer',
  `  $info.Arguments = '${NSIS_SILENT_ARGS.join(' ')}'`,
  '  $info.UseShellExecute = $true',
  '  $info.WorkingDirectory = [IO.Path]::GetDirectoryName($installer)',
  '  $process = [Diagnostics.Process]::Start($info)',
  '  $process.WaitForExit()',
  '  $outcome = [string]$process.ExitCode',
  '} catch {',
  '} finally {',
  '  if ($hold) { $hold.Dispose() }',
  '}',
  "if ($result -and $outcome -ne '0') { try { [IO.File]::WriteAllText($result, $outcome) } catch { } }",
  // The installer's `--force-run` starts Timon as it exits: give it a moment to appear.
  'Start-Sleep -Seconds 5',
  '$name = [IO.Path]::GetFileNameWithoutExtension($app)',
  '$session = (Get-Process -Id $PID).SessionId',
  '$running = @(Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session })',
  'if ($running.Count -eq 0 -and [IO.File]::Exists($app)) {',
  '  $again = New-Object System.Diagnostics.ProcessStartInfo',
  '  $again.FileName = $app',
  '  $again.UseShellExecute = $true',
  '  $again.WorkingDirectory = [IO.Path]::GetDirectoryName($app)',
  '  [Diagnostics.Process]::Start($again) | Out-Null',
  '}',
].join('\n');

/**
 * Root's part on macOS and Linux, run by `/bin/sh -c` from this constant:
 * `$1` is the verified file, `$2` its sha256, `$3` what installs it
 * (`pkg`, `apt` or `dpkg`). `mktemp -d` gives a folder only root can write.
 */
export const ROOT_INSTALL_SCRIPT = [
  'set -eu',
  'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
  'export PATH',
  'dir=$(mktemp -d)',
  'trap \'rm -rf "$dir"\' EXIT',
  'copy="$dir/update"',
  'cp "$1" "$copy"',
  'if command -v sha256sum >/dev/null 2>&1; then sum=$(sha256sum "$copy"); else sum=$(shasum -a 256 "$copy"); fi',
  `[ "\${sum%% *}" = "$2" ] || exit ${CHECKSUM_EXIT}`,
  'case "$3" in',
  '  pkg) mv "$copy" "$copy.pkg"; installer -pkg "$copy.pkg" -target / ;;',
  '  apt) mv "$copy" "$copy.deb"; DEBIAN_FRONTEND=noninteractive apt-get install -y "$copy.deb" ;;',
  '  dpkg) mv "$copy" "$copy.deb"; dpkg -i "$copy.deb" ;;',
  '  *) exit 64 ;;',
  'esac',
].join('\n');

/**
 * macOS: AppleScript from constant lines; the script, the file, its sha256 and
 * the prompt are the `argv` of `on run`, each quoted for the shell by
 * `quoted form of`.
 */
export const MAC_ADMIN_SCRIPT = [
  'on run argv',
  'do shell script "/bin/sh -c " & quoted form of (item 1 of argv) & " timon-update " & quoted form of (item 2 of argv) & " " & quoted form of (item 3 of argv) & " pkg" with prompt (item 4 of argv) with administrator privileges',
  'end run',
];

/** Where `pkexec` lives on the distributions Timon's `.deb` targets. */
const PKEXEC = ['/usr/bin/pkexec', '/bin/pkexec']; // portability: Linux-only branch, absolute system paths
const APT_GET = ['/usr/bin/apt-get', '/bin/apt-get']; // portability: Linux-only branch, absolute system paths
const OSASCRIPT = '/usr/bin/osascript'; // portability: macOS-only branch, the system's AppleScript runner
const SH = '/bin/sh'; // portability: the root script runs on macOS or Linux only

/** The PowerShell of the system, by absolute path: a folder earlier in PATH must not stand in for it. */
export function windowsPowershell(env: NodeJS.ProcessEnv): string {
  return win32.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Where the watcher leaves the verdict of this installer: in its own folder, which the next download prunes. */
export function windowsResultFile(installer: string): string {
  return win32.join(win32.dirname(installer), WINDOWS_RESULT_FILE);
}

export type WindowsInstallFailure = { version: string; outcome: string; reason: string };

/** What a silent Windows installer that did not end with 0 means, in words the person can act on. */
export function windowsInstallFailureReason(outcome: string): string {
  if (outcome === String(NSIS_SERVICE_STILL_RUNNING)) {
    return 'Timon was still running in the background and could not be stopped, so nothing was installed. '
      + 'Install the update again and accept the Windows permission prompt; if it fails again, restart the computer first.';
  }
  if (outcome === String(NSIS_SERVICE_PAUSE_FAILED)) {
    return 'The installer could not check that Timon was stopped in the background (Windows PowerShell did not run its check), so nothing was installed. '
      + 'Install the update again; if it fails again, restart the computer first, or run the Timon installer yourself to read its message.';
  }
  if (outcome === WINDOWS_NOT_STARTED) return 'The installer could not be started. Nothing was installed.';
  return `The installer ended with code ${outcome}. Nothing may have been installed.`;
}

/**
 * The verdict a watcher left under `<home>/updates/<version>/`, read once: the
 * file is removed, so a failure is said at one launch and not at every one.
 * `null` when the last silent installation ended well, or never ran.
 */
export function takeWindowsInstallFailure(updatesRoot: string): WindowsInstallFailure | null {
  let versions: string[];
  try {
    versions = readdirSync(updatesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return null;
  }
  let found: WindowsInstallFailure | null = null;
  for (const version of versions) {
    const file = join(updatesRoot, version, WINDOWS_RESULT_FILE);
    let outcome: string;
    try { outcome = readFileSync(file, 'utf8').trim(); } catch { continue; }
    rmSync(file, { force: true });
    // Only what the watcher writes: an exit code, or its "never ran" word.
    if (!/^-?\d{1,10}$/.test(outcome) && outcome !== WINDOWS_NOT_STARTED) continue;
    found = { version, outcome, reason: windowsInstallFailureReason(outcome) };
  }
  return found;
}

/** Windows: the detached watcher that verifies and starts the silent installer. */
export function windowsCommand(input: { path: string; sha256: string; appExe: string; env: NodeJS.ProcessEnv }): Command {
  const env: NodeJS.ProcessEnv = {
    ...input.env,
    TIMON_UPDATE_INSTALLER: input.path,
    TIMON_UPDATE_SHA256: input.sha256,
    TIMON_UPDATE_APP: input.appExe,
    TIMON_UPDATE_RESULT: windowsResultFile(input.path),
  };
  // Timon started again by the watcher is the application, never Node (I2 of audit-packaged-os).
  delete env.ELECTRON_RUN_AS_NODE;
  // Encoded: a multi-line script survives the Windows command line intact.
  const encoded = Buffer.from(WINDOWS_WATCHER, 'utf16le').toString('base64');
  return {
    file: windowsPowershell(input.env),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    env,
    // Never the install folder: a process whose current folder is in it keeps the installer from replacing it.
    cwd: win32.dirname(input.path),
  };
}

/** macOS: the administrator prompt, then root's copy, hash and `installer -pkg`. */
export function macCommand(input: { path: string; sha256: string; prompt: string }): Command {
  return {
    file: OSASCRIPT,
    args: [...MAC_ADMIN_SCRIPT.flatMap((line) => ['-e', line]), ROOT_INSTALL_SCRIPT, input.path, input.sha256, input.prompt],
    cwd: dirname(input.path),
  };
}

/** Linux: polkit's prompt, then root's copy, hash and `apt-get` (or `dpkg`). */
export function debCommand(input: { path: string; sha256: string; pkexec: string; apt: boolean }): Command {
  return {
    file: input.pkexec,
    args: [SH, '-c', ROOT_INSTALL_SCRIPT, 'timon-update', input.path, input.sha256, input.apt ? 'apt' : 'dpkg'],
    cwd: dirname(input.path),
  };
}

/** The last meaningful line of a failed command, short enough for a log. */
function reasonOf(stderr: string, fallback: string): string {
  const line = stderr.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).pop();
  return (line ?? fallback).slice(0, 300);
}

/** osascript's verdict: `-128` is the person's Cancel on the administrator prompt. */
export function macOutcome(result: CommandResult): SilentOutcome {
  if (result.code === 0) return { status: 'installed' };
  if (/\(-128\)/.test(result.stderr)) return { status: 'cancelled' };
  if (new RegExp(`\\(${CHECKSUM_EXIT}\\)`).test(result.stderr)) return { status: 'failed', reason: 'The installer changed before it was installed.' };
  return { status: 'failed', reason: reasonOf(result.stderr, `osascript exited with ${String(result.code)}`) };
}

/**
 * pkexec's verdict (pkexec(1)): 126, the person dismissed the dialog; 127, no
 * authorization could be obtained (no polkit agent in this session, a
 * policy that refuses): the guided flow can still work.
 */
export function debOutcome(result: CommandResult): SilentOutcome {
  if (result.code === 0) return { status: 'installed' };
  if (result.code === 126) return { status: 'cancelled' };
  if (result.code === 127) return { status: 'unavailable', reason: reasonOf(result.stderr, 'pkexec could not obtain an authorization') };
  if (result.code === CHECKSUM_EXIT) return { status: 'failed', reason: 'The package changed before it was installed.' };
  return { status: 'failed', reason: reasonOf(result.stderr, `the package manager exited with ${String(result.code)}`) };
}

function firstExecutable(paths: readonly string[], executable: (path: string) => boolean): string | null {
  return paths.find((path) => executable(path)) ?? null;
}

/** Installs the verified file without the person leaving the app, or says why not. */
export async function silentInstall(input: SilentInput, system: InstallerSystem): Promise<SilentOutcome> {
  const { path, sha256, format } = input;
  if (!SHA256.test(sha256)) return { status: 'failed', reason: 'Unexpected checksum.' };
  if (path.includes('\0') || !(system.platform === 'win32' ? win32.isAbsolute(path) : isAbsolute(path))) {
    return { status: 'failed', reason: 'The installer path is not absolute.' };
  }
  try {
    if (format === 'nsis' && system.platform === 'win32') {
      const command = windowsCommand({ path, sha256, appExe: system.appExe, env: system.env });
      if (!system.executable(command.file)) return { status: 'unavailable', reason: 'PowerShell is not available.' };
      await system.spawnDetached(command);
      return { status: 'handed_over' };
    }
    if (format === 'pkg' && system.platform === 'darwin') {
      if (!system.executable(OSASCRIPT)) return { status: 'unavailable', reason: 'osascript is not available.' };
      return macOutcome(await system.run(macCommand({ path, sha256, prompt: input.prompt })));
    }
    if (format === 'deb' && system.platform === 'linux') {
      const pkexec = firstExecutable(PKEXEC, system.executable);
      if (!pkexec) return { status: 'unavailable', reason: 'pkexec is not installed.' };
      const apt = firstExecutable(APT_GET, system.executable) !== null;
      return debOutcome(await system.run(debCommand({ path, sha256, pkexec, apt })));
    }
  } catch (error) {
    // The program could not even start (ENOENT, EACCES): the assisted flow takes over.
    return { status: 'unavailable', reason: (error as Error).message };
  }
  return { status: 'unavailable', reason: `No silent installation for ${format} on ${system.platform}.` };
}

/** Bytes of stderr kept for the log: the tail, where the reason is. */
const STDERR_TAIL = 8 * 1024;

/** The real system: `child_process`, with nothing inherited but what each command names. */
export function nodeInstallerSystem(appExe: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): InstallerSystem {
  return {
    platform,
    env,
    appExe,
    executable: (path) => {
      try {
        accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    run: (command) => new Promise((resolveRun, rejectRun) => {
      const child = spawn(command.file, command.args, {
        cwd: command.cwd, env: command.env ?? env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
      });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL); });
      child.once('error', rejectRun);
      child.once('close', (code) => { resolveRun({ code, stderr }); });
    }),
    spawnDetached: (command) => new Promise((resolveSpawn, rejectSpawn) => {
      // Detached: outside the shell's job object, so the shell can quit while it runs.
      const child = spawn(command.file, command.args, {
        cwd: command.cwd, env: command.env ?? env, stdio: 'ignore', detached: true, windowsHide: true,
      });
      child.once('error', rejectSpawn);
      child.once('spawn', () => { child.unref(); resolveSpawn(); });
    }),
  };
}
