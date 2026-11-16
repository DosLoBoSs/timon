import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { offerFromStatus, sha256Of, type DownloadState, type UpdateDownloader } from './update-download.js';
import {
  DaemonAnswerError, debInstallCommand, missionsAtStake, replaceAppImage, type AppImageReplacement, type DaemonGet, type MissionCount,
} from './update-install.js';
import type { SilentInput, SilentOutcome } from './update-installer.js';

/**
 * "Download" on the new-version banner, in the desktop app (docs/AUTO-UPDATE.md
 * §6, P2): the channels exposed through `window.timonDesktop.updates`
 * (preload.cts) and the controller behind them.
 *
 * The renderer is the realm every client plugin shares, so it names nothing:
 * start, cancel and state take no argument at all, and `open` takes only
 * which of two gestures. The version, URL, size and sha256 are read by this
 * process from the local daemon — loopback, the daemon token of the data
 * directory, as `telemetry-ping.ts` does — which verified the signed release
 * list. An argument that tries to name an installer is refused, not ignored.
 */
export const UPDATE_CHANNELS = {
  state: 'timon:update-state',
  start: 'timon:update-start',
  cancel: 'timon:update-cancel',
  /** `{ target: 'folder' | 'installer' }`: the verified file, never a path. */
  open: 'timon:update-open',
  /** `{ confirmed: boolean }`: installs the verified file (P3); `confirmed` = "install anyway" past running missions. */
  install: 'timon:update-install',
  /** Main → renderer: `DownloadState`. */
  event: 'timon:update-event',
} as const;

export const openRequestSchema = z.strictObject({ target: z.enum(['folder', 'installer']) });
export const installRequestSchema = z.strictObject({ confirmed: z.boolean() });

export type OpenOutcome =
  | { status: 'opened' }
  /** No verified installer on disk. */
  | { status: 'none' }
  /** An AppImage replaces the running one: `install`, not an "open". */
  | { status: 'unsupported' }
  | { status: 'failed'; message: string | null };

export type InstallOutcome =
  /** Missions are running: nothing was done, the person chooses "Wait" or "Install anyway". */
  | { status: 'missions'; count: number }
  /** No verified installer on disk. */
  | { status: 'none' }
  /**
   * The new version is installed or being installed silently: the shell quits
   * and the new one starts (AppImage, `.pkg`, `.deb`, or the NSIS installer's own restart).
   */
  | { status: 'restarting' }
  /** The person dismissed the system's password prompt: nothing changed, the verified file is still ready. */
  | { status: 'cancelled' }
  /** The AppImage's folder cannot be written: the verified file is in Timon's data folder. */
  | { status: 'not_writable' }
  /** A `.deb`: the package was handed to the system (`opened`), and this command installs it. */
  | { status: 'guided'; command: string; opened: boolean }
  /** The system installer is open (macOS); reopen Timon once it is done. */
  | { status: 'opened' }
  /** The Windows installer is open; the shell quits so it can replace Timon. */
  | { status: 'closing' }
  | { status: 'failed'; message: string | null };

const DAEMON_TIMEOUT_MS = 10_000;

/**
 * The outcomes after which the new version may start: installed, handed to a
 * silent installer, or the system's installer opened by this click. Any other
 * outcome installed nothing.
 */
const CONSENT_KEPT: ReadonlySet<InstallOutcome['status']> = new Set(['restarting', 'closing', 'opened', 'guided']);

/**
 * A `GET` to this machine's daemon, as the operator. Throws when it cannot be
 * asked (`DaemonAnswerError` for an HTTP status): the token never leaves the
 * loopback.
 */
export function localDaemonGet(origin: string, home: string, fetcher: typeof fetch = fetch): DaemonGet {
  return async (path) => {
    const url = new URL(origin);
    if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password) {
      throw new Error('not a local daemon');
    }
    const token = readFileSync(join(home, 'daemon-token'), 'utf8').trim();
    if (!token) throw new Error('empty daemon token');
    const res = await fetcher(new URL(path, url), {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(DAEMON_TIMEOUT_MS),
    });
    if (!res.ok) throw new DaemonAnswerError(res.status);
    return res.json() as Promise<unknown>;
  };
}

