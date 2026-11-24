import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, win32 } from 'node:path';

/**
 * The silent installation of a verified update, from inside the app
 * (docs/AUTO-UPDATE.md §10, volet F), without any certificate:
 *
 *  - Windows: the shell, still open, asks Windows for the administrator
 *    permission (UAC) on behalf of its own window; once granted, an elevated
 *    watcher runs the NSIS installer with `/S --updated --force-run`, the shell
 *    quits, and the installer starts the new Timon itself (`--force-run`, as
 *    the user, never elevated). Every OS command of this file lives here.
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
 * arguments (`$1`, `item 1 of argv`), environment variables, or (for the
 * elevated Windows watcher, whose environment Windows rebuilds) base64
 * literals that no character of a name can break out of.
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
  /** Windows: the permission was granted and the elevated watcher runs the silent installer; the shell must quit now, the installer starts Timon again. */
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
  /**
   * Windows: the handle of the window the person clicked "Update" in, as a
   * decimal string, or null. The UAC prompt is owned by it, so Windows shows
   * it in front instead of flashing it in the taskbar.
   */
  ownerWindow?: () => string | null;
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
 * Windows watcher, run ELEVATED by PowerShell (`windowsWatcherScript` puts the
 * installer, its sha256, Timon's executable and the verdict file in front of
 * it, as base64 literals: Windows rebuilds the environment of an elevated
 * process, so nothing travels there). The file is held with read-only sharing
 * from its hash until the installer has exited, so nothing can rewrite or
 * rename it in between. Running elevated, the installer's own service pause
 * asks for nothing more.
 *
 * Once the installer is done, if no Timon runs in this session (a failed
 * install), the installed Timon is started again through Explorer, which
 * starts it as the person and not as administrator: the person is never left
 * without the app.
 *
 * A silent installer says nothing on screen, and the shell has quit by then:
 * the watcher writes how the installer ended to `$result` unless it ended with
 * 0, and the Timon that starts next reports it (`takeWindowsInstallFailure`).
 * Without that, an update the installer refused (the previous service could
 * not be stopped) only looked like an app that closed and opened again on the
 * same version.
 */
export const WINDOWS_WATCHER = [
  "$ErrorActionPreference = 'Stop'",
  `$outcome = '${WINDOWS_NOT_STARTED}'`,
  // An earlier attempt's verdict must not be read as this one's.
  'if ($result) { try { [IO.File]::Delete($result) } catch { } }',
  '$hold = $null',
  'try {',
  '  $hold = [IO.File]::Open($installer, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)',
  '  $digest = [Security.Cryptography.SHA256]::Create().ComputeHash($hold)',
  "  $actual = -join ($digest | ForEach-Object { $_.ToString('x2') })",
  "  if ($actual -ne $sha) { throw 'checksum' }",
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
  // Explorer runs what it is given as the signed-in person, never with this process's rights.
  '  $again = New-Object System.Diagnostics.ProcessStartInfo',
  "  $again.FileName = [IO.Path]::Combine($env:SystemRoot, 'explorer.exe')",
  `  $again.Arguments = '"' + $app + '"'`,
  '  $again.UseShellExecute = $false',
  '  [Diagnostics.Process]::Start($again) | Out-Null',
  '}',
].join('\n');

/** A string as a PowerShell expression that no character of it can break out of. */
function powershellLiteral(value: string): string {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, 'utf8').toString('base64')}'))`;
}

/** The elevated watcher with its four values in front. */
export function windowsWatcherScript(input: { installer: string; sha256: string; app: string; result: string }): string {
  if (!SHA256.test(input.sha256)) throw new Error('Unexpected checksum.');
  return [
    `$installer = ${powershellLiteral(input.installer)}`,
    `$sha = '${input.sha256}'`,
    `$app = ${powershellLiteral(input.app)}`,
    `$result = ${powershellLiteral(input.result)}`,
    WINDOWS_WATCHER,
  ].join('\n');
}

/** Exit status of `WINDOWS_LAUNCHER` when the account cannot approve a UAC prompt (not an administrator). */
export const WINDOWS_LAUNCH_STANDARD_ACCOUNT = 3;
/** Exit status of `WINDOWS_LAUNCHER` when the person said no to the UAC prompt (ERROR_CANCELLED). */
export const WINDOWS_LAUNCH_CANCELLED = 4;

/**
 * Run by the shell, which waits for it while its window is still open: the
 * UAC prompt is asked for here, owned by the window the person clicked in, so
 * Windows shows it in front. Until 0.1.10 the prompt came from the installer,
 * after the shell had quit, from processes without any window: Windows only
 * flashed it in the taskbar, nobody saw it, the installer waited forever and
 * Timon never came back.
 *
 * A standard account would have to type another account's password, and the
 * installer would then run as that other person and update their copy of
 * Timon: such an account gets the visible installer instead (exit 3).
 */
