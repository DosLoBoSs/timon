'use client';

/**
 * A newer Timon and the end of this build, as one bottom-left notice card
 * (docs/NOTICES.md, docs/AUTO-UPDATE.md §10). The product's source in the
 * `notices` slot, registered by the client half of `@timon/updates`.
 *
 * "Timon x.y.z is available", one main gesture, "Update", which goes through
 * `openUpdateDialog()` and opens the update window (`update-dialog.tsx`),
 * which this source provides and mounts: the card and the window run one flow,
 * so a download started in the window goes on in the card. Closing the
 * card is "later" for that version: its id carries the version, and the host
 * remembers it per account. A build about to stop running turns the card into
 * a warning that says when, back when the end becomes urgent even if the offer
 * was put off; with nothing newer published it is a card of its own, back at
 * the same stage.
 *
 * The lock screen of an ended build mounts no plugin host: it paints the same
 * flow with `LockScreenUpdateOffer`, which cannot be put off.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { useNotices } from '@/components/notices/notice-context';
import { NOTICE_BODY_MAX, type NoticeInput } from '@/lib/notices';
import {
  clientOs, installersFor, remindLater, useUpdateStore, visibleOffer, watchUpdateStatus,
  type UpdateOffer, type UpdateStatus,
} from '@/lib/updates';
import { useUpdateDownload, type UpdateDownloadControl } from '@/lib/update-download';
import { openUpdateDialog, provideUpdateDialog } from '@/lib/update-open';
import { expiryNotices, useLicense, type ExpiryNotice } from '@/lib/license';
import { formatDate } from '@/lib/intl';
import { t } from '@/lib/i18n';
import type { UpdateStatusValue } from './update-status-context';
import { useUpdateFlow, type UpdateFlowView } from './update-flow';
import { UpdateDialogHost, updateDialogValue } from './update-dialog';

export const UPDATE_NOTICE_PREFIX = 'update-';
export const BUILD_END_NOTICE_PREFIX = 'build-ends-';

/** What the flow is run for, or `null` when there is nothing to offer (no offer, a source build). */
export function updateValue(status: UpdateStatus | null, offer: UpdateOffer | null, download: UpdateDownloadControl | null): UpdateStatusValue | null {
  if (!offer || !status || status.channel === 'dev') return null;
  const os = typeof navigator === 'undefined' ? null : clientOs(navigator.userAgent);
  return {
    installed: status.installed,
    channel: status.channel,
    offer,
    installers: installersFor(offer, os, status.host),
    buildExpiresAt: status.buildExpiresAt,
    later: () => { remindLater(offer.version); },
    download,
  };
}

function dayOf(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toISOString().slice(0, 10);
}

function buildEnds(ending: ExpiryNotice): string {
  return t('updates.notice.buildEnds', { date: formatDate(ending.at, { year: 'numeric', month: 'numeric', day: 'numeric' }) });
}

/** The card for this offer, this build's end and where the flow stands; `null` when there is neither. */
export function updateNotice(offer: UpdateOffer | null, view: UpdateFlowView | null, ending: ExpiryNotice | null): NoticeInput | null {
  if (offer && view) {
    const lines = [ending ? buildEnds(ending) : null, view.line, view.command].filter((line): line is string => !!line);
    return {
      // As the end's own card: an offer put off weeks before comes back once the end is urgent.
      id: `${UPDATE_NOTICE_PREFIX}${offer.version}${ending?.urgent ? '-urgent' : ''}`,
      tone: ending || view.alert ? 'warning' : 'info',
      title: t('updates.notice.available', { version: offer.version }),
      // A long command path must not get the whole card refused.
      body: lines.length > 0 ? lines.join('\n').slice(0, NOTICE_BODY_MAX) : undefined,
      actions: view.actions.map((action) => ({ label: action.label, onSelect: action.run })),
    };
  }
  if (!ending) return null;
  // The urgent stage gets its own id: a card closed two weeks before comes back three days before.
  return { id: `${BUILD_END_NOTICE_PREFIX}${dayOf(ending.at)}${ending.urgent ? '-urgent' : ''}`, tone: 'warning', title: buildEnds(ending) };
}

/** What a card says, without its handlers: it is pushed again only when this changes. */
function noticeSignature(notice: NoticeInput | null): string {
  return notice ? JSON.stringify({ ...notice, actions: notice.actions?.map((action) => action.label) }) : '';
}

