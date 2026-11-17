import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isTimon, probeFailureReason, type HealthResult } from './health.js';
import type { StartupText } from './startup-text.js';

/**
 * Asks the daemon to start its web app again (TODO #485). The daemon was
 * already up but the interface does not answer: its supervisor may have given
 * up on a Next that crashed in a loop, and waiting the 120 s of the startup
 * view would only end in "the interface did not come up". Rearming it costs
 * no restart, so missions keep running.
 *
 * The route takes the daemon token alone, read from the data directory this
 * shell shares with its daemon. Returns a line for the desktop log; never
 * throws, since the window opens whatever this answers.
 */
export async function requestAppRearm(origin: string, home: string, fetcher: typeof fetch = fetch): Promise<string> {
  const url = new URL(origin);
  // Never send the operator's token anywhere but this machine's daemon.
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password) {
    return 'skipped: not a local daemon';
  }
  let token: string;
  try { token = readFileSync(join(home, 'daemon-token'), 'utf8').trim(); }
  catch (error) { return `skipped: daemon token unreadable (${(error as NodeJS.ErrnoException).code ?? 'error'})`; }
  if (!token) return 'skipped: empty daemon token';
  try {
    const res = await fetcher(new URL('/api/app/rearm', url), {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    let detail = '';
    try {
      const body = await res.json() as { result?: unknown; message?: unknown } | null;
      detail = [body?.result, body?.message].filter((part) => typeof part === 'string').join(': ');
    } catch { /* an older daemon without the route answers 404 in plain text */ }
    return `${res.status}${detail ? ` ${detail}` : ''}`;
  } catch (error) {
    return `failed: ${probeFailureReason(error)}`;
  }
}

/** What the shell says once the interface stopped waiting (TIM-0154). */
export type GiveUpVerdict =
  /** The daemon answers, or at least holds its port: the web app alone is missing. */
  | { kind: 'ui-missing' }
  /** Nothing listened, and the one relaunch brought the daemon back: wait for the interface again. */
  | { kind: 'revived' }
  /** Nothing listens on the daemon's port. `retried`: the one relaunch ran and did not help. */
  | { kind: 'daemon-down'; retried: boolean }
  /** The relaunch failed and already said why in a dialog of its own. */
  | { kind: 'reported' };

/**
 * How the shell started the daemon again: a line for the log, whether it
 * already showed its own failure, and whether it already waited for the
 * daemon (one probe then decides, not a second wait).
 */
export type RelaunchOutcome = { line: string; selfReported: boolean; waited: boolean };

export type RevivalSeams = {
  /** The daemon's `/api/health`, once. */
  probe: () => Promise<HealthResult>;
  /** Starts the daemon again, or null when this shell has nothing it can start. */
  relaunch: (() => Promise<RelaunchOutcome>) | null;
  /** Bounded wait on the daemon after the relaunch. */
  wait: () => Promise<HealthResult>;
  /** The data directory the daemon must answer for (`isTimon`). */
  home?: string;
  /** The relaunch is under way (or already was): the page may say it is starting again. */
  relaunching?: () => void;
  log: (line: string) => void;
};

/**
 * Connection refused: nothing listens on the daemon's port. A timeout or a
 * reset means a daemon is there, busy or broken, and starting another one
 * would only fight it for the port. Matches `probeFailureReason`'s wording.
 */
export function nothingListens(health: HealthResult): boolean {
  return !health.ok && (health.error ?? '').startsWith('connection refused');
}

/**
 * The interface gave up waiting. The dialog used to blame the web app even
 * when the daemon itself was gone (TIM-0154, Windows: the service had not
 * started on the second day). Here the daemon is asked first; when nothing
 * listens, it is started again once per shell session, the way
 * `requestAppRearm` wakes the web app alone, and only then does the shell
 * report. Never a loop: a second give-up after the relaunch goes straight to
 * the dialog. Pages giving up together share the one relaunch.
 */
export class DaemonRevival {
  private attempt: Promise<boolean> | null = null;
  private spent = false;
  private selfReported = false;

  async settle(seams: RevivalSeams): Promise<GiveUpVerdict> {
    const health = await seams.probe();
    if (!nothingListens(health)) return { kind: 'ui-missing' };
    if (this.spent) {
      seams.log('[desktop] daemon not running; the one relaunch of this session already ran');
      return { kind: 'daemon-down', retried: true };
    }
    if (!seams.relaunch) {
      seams.log('[desktop] daemon not running; nothing this shell can start again');
      return { kind: 'daemon-down', retried: false };
    }
    seams.relaunching?.();
    this.attempt ??= this.relaunch(seams, seams.relaunch);
    if (await this.attempt) return { kind: 'revived' };
    return this.selfReported ? { kind: 'reported' } : { kind: 'daemon-down', retried: true };
  }

  private async relaunch(seams: RevivalSeams, start: () => Promise<RelaunchOutcome>): Promise<boolean> {
    seams.log('[desktop] daemon not running (connection refused): relaunching it once');
    try {
      const outcome = await start();
      this.selfReported = outcome.selfReported;
      seams.log(`[desktop] daemon relaunch → ${outcome.line}`);
      const health = await (outcome.waited ? seams.probe() : seams.wait());
      const up = isTimon(health, seams.home);
      seams.log(`[desktop] daemon relaunch ${up ? 'succeeded' : `failed: ${health.ok ? `HTTP ${health.status}, ${health.identity}` : health.error ?? 'no answer'}`}`);
      return up;
    } catch (error) {
      seams.log(`[desktop] daemon relaunch failed: ${(error as Error).message}`);
      return false;
    } finally {
      this.spent = true;
    }
  }
}

/**
 * The give-up dialog for a verdict, or null when there is nothing left to
 * say. `ui-missing` keeps the words it always had; `daemon-down` names the
 * daemon's address and the folder of its logs instead of blaming the web app.
 */
export function giveUpBox(
  verdict: GiveUpVerdict,
  t: StartupText,
  ctx: { giveUp: string; origin: string; logs: string },
): { message: string; detail: string } | null {
  if (verdict.kind === 'ui-missing') {
    return { message: t('startup.uiMissing'), detail: t('startup.uiMissingDetail', { giveUp: ctx.giveUp }) };
  }
  if (verdict.kind === 'daemon-down') {
    return {
      message: t('startup.daemonDown'),
      detail: t('startup.daemonDownDetail', { origin: ctx.origin, retried: verdict.retried ? 'yes' : 'no', logs: ctx.logs }),
    };
  }
  return null;
}

type ExecResult = { stdout: string };

/**
 * Runs `program` as the service helpers do, and writes each call and its exit
 * code to `calls`: `startDesktopService` swallows a failed `/Run` or `start`,
 * and the log must still say what the OS answered.
 */
export function recordingExec(
  program: string,
  calls: string[],
  run: (file: string, args: string[]) => Promise<ExecResult> = (file, args) => promisify(execFile)(file, args, { timeout: 15_000 }),
): (args: string[]) => Promise<ExecResult> {
  return async (args) => {
    const call = [program, ...args].join(' ');
    try {
      const result = await run(program, args);
      calls.push(`${call} → exit 0`);
      return result;
    } catch (error) {
      const failure = error as { code?: unknown; signal?: unknown };
      const code = failure.code ?? (failure.signal ? `signal ${String(failure.signal)}` : 'unknown');
      calls.push(`${call} → exit ${String(code)}`);
      throw error;
    }
  };
}

/** The program behind the desktop service on each OS, as in `service.ts`. */
export function serviceProgram(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'schtasks' : platform === 'darwin' ? 'launchctl' : 'systemctl';
}
