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
import { clientOs, installersFor, type UpdateStatus } from './updates';

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
 * The installer the menu links for a download by hand (a browser, a server
 * without a window): the offered version's for this browser's system, else the
 * install page.
 */
export function manualInstallerUrl(status: UpdateStatus | null, userAgent: string): string {
  const offer = status?.state === 'available' ? status.available : null;
  if (!offer || !status) return INSTALL_PAGE_URL;
  return installersFor(offer, clientOs(userAgent), status.host)[0]?.url ?? INSTALL_PAGE_URL;
}

/** `PUT /api/ui/settings` answers the resolved setting: env and config win over a value written here. */
export function settingLockedBy(body: unknown): 'env' | 'config' | null {
  const setting = body && typeof body === 'object' ? (body as { setting?: { source?: unknown } }).setting : undefined;
  const source = setting?.source;
  return source === 'env' || source === 'config' ? source : null;
}