/** `GET /api/updates` of this machine's daemon. */
export function readDaemonUpdateStatus(origin: string, home: string, fetcher: typeof fetch = fetch): Promise<unknown> {
  return localDaemonGet(origin, home, fetcher)('/api/updates');
}

export type UpdateControllerDeps = {
  downloader: UpdateDownloader;
  /** The daemon's update status; throws when the daemon cannot be asked. */
  readStatus: () => Promise<unknown>;
  /** This shell's version: an offer must be strictly above it. */
  installed: string;
  machine: { platform: NodeJS.Platform; arch: string; appImage: boolean };
  showItemInFolder: (path: string) => void;
  /** `shell.openPath`: '' on success, else the system's message. */
  openPath: (path: string) => Promise<string>;
  sha256File?: (path: string) => Promise<string>;
  /** The missions the daemon would lose; `null` when it cannot tell. */
  readMissions?: () => Promise<MissionCount | null>;
  /** `$APPIMAGE` when this shell runs as one. */
  appImage?: string | null;
  replaceAppImage?: (input: { appImage: string; verified: string; sha256: string }) => Promise<AppImageReplacement>;
  /** Queues the start of the replaced AppImage once this process exits; returns its cancellation. */
  relaunchAppImage?: (appImage: string) => Promise<() => void>;
  /** Quits the shell, as its own menu does. */
  quit?: () => void;
  /** Installs without the person leaving the app (`update-installer.ts`); absent, the assisted flow only. */
  silentInstall?: (input: SilentInput) => Promise<SilentOutcome>;
  /** The administrator prompt's line on macOS, for this version. */
  adminPrompt?: (version: string) => string;
  /** Starts this shell again once it has quit (`app.relaunch`): the installed package's new version. */
  relaunch?: () => void;
  /**
   * The person's click approves the data migration of this exact transition
   * (`update-consent.ts`): granted before the installer starts, revoked when
   * nothing was installed.
   */
  consent?: { grant: (transition: { from: string; to: string }) => void; revoke: () => void };
  log?: (line: string) => void;
};

export class UpdateController {
  constructor(private readonly deps: UpdateControllerDeps) {}

  state(): DownloadState {
    return this.deps.downloader.state();
  }

  async start(): Promise<DownloadState> {
    const { downloader } = this.deps;
    const now = downloader.state();
    if (now.phase === 'downloading' || now.phase === 'verifying') return now;
    let status: unknown;
    try {
      status = await this.deps.readStatus();
    } catch (error) {
      this.deps.log?.(`[updates] daemon status unavailable: ${(error as Error).message}`);
      return downloader.refuse('daemon');
    }
    const offer = offerFromStatus(status, this.deps.installed, this.deps.machine);
    if (!offer) return downloader.refuse('no_offer');
    return downloader.start(offer);
  }

  cancel(): Promise<DownloadState> {
    return this.deps.downloader.cancel();
  }

  /** The verified file still has the bytes that were verified, or why not. */
  private async unchanged(path: string, sha256: string): Promise<string | null> {
    let actual: string;
    try {
      actual = await (this.deps.sha256File ?? sha256Of)(path);
    } catch (error) {
      return (error as Error).message;
    }
    return actual === sha256 ? null : 'The installer changed after it was verified.';
  }