/** The product's source in the `notices` slot: pushes the card, and mounts the update window it opens. */
export function UpdateNotice(): ReactElement {
  const notices = useNotices();
  const push = notices?.push;
  const remove = notices?.remove;
  const store = useUpdateStore();
  const offer = visibleOffer(store);
  const download = useUpdateDownload(offer?.version ?? null);
  const value = useMemo(() => updateValue(store.status, offer, download), [download, offer, store.status]);
  const license = useLicense();
  const ending = useMemo(() => expiryNotices(license, Date.now()).find((item) => item.kind === 'build') ?? null, [license]);

  const beginRef = useRef<() => void>(() => undefined);
  const open = useMemo(() => () => { if (!openUpdateDialog()) beginRef.current(); }, []);
  const { view, begin } = useUpdateFlow(value, open);
  useEffect(() => { beginRef.current = begin; }, [begin]);
  const offered = value !== null;
  const [windowOpen, setWindowOpen] = useState(false);
  useEffect(() => (offered ? provideUpdateDialog(() => { setWindowOpen(true); }) : undefined), [offered]);
  useEffect(() => { if (!offered) setWindowOpen(false); }, [offered]);

  // Opening the window is "update now": the download starts, once per opening —
  // cancelled from the window, it stays cancelled until asked again.
  const startedRef = useRef(false);
  useEffect(() => {
    if (!windowOpen) { startedRef.current = false; return; }
    if (startedRef.current || !download) return;
    startedRef.current = true;
    if (download.state.phase === 'idle') download.start();
  }, [download, windowOpen]);
  const dialog = useMemo(
    () => (value && view ? updateDialogValue(value, view, () => { setWindowOpen(false); }) : null),
    [value, view],
  );

  const notice = updateNotice(offer, view, ending);
  // The handlers change at every render; the card calls the latest ones.
  const handlers = useRef<Array<() => void>>([]);
  useEffect(() => { handlers.current = notice?.actions?.map((action) => action.onSelect ?? (() => undefined)) ?? []; });
  const signature = noticeSignature(notice);
  const id = notice?.id ?? null;
  useEffect(() => {
    if (!push || !notice) return;
    push({
      ...notice,
      actions: notice.actions?.map((action, index) => ({ label: action.label, onSelect: () => handlers.current[index]?.() })),
    });
    // `notice` is read through its signature: pushing on every render would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [push, signature]);
  useEffect(() => (remove && id ? () => remove(id) : undefined), [id, remove]);
  return <UpdateDialogHost open={windowOpen} onOpenChange={setWindowOpen} value={dialog} />;
}

/**
 * The way out on the lock screen of a beta build that can no longer run
 * (docs/AUTO-UPDATE.md §4): the newer version and the same flow, with no
 * "later". No store and no event stream — the daemon walls the stream while
 * locked, and no plugin is mounted. Without the stream the screen reads the
 * status again while the daemon has not settled it: a screen opened right
 * after a restart comes before the daemon's first check.
 */
// `retryMs` defaults to `UPDATE_STATUS_RETRY_MS`; only tests shorten it.
export function LockScreenUpdateOffer({ retryMs }: { retryMs?: number }): ReactElement | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => watchUpdateStatus(setStatus, { intervalMs: retryMs }), [retryMs]);
  const offer = status?.state === 'available' ? status.available : null;
  const download = useUpdateDownload(offer?.version ?? null);
  const value = useMemo(() => updateValue(status, offer, download), [download, offer, status]);
  const { view } = useUpdateFlow(value);
  if (!offer || !view) return null;
  return (
    <section className="flex flex-col gap-3 rounded-xl bg-muted/40 p-5" data-lock-update-offer={offer.version} data-update-step={view.step}>
      <p className="m-0 text-sm font-semibold">{t('updates.notice.available', { version: offer.version })}</p>
      {view.line && <p className="m-0 text-sm tabular-nums" role={view.alert ? 'alert' : undefined}>{view.line}</p>}
      {/* code-font: a command to paste in a terminal */}
      {view.command && <code className="select-all rounded bg-background px-2 py-1 font-mono text-xs" data-update-command="">{view.command}</code>}
      {view.actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {view.actions.map((action, index) => (
            <Button key={action.marker} size="sm" variant={index === 0 ? 'default' : 'ghost'} onClick={action.run} data-update-action={action.marker}>
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}
