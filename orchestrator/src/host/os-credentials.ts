/**
 * Read-only access to ONE entry of the operating system's credential store
 * (S4/S8 of `docs/PROVIDERS-SDK.md`): today the macOS login keychain, where a CLI
 * keeps the sign-in a file-based probe cannot see (TIM-0044 for `claude`). The
 * generalisation of `claude-keychain.ts`, for a provider that declared the entry in
 * its manifest.
 *
 * Read-only on purpose: refresh tokens rotate, so Timon refreshing a CLI's session
 * would invalidate the one the CLI holds. The value is returned to the caller and
 * never logged; a locked keychain or a refused prompt answers `null`, remembered
 * for a minute so that a gauge polling every few seconds does not stack prompts in
 * front of the user. Distinct from `Host.keyring`, which shelters Timon's own
 * master key.
 *
 * One write exists, and it is a removal: the entry a CLI keeps for ONE
 * subscription account (`removeOsCredential`). A mission's fence cannot update
 * the keychain (the home is read-only inside it), so a CLI that rotates its
 * refresh token there ends up with a stale entry that shadows the fresh copy it
 * wrote in its folder. The provider moves the entry into the account's folder,
 * outside the fence, and the daemon deletes it: the folder becomes the one place
 * the CLI keeps that sign-in, and the CLI stays its only holder.
 */
import type { Host } from './types.js';

const SECURITY_TIMEOUT_MS = 5_000;
const MISS_TTL_MS = 60_000;
/** `security` exit status for an entry that does not exist. */
const NOT_FOUND = 44;
/** A service may hold one entry per OS account name: a few, never an unbounded loop. */
const MAX_REMOVALS = 8;

export type OsCredentialEntry = { readonly service: string; readonly account?: string };

const misses = new Map<string, number>();
const keyOf = (entry: OsCredentialEntry): string => `${entry.service}\0${entry.account ?? ''}`;

/** Forget the remembered misses, so a login made since is picked up at once. */
export function resetOsCredentialMisses(entry?: OsCredentialEntry): void {
  if (entry) misses.delete(keyOf(entry));
  else misses.clear();
}

/**
 * The stored secret, or `null` when this is not macOS, the entry does not exist, or
 * the store cannot be read from this process (LaunchDaemon, SSH, locked, prompt
 * denied). Never throws: "cannot read" and "not signed in" are one answer.
 */
export function readOsCredential(
  host: Pick<Host, 'platform' | 'exec'>, entry: OsCredentialEntry, now: number = Date.now(),
): string | null {
  if (host.platform !== 'darwin') return null;
  const key = keyOf(entry);
  const lastMiss = misses.get(key);
  if (lastMiss && now - lastMiss < MISS_TTL_MS) return null;
  const value = findEntry(host, entry);
  if (value !== null) {
    misses.delete(key);
    return value;
  }
  misses.set(key, now);
  return null;
}

/** The secret, asked of `security` now: no remembered miss, nothing remembered. */
export function readOsCredentialNow(host: Pick<Host, 'platform' | 'exec'>, entry: OsCredentialEntry): string | null {
  return host.platform === 'darwin' ? findEntry(host, entry) : null;
}

function findEntry(host: Pick<Host, 'exec'>, entry: OsCredentialEntry): string | null {
  try {
    const args = ['find-generic-password', '-s', entry.service, ...(entry.account ? ['-a', entry.account] : []), '-w'];
    const result = host.exec('security', args, { timeout: SECURITY_TIMEOUT_MS });
    const value = result.stdout.trim();
    if (result.code === 0 && value) return value;
  } catch {
    // treated as a miss
  }
  return null;
}

/**
 * Deletes every entry under `service` (and `account`, when given), and answers
 * whether none is left: `true` off macOS, where there is nothing to remove, and
 * `false` when `security` refused (locked keychain, a prompt denied, a timeout).
 * Only names go on the command line, never the secret.
 */
export function removeOsCredential(host: Pick<Host, 'platform' | 'exec'>, entry: OsCredentialEntry): boolean {
  if (host.platform !== 'darwin') return true;
  const args = ['delete-generic-password', '-s', entry.service, ...(entry.account ? ['-a', entry.account] : [])];
  for (let attempt = 0; attempt < MAX_REMOVALS; attempt += 1) {
    let code: number;
    try {
      code = host.exec('security', args, { timeout: SECURITY_TIMEOUT_MS }).code;
    } catch {
      return false;
    }
    if (code === NOT_FOUND) {
      misses.delete(keyOf(entry));
      return true;
    }
    if (code !== 0) return false;
  }
  return false;
}
