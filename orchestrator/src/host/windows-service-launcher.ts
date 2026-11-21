/**
 * The program the Windows scheduled task runs: it HOLDS the daemon until it
 * exits, so the repeating trigger + `IgnoreNew` act as the supervisor.
 *
 * It replaces the `timon-service.cmd` batch of revisions 2 to 5, which the
 * task ran through `cmd.exe` (boot task) or a hidden PowerShell (logon task).
 * Avast and AVG flag exactly that shape in `C:\Windows\System32\Tasks` —
 * a batch or PowerShell started at boot or logon, hidden, repeating — and
 * quarantined the task (`CMD:Heur.BZC.WBO.Boxter`). The task now starts a
 * program of the package directly: this script on the Node the package ships
 * (boot task, session 0, no window anyone sees), or `Timon.exe --timon-service`
 * (logon task), a GUI-subsystem program that starts this script with no
 * console window (`desktop/src/windows-service-shell.ts`).
 *
 * What the batch did, this does, in the same order (renderWindowsLauncher of
 * revision 5 for the history):
 * - waits until DPAPI opens the session witness: under S4U, when nobody has
 *   logged on since boot, a `claude` run ERASES the user's Windows
 *   credentials (docs/SERVICE-HORS-SESSION.md, W6);
 * - moves a log of 10 MiB or more aside, once, at start;
 * - starts the daemon with its output and errors appended to `daemon.log`,
 *   which is what `>>daemon.log 2>&1` did;
 * - waits for it, so the task runs exactly as long as its daemon.
 *
 * An action cannot set an environment variable: the daemon's environment
 * comes from `run/timon-service.json`, written by `timon service install`
 * (`renderWindowsLauncherConfig`, `host/service-install.ts`).
 *
 * Imports node built-ins and zod only: it runs before anything of the daemon.
 */
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Format of `run/timon-service.json`; a launcher refuses a format it does not know. */
export const WINDOWS_LAUNCHER_FORMAT = 1;

/** Seconds between two looks at a session witness that does not open yet. */
export const WITNESS_RETRY_SECONDS = 10;

const launcherConfigSchema = z.object({
  format: z.literal(WINDOWS_LAUNCHER_FORMAT),
  /** The Node that runs the daemon. */
  node: z.string().min(1),
  /** Its arguments: the heap limit, then `dist\boot.js`. */
  args: z.array(z.string()),
  cwd: z.string().min(1),
  /** Added to the environment the task gives this process. */
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()),
  log: z.string().min(1),
  rotateBytes: z.number().int().positive(),
  /** Arguments of the PowerShell that exits 0 when the witness opens, 2 when it is missing, 1 otherwise (`readSessionWitnessCommand`). */
  witness: z.object({ file: z.string().min(1), args: z.array(z.string()).min(1) }),
});

export type WindowsLauncherConfig = z.infer<typeof launcherConfigSchema>;

/** The configuration, or a message that names the file and says why it was refused. */
export function parseLauncherConfig(text: string, file: string): WindowsLauncherConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = launcherConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${file} is not a Timon service configuration (${parsed.error.issues.map((issue) => issue.path.join('.') || 'root').join(', ')}); run \`timon service install\``);
  }
  return parsed.data;
}

/** What the launcher needs from the machine; the tests replace all of it. */
export type LauncherDeps = {
  /** Runs the witness check, returns its exit code and what it wrote on stderr. */
  checkWitness: (args: string[]) => { code: number | null; stderr: string; error?: Error };
  /** Starts the daemon with its output on `logFd`, resolves with its exit code. */
  runDaemon: (config: WindowsLauncherConfig, logFd: number) => Promise<number | null>;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => Date;
};

/** Windows PowerShell by its full path: the task's PATH is the one read when it started (packaging audit I5). */
export function windowsPowershell(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.windir;
  return root ? join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
}

