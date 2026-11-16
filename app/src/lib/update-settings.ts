/**
 * What the row of Settings › System › Updates says and offers, from the
 * daemon's update status (`GET /api/ui/updates`). Pure, so every state is
 * pinned by a test; the pane only paints it.
 *
 * One action at most: "Check" (or "Retry" after a failure) for an account
 * holding `settings:write`, "Update" when a newer version is offered. A source
 * build and a switched-off check offer nothing here: the menu turns the check
 * back on.
 */
import { BRAND } from './brand';
import { clientOs, installersFor, type UpdateArtifact, type UpdateStatus } from './updates';

export type UpdateRowAction = 'check' | 'retry' | 'checking' | 'update' | 'none';

export type UpdateRowStatus =
  | { kind: 'upToDate'; checkedAt: string | null }
  | { kind: 'available'; installed: string; checkedAt: string | null }
  | { kind: 'unchecked' }
  | { kind: 'checking' }
  | { kind: 'failed' }
  | { kind: 'off' }
  | { kind: 'dev' }
  | { kind: 'unknown' };

export type UpdateRowView = {
  /** The version the title names: the offered one when there is one. */
  version: string | null;
  available: boolean;
  status: UpdateRowStatus;
  action: UpdateRowAction;
};

export type UpdateRowInput = {
  status: UpdateStatus | null;
  /** A check asked from this page is under way. */
  checking: boolean;
  /** The last check asked from this page got no answer (network, refusal). */
  checkFailed: boolean;
  /** The account may ask for a check and switch it (`settings:write`). */
  canWrite: boolean;
};

export function updateRowView({ status, checking, checkFailed, canWrite }: UpdateRowInput): UpdateRowView {
  const ask = (failed: boolean): UpdateRowAction => (canWrite ? (failed ? 'retry' : 'check') : 'none');
  if (!status) {
    if (checking) return { version: null, available: false, status: { kind: 'checking' }, action: 'checking' };
    return { version: null, available: false, status: { kind: checkFailed ? 'failed' : 'unknown' }, action: checkFailed ? ask(true) : 'none' };
  }
  if (status.state === 'dev') return { version: status.installed, available: false, status: { kind: 'dev' }, action: 'none' };
  if (status.state === 'off') return { version: status.installed, available: false, status: { kind: 'off' }, action: 'none' };
  const offer = status.state === 'available' ? status.available : null;
  if (offer) {
    return {
      version: offer.version,
      available: true,
      status: checking ? { kind: 'checking' } : { kind: 'available', installed: status.installed, checkedAt: status.checkedAt },
      action: 'update',
    };
  }
  if (checking) return { version: status.installed, available: false, status: { kind: 'checking' }, action: 'checking' };
  if (checkFailed || status.state === 'failed') return { version: status.installed, available: false, status: { kind: 'failed' }, action: ask(true) };
  if (status.state === 'unchecked') return { version: status.installed, available: false, status: { kind: 'unchecked' }, action: ask(false) };
  return { version: status.installed, available: false, status: { kind: 'upToDate', checkedAt: status.checkedAt }, action: ask(false) };
}

/** The public changelog, for the menu while no version is offered. */
export const CHANGELOG_URL = `https://docs.${BRAND.domain}/changelog`;
/** The install page: every installer, for a browser on a phone or an unknown system. */
export const INSTALL_PAGE_URL = `https://${BRAND.domain}/install`;

/** The release notes the menu links: the offered version's, or the changelog. */
export function releaseNotesUrl(status: UpdateStatus | null): string {
  const offer = status?.state === 'available' ? status.available : null;
  return offer?.notesUrl ?? CHANGELOG_URL;
}

/**
 * Where a version is fetched by hand (a browser, a window on another machine):
 * the installer of this system, else the install page that lists them all —
 * never the release notes, which install nothing. The one answer the update
 * card, the update window and Settings › System › Updates share; its label
 * follows `forThisSystem`.
 */
export type InstallerLink = { href: string; forThisSystem: boolean };

export function installerLink(installers: readonly UpdateArtifact[]): InstallerLink {
  const first = installers[0];
  return first ? { href: first.url, forThisSystem: true } : { href: INSTALL_PAGE_URL, forThisSystem: false };
}

/** The link the menu offers, from the daemon's status and this browser's system. */
export function manualInstallerLink(status: UpdateStatus | null, userAgent: string): InstallerLink {
  const offer = status?.state === 'available' ? status.available : null;
  return installerLink(offer && status ? installersFor(offer, clientOs(userAgent), status.host) : []);
}

/** `PUT /api/ui/settings` answers the resolved setting: env and config win over a value written here. */
export function settingLockedBy(body: unknown): 'env' | 'config' | null {
  const setting = body && typeof body === 'object' ? (body as { setting?: { source?: unknown } }).setting : undefined;
  const source = setting?.source;
  return source === 'env' || source === 'config' ? source : null;
}

export const NOTICES_SETTING = 'TIMON_NOTICES_CHECK';

/** The value of `TIMON_NOTICES_CHECK` in `GET /api/ui/settings`, or `null` when the answer does not carry it. */
export function noticesSettingValue(body: unknown): boolean | null {
  const settings = body && typeof body === 'object' ? (body as { settings?: unknown }).settings : undefined;
  if (!Array.isArray(settings)) return null;
  const row: unknown = settings.find((s: unknown) => !!s && typeof s === 'object' && (s as { key?: unknown }).key === NOTICES_SETTING);
  const value = row && typeof row === 'object' ? (row as { value?: unknown }).value : undefined;
  return typeof value === 'boolean' ? value : null;
}

export type NoticesSwitchView = { on: boolean; disabled: boolean };

/**
 * The "Announcements" switch: the update check off stops the feed too
 * (docs/AUTO-UPDATE.md §10), so the switch shows off and cannot be moved
 * until the check is back on. An unknown value reads as the default, on.
 */
export function noticesSwitchView({ updatesEnabled, notices }: { updatesEnabled: boolean; notices: boolean | null }): NoticesSwitchView {
  if (!updatesEnabled) return { on: false, disabled: true };
  return { on: notices ?? true, disabled: false };
}
