'use client';

/**
 * The bottom-left notice cards (docs/NOTICES.md): a new version, a build
 * about to end, a GitHub star. Not a toast: a card stays until an action or
 * its × takes it away.
 *
 * The host owns everything but the painting: which cards show (at most
 * `NOTICES_VISIBLE_MAX`, warnings first), which ones the account closed for
 * good (read from the daemon, re-read when the window comes back), and the
 * sources — the entries of the `notices` slot, mounted here once each. Each
 * card is painted by the occupant of `notices.card`, or the product's card
 * while the slot is empty.
 */

import { useEffect, useMemo, type ReactElement } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PluginBoundary } from '@/lib/plugin-host/plugin-boundary';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { NOTICE_CARD_SLOT, NOTICES_SLOT, type SlotEntry } from '@/lib/plugin-host/slots';
import {
  NOTICES_VISIBLE_MAX, clearNoticesFrom, loadDismissedNotices, useVisibleNotices, type NoticeTone,
} from '@/lib/notices';
import { t } from '@/lib/i18n';
import { NoticeProvider, NoticeSourceProvider, noticeValue, useNotice } from './notice-context';

const TONE_ICON: Record<NoticeTone, typeof Info> = { info: Info, warning: AlertTriangle, success: CheckCircle2 };
const TONE_CLASS: Record<NoticeTone, string> = {
  info: 'text-primary',
  warning: 'text-amber-500',
  success: 'text-emerald-500',
};

/** The product's card: the default occupant of `notices.card`. `null` outside the host. */
export function ProductNoticeCard(): ReactElement | null {
  const value = useNotice();
  if (!value) return null;
  const { notice, dismiss, act } = value;
  const Icon = TONE_ICON[notice.tone];
  return (
    <div className="flex items-start gap-2.5 p-3" data-notice-card={notice.tone}>
      <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${TONE_CLASS[notice.tone]}`} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <p className="m-0 text-sm font-medium leading-snug">{notice.title}</p>
          {notice.body && <p className="m-0 whitespace-pre-line text-xs text-muted-foreground">{notice.body}</p>}
        </div>
        {notice.actions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {notice.actions.map((action, index) => (
              <Button
                key={`${index}:${action.label}`}
                size="sm"
                variant={index === 0 ? 'default' : 'ghost'}
                data-notice-action={index}
                onClick={() => act(index)}
              >
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      {notice.dismissible && (
        <button
          type="button"
          className="-mr-1 -mt-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t('notices.close')}
          title={t('notices.close')}
          data-notice-dismiss=""
          onClick={dismiss}
        >
          <X aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** One entry of `notices`, mounted once: its cards carry its plugin's name, and leave with it. */
function NoticeSourceMount({ entry }: { entry: SlotEntry }): ReactElement {
  const { Component, id, pluginId } = entry;
  const source = useMemo(() => ({ pluginId, origin: id }), [id, pluginId]);
  useEffect(() => () => clearNoticesFrom(id), [id]);
  return (
    <NoticeSourceProvider value={source}>
      <PluginBoundary pluginId={entry.pluginId}><Component /></PluginBoundary>
    </NoticeSourceProvider>
  );
}

/** Mounted once, in the root layout, beside the toaster. */
export function NoticesHost(): ReactElement {
  const sources = useSlotEntries(NOTICES_SLOT);
  const claimed = useSlotEntries(NOTICE_CARD_SLOT).length > 0;
  const notices = useVisibleNotices().slice(0, NOTICES_VISIBLE_MAX);

  useEffect(() => {
    void loadDismissedNotices();
    // A card closed on another client goes away when this window comes back.
    const onVisible = () => { if (document.visibilityState === 'visible') void loadDismissedNotices(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  return (
    <>
      {sources.length > 0 && (
        <div hidden data-notice-sources="">
          {sources.map((entry) => <NoticeSourceMount key={entry.id} entry={entry} />)}
        </div>
      )}
      {notices.length > 0 && (
        <section
          aria-label={t('notices.region')}
          className="pointer-events-none fixed bottom-3 left-[calc(var(--timon-nav-w)+0.75rem)] z-40 flex w-80 max-w-[calc(100vw-var(--timon-nav-w)-1.5rem)] flex-col gap-2"
          data-notices=""
        >
          {notices.map((notice) => (
            <div
              key={`${notice.pluginId}:${notice.id}`}
              role="status"
              className="timon-island pointer-events-auto bg-popover text-popover-foreground shadow-elev-3"
              data-notice={`${notice.pluginId}:${notice.id}`}
            >
              <NoticeProvider value={noticeValue(notice)}>
                {claimed ? <SlotSingle name={NOTICE_CARD_SLOT} /> : <ProductNoticeCard />}
              </NoticeProvider>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