  /**
   * Installs the verified file (docs/AUTO-UPDATE.md §5, §10): silently when
   * the system allows it (NSIS `/S`, the macOS administrator prompt, pkexec),
   * else the system's own installer opens for the person. Running missions
   * are counted first: unless the person confirmed, a running mission stops
   * everything here and its count is returned. One installation at a time: a
   * second gesture while a password prompt is open gets the first one's answer.
   */
  install(confirmed: boolean): Promise<InstallOutcome> {
    this.installing ??= this.installOnce(confirmed)
      .then((outcome) => {
        // Only an installation under way keeps the consent: the new version takes it at its first launch.
        if (this.granted && !CONSENT_KEPT.has(outcome.status)) this.consent('revoke', () => this.deps.consent?.revoke());
        return outcome;
      })
      .finally(() => { this.installing = null; this.granted = false; });
    return this.installing;
  }

  /** A consent that cannot be written or removed costs the approval screen, never the installation. */
  private consent(action: 'grant' | 'revoke', run: () => void): void {
    try {
      run();
    } catch (error) {
      this.deps.log?.(`[updates] update consent not ${action === 'grant' ? 'written' : 'removed'}: ${(error as Error).message}`);
    }
  }

  private installing: Promise<InstallOutcome> | null = null;
  /** This gesture wrote a consent: what it installed decides whether it stays. */
  private granted = false;

  private async installOnce(confirmed: boolean): Promise<InstallOutcome> {
    const ready = this.deps.downloader.ready();
    if (!ready) return { status: 'none' };
    if (!confirmed) {
      const count = missionsAtStake(await (this.deps.readMissions?.() ?? Promise.resolve(null)).catch(() => null));
      if (count > 0) return { status: 'missions', count };
    }
    const changed = await this.unchanged(ready.path, ready.offer.artifact.sha256);
    if (changed) return { status: 'failed', message: changed };
    this.granted = true;
    this.consent('grant', () => this.deps.consent?.grant({ from: this.deps.installed, to: ready.offer.version }));
    const { format, sha256 } = ready.offer.artifact;
    const log = (line: string): void => { this.deps.log?.(`[updates] ${line}`); };
    if (format === 'appimage') {
      const { appImage, relaunchAppImage, quit } = this.deps;
      const replace = this.deps.replaceAppImage ?? replaceAppImage;
      if (!appImage || !relaunchAppImage || !quit) return { status: 'failed', message: 'This Timon does not run as an AppImage.' };
      let replaced: AppImageReplacement;
      try {
        replaced = await replace({ appImage, verified: ready.path, sha256 });
      } catch (error) {
        log(`AppImage not replaced, the previous one is kept: ${(error as Error).message}`);
        return { status: 'failed', message: (error as Error).message };
      }
      if (replaced.status === 'not_writable') return replaced;
      try {
        await relaunchAppImage(appImage);
      } catch (error) {
        // Without a relaunch, the person would be left with a version that never started.
        await replaced.restore().catch((restoreError: unknown) => { log(`the previous AppImage could not be put back: ${(restoreError as Error).message}`); });
        log(`AppImage relaunch failed, the previous one is back: ${(error as Error).message}`);
        return { status: 'failed', message: (error as Error).message };
      }
      log(`AppImage replaced by ${ready.offer.version}: restarting`);
      quit();
      return { status: 'restarting' };
    }
    if (format === 'nsis' || format === 'pkg' || format === 'deb') {
      const silent = await this.silent(format, ready.path, sha256, ready.offer.version);
      if (silent === 'restarting' || silent === 'cancelled') return { status: silent };
      // A silent install that failed on the bytes must not end in opening them.
      const changedSince = await this.unchanged(ready.path, sha256);
      if (changedSince) return { status: 'failed', message: changedSince };
    }
    if (format === 'deb') {
      const error = await this.deps.openPath(ready.path);
      if (error) log(`the .deb did not open in the system: ${error}`);
      return { status: 'guided', command: debInstallCommand(ready.path), opened: !error };
    }
    const error = await this.deps.openPath(ready.path);
    if (error) return { status: 'failed', message: error };
    if (format === 'nsis') {
      // The installer replaces Timon.exe: this shell must not hold it.
      log(`installer ${ready.offer.version} opened: quitting`);
      this.deps.quit?.();
      return { status: 'closing' };
    }
    return { status: 'opened' };
  }