export const WINDOWS_LAUNCHER = [
  "$ErrorActionPreference = 'Stop'",
  // Administrators (S-1-5-32-544): a filtered administrator token lists it as deny-only, a standard account not at all.
  "$whoami = [IO.Path]::Combine($env:SystemRoot, 'System32', 'whoami.exe')",
  `if (-not (& $whoami /groups /fo csv | Select-String -SimpleMatch 'S-1-5-32-544')) { exit ${WINDOWS_LAUNCH_STANDARD_ACCOUNT} }`,
  'try {',
  '  $info = New-Object System.Diagnostics.ProcessStartInfo',
  '  $info.FileName = $env:TIMON_UPDATE_POWERSHELL',
  '  $info.Arguments = $env:TIMON_UPDATE_ELEVATED',
  "  $info.Verb = 'runas'",
  '  $info.UseShellExecute = $true',
  "  $info.WindowStyle = 'Hidden'",
  '  $info.WorkingDirectory = $env:TIMON_UPDATE_DIR',
  // .NET Framework hands the owner window to ShellExecuteEx only when ErrorDialog is set.
  '  if ($env:TIMON_UPDATE_OWNER) { $info.ErrorDialog = $true; $info.ErrorDialogParentHandle = [IntPtr][Int64]$env:TIMON_UPDATE_OWNER }',
  '  [Diagnostics.Process]::Start($info) | Out-Null',
  '  exit 0',
  '} catch {',
  '  $e = $_.Exception',
  `  while ($e) { if ($e.NativeErrorCode -eq 1223) { exit ${WINDOWS_LAUNCH_CANCELLED} }; $e = $e.InnerException }`,
  '  [Console]::Error.WriteLine($_.Exception.Message)',
  '  exit 1',
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

/** How PowerShell runs both Windows scripts: no profile, no prompt, no policy in the way (I6 of audit-packaged-os). */
const POWERSHELL_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden'] as const;

/** Encoded: a multi-line script survives the Windows command line intact. */
function encodedScript(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** A window handle (`getNativeWindowHandle()`, little-endian) as the decimal string the launcher reads, or null. */
export function windowHandle(buffer: Buffer | null | undefined): string | null {
  if (!buffer) return null;
  let value: bigint;
  if (buffer.length >= 8) value = buffer.readBigUInt64LE(0);
  else if (buffer.length >= 4) value = BigInt(buffer.readUInt32LE(0));
  else return null;
  return value > 0n && value < 2n ** 63n ? value.toString() : null;
}

/**
 * Windows: the launcher the shell runs and waits for, which asks for the
 * administrator permission and starts the elevated watcher once granted.
 */
export function windowsCommand(input: { path: string; sha256: string; appExe: string; env: NodeJS.ProcessEnv; owner?: string | null }): Command {
  const powershell = windowsPowershell(input.env);
  const watcher = windowsWatcherScript({ installer: input.path, sha256: input.sha256, app: input.appExe, result: windowsResultFile(input.path) });
  const env: NodeJS.ProcessEnv = {
    ...input.env,
    TIMON_UPDATE_POWERSHELL: powershell,
    TIMON_UPDATE_ELEVATED: [...POWERSHELL_FLAGS, '-EncodedCommand', encodedScript(watcher)].join(' '),
    // Never the install folder: a process whose current folder is in it keeps the installer from replacing it.
    TIMON_UPDATE_DIR: win32.dirname(input.path),
  };
  delete env.TIMON_UPDATE_OWNER;
  if (input.owner && /^\d{1,19}$/.test(input.owner)) env.TIMON_UPDATE_OWNER = input.owner;
  // Nothing started from here is Node (I2 of audit-packaged-os).
  delete env.ELECTRON_RUN_AS_NODE;
  return {
    file: powershell,
    args: [...POWERSHELL_FLAGS, '-EncodedCommand', encodedScript(WINDOWS_LAUNCHER)],
    env,
    cwd: win32.dirname(input.path),
  };
}

/** The launcher's verdict: only a granted permission lets the shell quit. */
export function windowsOutcome(result: CommandResult): SilentOutcome {
  if (result.code === 0) return { status: 'handed_over' };
  if (result.code === WINDOWS_LAUNCH_CANCELLED) return { status: 'cancelled' };
  if (result.code === WINDOWS_LAUNCH_STANDARD_ACCOUNT) {
    return { status: 'unavailable', reason: 'This Windows account is not an administrator: the installer opens instead.' };
  }
  return { status: 'failed', reason: reasonOf(result.stderr, `the update launcher exited with ${String(result.code)}`) };
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
      const command = windowsCommand({ path, sha256, appExe: system.appExe, env: system.env, owner: system.ownerWindow?.() ?? null });
      if (!system.executable(command.file)) return { status: 'unavailable', reason: 'PowerShell is not available.' };
      return windowsOutcome(await system.run(command));
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
export function nodeInstallerSystem(
  appExe: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  ownerWindow?: () => string | null,
): InstallerSystem {
  return {
    platform,
    env,
    appExe,
    ownerWindow,
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
  };
}
