/**
 * How far an account reaches into Settings › AI models › Providers: three
 * levels, carried by two actions of the permission catalogue.
 *
 * - `full` (`providers:manage`): what the superadmin has — every section of a
 *   provider page (Connection, API key, Program, own settings, Models), adding
 *   and removing providers, switching them on and off, the ACP catalogue, the
 *   pinned and authorised programs. Pinning or authorising a program decides
 *   what the daemon runs on the host: this level is offered as such.
 * - `accounts` (`providers:accounts`): the list, read only, and on a provider's
 *   page the Connection section with the account's OWN subscription accounts
 *   (add, sign in, rename, delete). Nothing else.
 * - `none` (neither): the screen does not exist for the account, and every
 *   route behind it refuses.
 *
 * Two actions rather than one with a value, because a permission is a string
 * the evaluator matches and a role is a set of them: `providers:manage` and
 * `providers:accounts` are siblings for `permissionCovers`, so the hierarchy
 * (`manage` includes `accounts`) is applied HERE, once, and nowhere else. A
 * deny wins as everywhere: `-providers:manage` on top of `*` leaves an account
 * at `accounts` (since `*` still covers `providers:accounts`).
 *
 * Every check reads `requestHasPermission`, hence `userAllows` /
 * `grantsAllow`: the superadmin and the daemon token are `full`, a mission
 * token is `none` (neither action is in the mission cap: an agent does not
 * pick the program it is run by, nor who pays).
 */
import type { Request, Response } from 'express';
import { forbidden, isPersonAuth, requestHasPermission } from './identity.js';

export const PROVIDERS_MANAGE = 'providers:manage';
export const PROVIDERS_ACCOUNTS = 'providers:accounts';

export type ProviderAccess = 'full' | 'accounts' | 'none';

const RANK: Readonly<Record<ProviderAccess, number>> = { none: 0, accounts: 1, full: 2 };

/** The level a set of checks grants. `allows` is the evaluator, never a re-implementation of it. */
export function providerAccessFrom(allows: (permission: string) => boolean): ProviderAccess {
  if (allows(PROVIDERS_MANAGE)) return 'full';
  if (allows(PROVIDERS_ACCOUNTS)) return 'accounts';
  return 'none';
}

/** The caller's level. An anonymous request is `none`. */
export function requestProviderAccess(req: Request): ProviderAccess {
  if (!req.auth) return 'none';
  return providerAccessFrom((permission) => requestHasPermission(req, permission));
}

export function providerAccessReaches(access: ProviderAccess, wanted: Exclude<ProviderAccess, 'none'>): boolean {
  return RANK[access] >= RANK[wanted];
}

/** The permissions a refusal names: the ones that would open the level. */
function permissionsFor(wanted: Exclude<ProviderAccess, 'none'>): string | readonly string[] {
  return wanted === 'full' ? PROVIDERS_MANAGE : [PROVIDERS_MANAGE, PROVIDERS_ACCOUNTS];
}

export type ProviderGuardOptions = {
  /** Refuse anything but a person signed in to the app (a session or a paired device). */
  session?: boolean;
  /** The refusal's reason and hint when `session` refuses the daemon token or a mission token. */
  sessionReason?: string;
  sessionHint?: string;
};

/**
 * Answers 401 / 403 unless the caller reaches `wanted`. Returns the caller's
 * level when it does, `null` once the response is sent.
 */
export function requireProviderAccess(
  req: Request,
  res: Response,
  wanted: Exclude<ProviderAccess, 'none'>,
  options: ProviderGuardOptions = {},
): ProviderAccess | null {
  if (!req.auth) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  if (options.session && !isPersonAuth(req.auth)) {
    forbidden(req, res, {
      kind: 'operator',
      reason: options.sessionReason ?? 'only a person signed in to the app may do this',
      ...(options.sessionHint ? { hint: options.sessionHint } : {}),
    });
    return null;
  }
  const access = requestProviderAccess(req);
  if (!providerAccessReaches(access, wanted)) {
    forbidden(req, res, { kind: 'permission', permission: permissionsFor(wanted) });
    return null;
  }
  return access;
}
