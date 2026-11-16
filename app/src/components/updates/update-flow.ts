'use client';

/**
 * The steps of "update now" (docs/AUTO-UPDATE.md §10): in the desktop app the
 * shell downloads, verifies, then installs the system's way, missions counted
 * first; a browser links the installer. One state machine painted in three
 * places — the update notice card, the update window it opens, and the lock
 * screen of an ended build — so the view is text and gestures only, each place
 * deciding its own look.
 */

import { useEffect, useMemo, useState } from 'react';
import { formatBytes, formatPercent } from '@/lib/intl';
import type { UpdateDownloadErrorCode, UpdateInstallOutcome } from '@/lib/update-download';
import { copyToClipboard } from '@/lib/clipboard';
import { t } from '@/lib/i18n';
import type { UpdateStatusValue } from './update-status-context';

export type UpdateFlowAction = {
  label: string;
  run: () => void;
  /** What the gesture is, for a `data-` attribute. */
  marker: string;
};

export type UpdateFlowView = {
  /** Where the flow stands, for a `data-` attribute. */
  step: string;
  /** One line under the title: the progress, a refusal, what follows. */
  line: string | null;
  /** A command to paste in a terminal: a `.deb` the system did not install. */
  command: string | null;
  alert: boolean;
  /** At most two, the main one first. */
  actions: UpdateFlowAction[];
};

const DOWNLOAD_ERROR: Record<UpdateDownloadErrorCode, string> = {
  no_offer: 'updates.download.error.noOffer',
  daemon: 'updates.download.error.daemon',
  network: 'updates.download.error.network',
  http: 'updates.download.error.http',
  insecure_redirect: 'updates.download.error.insecure',
  too_many_redirects: 'updates.download.error.insecure',
  size: 'updates.download.error.integrity',
  integrity: 'updates.download.error.integrity',
  disk_full: 'updates.download.error.diskFull',
  filesystem: 'updates.download.error.filesystem',
};

/**
 * Starts the flow where it stands: the shell's download, the install of a
 * file already verified, or — outside the desktop app — the installer for
 * this system (the release page when none fits).
 */
export function beginUpdate(value: UpdateStatusValue, install: () => void): void {
  const { download } = value;
  if (download) {
    if (download.state.phase === 'ready') install();
    else if (download.state.phase !== 'downloading' && download.state.phase !== 'verifying') download.start();
    return;
  }
  const target = value.installers[0]?.url ?? value.offer.notesUrl;
  window.open(target, '_blank', 'noopener,noreferrer');
}

/**
 * The flow for `value`, `null` while there is nothing to offer. `open` is
 * the main gesture before anything started: the card goes through
 * `openUpdateDialog()`, the lock screen starts at once.
 */