export const launcherDeps: LauncherDeps = {
  checkWitness: (args) => {
    // `windowsHide`: no console window in the user's session either.
    const res: SpawnSyncReturns<string> = spawnSync(windowsPowershell(), args, { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    return { code: res.status, stderr: res.stderr ?? '', ...(res.error ? { error: res.error } : {}) };
  },
  runDaemon: (config, logFd) => new Promise((done) => {
    const child = spawn(config.node, config.args, {
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
    child.once('error', (error) => {
      writeLine(logFd, new Date(), `the daemon could not be started: ${error.message}`);
      done(null);
    });
    child.once('exit', (code) => done(code));
  }),
  sleep: (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
  now: () => new Date(),
};

function writeLine(fd: number, at: Date, text: string): void {
  // A log that cannot be written costs the line, never the daemon.
  try { writeSync(fd, `[timon-service] ${at.toISOString()} ${text}\n`); } catch { /* see above */ }
}

/** One line, bounded: a localized exception message must not flood a log rotated only at start. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? flat.slice(0, 300) : flat;
}

/** Moved aside at start only: nothing holds the file yet. A lock (antivirus, indexer) skips the rotation. */
function rotate(log: string, limit: number): void {
  try {
    if (statSync(log).size >= limit) renameSync(log, `${log}.1`);
  } catch { /* absent, or held: appended to as it is */ }
}

/**
 * The whole launch. Exit codes as the batch's: 2 when the witness is missing
 * (the service must be installed again), 0 once the daemon has exited.
 */
export async function runLauncher(config: WindowsLauncherConfig, seams: Partial<LauncherDeps> = {}): Promise<number> {
  const deps: LauncherDeps = { ...launcherDeps, ...seams };
  mkdirSync(dirname(config.log), { recursive: true });
  rotate(config.log, config.rotateBytes);
  const fd = openSync(config.log, 'a');
  try {
    let waiting = false;
    for (;;) {
      const check = deps.checkWitness(config.witness.args);
      if (check.code === 0) break;
      if (check.code === 2) {
        writeLine(fd, deps.now(), 'session witness missing, reinstall the service');
        return 2;
      }
      if (!waiting) {
        const why = check.error ? `the check could not run: ${check.error.message}` : oneLine(check.stderr) || `exit ${check.code ?? 'unknown'}`;
        writeLine(fd, deps.now(), `session witness unreadable: ${why}`);
        writeLine(fd, deps.now(), 'waiting for the first logon since boot');
        waiting = true;
      }
      await deps.sleep(WITNESS_RETRY_SECONDS * 1000);
    }
    writeLine(fd, deps.now(), 'starting the daemon');
    const code = await deps.runDaemon(config, fd);
    writeLine(fd, deps.now(), `daemon exited with code ${code ?? 'unknown'}`);
    return 0;
  } finally {
    closeSync(fd);
  }
}

/** Where a configuration that cannot be read is reported: `daemon.log` of the home it sits in (`<home>\run\timon-service.json`). */
export function fallbackLog(configFile: string): string {
  return join(dirname(dirname(configFile)), 'tmp', 'daemon.log');
}

async function main(argv: string[]): Promise<void> {
  const file = argv[0];
  if (!file) throw new Error('usage: windows-service-launcher <run\\timon-service.json>');
  let config: WindowsLauncherConfig;
  try {
    config = parseLauncherConfig(readFileSync(file, 'utf8'), file);
  } catch (error) {
    // Nobody reads this process's stderr: the task has no console.
    const log = fallbackLog(file);
    try {
      mkdirSync(dirname(log), { recursive: true });
      const fd = openSync(log, 'a');
      writeLine(fd, new Date(), `cannot start: ${(error as Error).message}`);
      closeSync(fd);
    } catch { /* nowhere left to say it */ }
    throw error;
  }
  process.exitCode = await runLauncher(config);
}

/** Run as a script, never when imported (the tests, `service-install.ts`). */
function isEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  return process.platform === 'win32' ? resolve(entry).toLowerCase() === self.toLowerCase() : resolve(entry) === self;
}

if (isEntry()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`[timon-service] ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
