import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { localDaemonGet } from './update-ipc.js';

/**
 * When the shell (re)connects to its daemon, the update check runs again if the
 * last successful one is older than 30 min. The daemon runs as a service and
 * outlives the app: without this, opening the app after a failed check showed
 * nothing until the daemon's own schedule came round.
 *
 * Only existing routes: `GET /api/updates` tells the verdict and its time,
 * `POST /api/updates/check` runs a check. Both take the daemon token, read from
 * the data directory and never sent off the loopback, as `telemetry-ping.ts`
 * does. Never throws: the window opens whatever this answers.
 */
export const STALE_AFTER_MS = 30 * 60_000;
/** The daemon answers once its own request to the site ends, which may take its 15 s fetch timeout. */
const CHECK_TIMEOUT_MS = 20_000;

const statusSchema = z.object({
  state: z.string(),
  checkedAt: z.string().nullable().optional(),
});

/**
 * Whether the daemon's status calls for a check. A success (`up_to_date`,
 * `available`) dates its `checkedAt`; a failure or no verdict yet leaves the
 * last success unknown, so it is due. Off, a source build, or a status this
 * shell cannot read: nothing.
 */
export function updateCheckDue(status: unknown, now: number, staleAfterMs: number = STALE_AFTER_MS): boolean {
  const parsed = statusSchema.safeParse(status);
  if (!parsed.success) return false;
  const { state, checkedAt } = parsed.data;
  if (state === 'failed' || state === 'unchecked') return true;
  if (state !== 'up_to_date' && state !== 'available') return false;
  const at = checkedAt ? Date.parse(checkedAt) : Number.NaN;
  return !Number.isFinite(at) || now - at > staleAfterMs;
}

export type FreshnessDeps = {
  /** `GET` of the daemon's status; throws when it cannot be asked. */
  readStatus: () => Promise<unknown>;
  /** `POST /api/updates/check`; returns the HTTP status. */
  requestCheck: () => Promise<number>;
  now?: () => number;
};

/** One line for the desktop log; never throws. */
export async function checkUpdatesIfStale(deps: FreshnessDeps): Promise<string> {
  let status: unknown;
  try { status = await deps.readStatus(); }
  catch (error) { return `skipped: status unreadable (${(error as Error).message})`; }
  if (!updateCheckDue(status, deps.now?.() ?? Date.now())) return 'skipped: recent enough';
  try { return `checked: ${await deps.requestCheck()}`; }
  catch (error) { return `failed: ${(error as Error).message}`; }
}

/** `POST /api/updates/check` of this machine's daemon, as the operator. */
export function localDaemonCheck(origin: string, home: string, fetcher: typeof fetch = fetch): () => Promise<number> {
  return async () => {
    const url = new URL(origin);
    if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password) {
      throw new Error('not a local daemon');
    }
    const token = readFileSync(join(home, 'daemon-token'), 'utf8').trim();
    if (!token) throw new Error('empty daemon token');
    const res = await fetcher(new URL('/api/updates/check', url), {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => undefined);
    return res.status;
  };
}

/** The daemon at `origin`, sharing `home` with this shell. */
export function checkLocalUpdatesIfStale(origin: string, home: string, fetcher: typeof fetch = fetch): Promise<string> {
  return checkUpdatesIfStale({
    readStatus: () => localDaemonGet(origin, home, fetcher)('/api/updates'),
    requestCheck: localDaemonCheck(origin, home, fetcher),
  });
}