export function useUpdateFlow(value: UpdateStatusValue | null, open?: () => void): { view: UpdateFlowView | null; begin: () => void } {
  const control = value?.download ?? null;
  const state = control?.state ?? null;
  const [installing, setInstalling] = useState(false);
  const [outcome, setOutcome] = useState<UpdateInstallOutcome | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const readyFile = state?.phase === 'ready' ? `${state.version}/${state.name}` : null;
  // A new file (another version, a new download) starts from "Install" again.
  useEffect(() => { setOutcome(null); setOpenFailed(false); setCopied(false); }, [readyFile]);

  const gestures = useMemo(() => {
    const openWith = (gesture: () => Promise<{ status: string }>): void => {
      setOpenFailed(false);
      void gesture().then((result) => { setOpenFailed(result.status !== 'opened'); });
    };
    const install = (confirmed: boolean): void => {
      if (!control) return;
      setInstalling(true);
      setOpenFailed(false);
      void control.install(confirmed).then((result) => {
        setInstalling(false);
        // A desktop older than the installation step: open the installer as before.
        if (result.status === 'unsupported') { setOutcome(null); openWith(control.openInstaller); return; }
        // The password prompt was dismissed: back to "Install", nothing to report.
        if (result.status === 'cancelled') { setOutcome(null); return; }
        setOutcome(result);
      });
    };
    const begin = (): void => { if (value) beginUpdate(value, () => install(false)); };
    return { begin, install, openWith };
  }, [control, value]);

  const view = useMemo((): UpdateFlowView | null => {
    if (!value) return null;
    const { begin, install, openWith } = gestures;
    const update: UpdateFlowAction = { label: t('updates.notice.update'), run: open ?? begin, marker: 'update' };
    if (!control || !state) return { step: 'offer', line: null, command: null, alert: false, actions: [update] };
    const showFolder: UpdateFlowAction = { label: t('updates.download.openFolder'), run: () => openWith(control.openFolder), marker: 'open-folder' };
    const downloadAgain = (): void => { setOutcome(null); control.start(); };
    if (state.phase === 'downloading') {
      return {
        step: 'downloading',
        line: t('updates.download.progress', {
          percent: formatPercent(state.total > 0 ? state.received / state.total : 0),
          received: formatBytes(state.received),
          total: formatBytes(state.total),
        }),
        command: null,
        alert: false,
        actions: [{ label: t('updates.download.cancel'), run: control.cancel, marker: 'cancel' }],
      };
    }
    if (state.phase === 'verifying') return { step: 'verifying', line: t('updates.download.verifying'), command: null, alert: false, actions: [] };
    if (state.phase === 'failed') {
      return {
        step: 'download-failed',
        line: t(DOWNLOAD_ERROR[state.code]),
        command: null,
        alert: true,
        actions: [{ label: t(state.resumable ? 'updates.download.resume' : 'updates.download.retry'), run: control.start, marker: 'retry' }],
      };
    }
    if (state.phase !== 'ready') return { step: 'idle', line: null, command: null, alert: false, actions: [update] };

    if (installing) return { step: 'installing', line: t('updates.download.installing'), command: null, alert: false, actions: [] };
    const installAction: UpdateFlowAction = {
      label: t(state.format === 'appimage' ? 'updates.download.installRestart' : 'updates.download.install'),
      run: () => install(false),
      marker: 'install',
    };
    const said = (step: string, key: string): UpdateFlowView => ({ step, line: t(key), command: null, alert: false, actions: [] });
    switch (outcome?.status) {
      case 'missions':
        return {
          step: 'missions',
          line: t('updates.download.missions', { count: outcome.count }),
          command: null,
          alert: true,
          actions: [
            { label: t('updates.download.installAnyway'), run: () => install(true), marker: 'install-anyway' },
            { label: t('updates.download.wait'), run: () => setOutcome(null), marker: 'wait' },
          ],
        };
      case 'restarting': return said('restarting', 'updates.download.restarting');
      case 'closing': return said('closing', 'updates.download.closing');
      case 'opened': return said('opened', 'updates.download.pkgOpened');
      case 'guided':
        return {
          step: 'guided',
          line: t(outcome.opened ? 'updates.download.debGuided' : 'updates.download.debNotOpened'),
          command: outcome.command,
          alert: false,
          actions: [{
            label: t(copied ? 'updates.download.copied' : 'updates.download.copyCommand'),
            run: () => { void copyToClipboard(outcome.command).then(setCopied); },
            marker: 'copy',
          }],
        };
      case 'not_writable':
        return { step: 'not-writable', line: t('updates.download.notWritable'), command: null, alert: true, actions: [showFolder] };
      case 'none':
        // The shell has no verified file any more (removed from the data folder, a download reset): fetch it again.
        return {
          step: 'none',
          line: t('updates.download.installNone'),
          command: null,
          alert: true,
          actions: [{ label: t('updates.download.downloadAgain'), run: downloadAgain, marker: 'download-again' }],
        };
      case 'failed':
        return { step: 'install-failed', line: t('updates.download.installFailed'), command: null, alert: true, actions: [installAction] };
      default:
        return {
          step: 'ready',
          line: openFailed ? t('updates.download.openFailed') : t('updates.download.ready', { name: state.name }),
          command: null,
          alert: openFailed,
          actions: openFailed ? [installAction, showFolder] : [installAction],
        };
    }
  }, [gestures, control, copied, installing, open, openFailed, outcome, state, value]);

  return { view, begin: gestures.begin };
}
