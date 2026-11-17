/**
 * The consent "Restart and install" gives to the data migration
 * (docs/AUTO-UPDATE.md §10): the shell that installs a new version leaves it in
 * the data directory, and the new version reads it once at its first launch.
 * It only stands for the exact transition it names (data of `from`, opened by
 * `to`) and for a day; anything else — no file, an expired or foreign one, an
 * installer started by hand — gets the approval screen as before.
 *
 * It is not a way around the daemon's gate: a matching consent only spares the
 * question, the shell then sends the same approval to the daemon
 * (`finishUpdate`), and `assertDataUpdateApproved` still decides, after the
 * `pre-<version>` copy. Whoever can write this file can already write
 * `update-approval.json` next to it, so it opens nothing new.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/** Long enough for a slow download-to-restart, short enough that a forgotten one does not approve next week's install. */
export const UPDATE_CONSENT_TTL_MS = 24 * 60 * 60 * 1000;
/** A clock moved back a little between the two launches must not void the consent. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export const updateConsentFile = (home: string): string => join(home, 'update-consent.json');

const version = z.string().min(1).max(64);
const consentSchema = z.strictObject({
  id: z.uuid(),
  from: version,
  to: version,
  grantedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});
export type UpdateConsent = z.infer<typeof consentSchema>;

/**
 * Written just before the installer starts. Atomic (a half-written file is
 * never read) and readable by its owner only; on Windows the mode is ignored
 * and the file inherits the profile's owner-only ACL, as `update-approval.json`.
 */
export function grantUpdateConsent(home: string, transition: { from: string; to: string }, now = Date.now()): UpdateConsent {
  const consent = consentSchema.parse({ id: randomUUID(), from: transition.from, to: transition.to, grantedAt: now, expiresAt: now + UPDATE_CONSENT_TTL_MS });
  mkdirSync(home, { recursive: true });
  const file = updateConsentFile(home);
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(consent)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return consent;
}

/** The installation did not happen (failed, prompt dismissed): the consent goes with it. */
export function revokeUpdateConsent(home: string): void {
  rmSync(updateConsentFile(home), { force: true });
}

/**
 * Removes the consent, then returns it if it was well formed. One use only:
 * the file is renamed away before it is read, so two launches cannot both take
 * it, and it is gone whatever happens next. Called at every packaged launch,
 * offer or not, so a consent the installation never used does not linger.
 */
export function takeUpdateConsent(home: string): UpdateConsent | null {
  const file = updateConsentFile(home);
  const taken = `${file}.taken-${process.pid}-${randomUUID()}`;
  try {
    renameSync(file, taken);
  } catch {
    return null;
  }
  try {
    const parsed = consentSchema.safeParse(JSON.parse(readFileSync(taken, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  } finally {
    rmSync(taken, { force: true });
  }
}

/** Whether `consent` approves exactly this transition, now. */
export function consentApproves(consent: UpdateConsent | null, offer: { from: string; to: string }, now = Date.now()): boolean {
  if (!consent) return false;
  if (consent.from !== offer.from || consent.to !== offer.to) return false;
  if (consent.expiresAt - consent.grantedAt > UPDATE_CONSENT_TTL_MS) return false;
  return now >= consent.grantedAt - CLOCK_SKEW_MS && now < consent.expiresAt;
}