  /**
   * The silent path (docs/AUTO-UPDATE.md §10): `restarting` once the shell
   * quits into the new version, `cancelled` when the person dismissed the
   * prompt, `assisted` when the installer must be opened for them instead.
   */
  private async silent(format: 'nsis' | 'pkg' | 'deb', path: string, sha256: string, version: string): Promise<'restarting' | 'cancelled' | 'assisted'> {
    const { silentInstall, quit } = this.deps;
    const log = (line: string): void => { this.deps.log?.(`[updates] ${line}`); };
    if (!silentInstall || !quit) return 'assisted';
    // Windows hands over to a process that outlives this one; macOS and Linux install here, then restart.
    const relaunch = format === 'nsis' ? null : this.deps.relaunch;
    if (format !== 'nsis' && !relaunch) return 'assisted';
    const prompt = this.deps.adminPrompt?.(version) ?? `Timon needs your password to install version ${version}.`;
    let outcome: SilentOutcome;
    try {
      outcome = await silentInstall({ format, path, sha256, prompt });
    } catch (error) {
      outcome = { status: 'failed', reason: (error as Error).message };
    }
    switch (outcome.status) {
      case 'handed_over':
        log(`silent installer ${version} started: quitting, it starts Timon again`);
        quit();
        return 'restarting';
      case 'installed':
        log(`${format} ${version} installed: restarting`);
        relaunch?.();
        quit();
        return 'restarting';
      case 'cancelled':
        log(`${format} ${version}: the administrator prompt was dismissed`);
        return 'cancelled';
      default:
        log(`${format} ${version} not installed silently (${outcome.status}: ${outcome.reason}): opening the installer`);
        return 'assisted';
    }
  }

  async open(target: 'folder' | 'installer'): Promise<OpenOutcome> {
    const ready = this.deps.downloader.ready();
    if (!ready) return { status: 'none' };
    if (target === 'folder') {
      this.deps.showItemInFolder(ready.path);
      return { status: 'opened' };
    }
    if (ready.offer.artifact.format === 'appimage') return { status: 'unsupported' };
    // Verified once; the file must still be those bytes when the system opens it.
    const changed = await this.unchanged(ready.path, ready.offer.artifact.sha256);
    if (changed) return { status: 'failed', message: changed };
    const error = await this.deps.openPath(ready.path);
    return error ? { status: 'failed', message: error } : { status: 'opened' };
  }
}

export type UpdateIpcLike<S> = { handle(channel: string, listener: (sender: S, input: unknown) => unknown): void };

/** Rejects any argument: the installer is the daemon's choice, never the page's. */
function noArgument(input: unknown): void {
  if (input !== undefined) throw new Error('This call takes no argument: the installer comes from the verified offer.');
}

export function registerUpdateIpc<S>(ipc: UpdateIpcLike<S>, allowed: (sender: S) => boolean, controller: () => UpdateController): void {
  const guard = (sender: S): void => {
    if (!allowed(sender)) throw new Error('Updates are only downloaded from the Timon window of this machine.');
  };
  ipc.handle(UPDATE_CHANNELS.state, (sender, input) => {
    guard(sender);
    noArgument(input);
    return controller().state();
  });
  ipc.handle(UPDATE_CHANNELS.start, (sender, input) => {
    guard(sender);
    noArgument(input);
    return controller().start();
  });
  ipc.handle(UPDATE_CHANNELS.cancel, (sender, input) => {
    guard(sender);
    noArgument(input);
    return controller().cancel();
  });
  ipc.handle(UPDATE_CHANNELS.open, (sender, input) => {
    guard(sender);
    return controller().open(openRequestSchema.parse(input).target);
  });
  ipc.handle(UPDATE_CHANNELS.install, (sender, input) => {
    guard(sender);
    return controller().install(installRequestSchema.parse(input).confirmed);
  });
}
