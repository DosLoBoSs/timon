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
 * while the slot is empty. `/?notices-preview=1` swaps the real cards for one
 * of each kind, for the life of the page (`notice-preview.ts`).
 */

import { useEffect, useMemo, type CSSProperties, type ReactElement } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PluginBoundary } from '@/lib/plugin-host/plugin-boundary';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { NOTICE_CARD_SLOT, NOTICES_SLOT, type SlotEntry } from '@/lib/plugin-host/slots';
import {
  NOTICES_VISIBLE_MAX, clearNoticesFrom, loadDismissedNotices, noticesPreviewActive, startNoticesPreview, useVisibleNotices,
} from '@/lib/notices';
import { t } from '@/lib/i18n';
import { NoticeProvider, NoticeSourceProvider, noticeValue, useNotice } from './notice-context';
import { noticeVisual } from './notice-visual';
import { noticesPreviewRequested, previewNotices } from './notice-preview';

/**
 * The product's card: the default occupant of `notices.card`. `null` outside the host.
 *
 * A pastille at the head (the notice's logo, or its tone's icon), a soft
 * gradient in the top-right corner in the same accent, the title, a short
 * body, and the actions at the bottom right: the main one as a filled
 * button, the other one, quieter, to its left. It slides in once, unless the
 * person asked for reduced motion.
 */
export function ProductNoticeCard(): ReactElement | null {
  const value = useNotice();
  if (!value) return null;
  const { notice, dismiss, act } = value;
  const visual = noticeVisual(notice);
  const { Glyph } = visual;
  // The main action is the first one; painted last, it lands in the corner.
  const actions = notice.actions.map((action, index) => ({ action, index })).reverse();
  return (
    <div
      className="relative flex flex-col gap-4 p-4 animate-in fade-in-0 slide-in-from-bottom-2 duration-300 ease-out motion-reduce:animate-none"
      style={{ '--notice-accent': visual.accent } as CSSProperties}
      data-notice-card={notice.tone}
      data-notice-visual={visual.key}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(120% 95% at 100% 0%, color-mix(in srgb, var(--notice-accent) 24%, transparent) 0%, color-mix(in srgb, var(--notice-accent) 8%, transparent) 38%, transparent 68%)' }}
      />
      <div className="relative flex items-start gap-3.5 pr-6">
        <span
          aria-hidden
          className="grid size-10 shrink-0 place-items-center rounded-xl"
          style={{
            color: visual.glyphColor,
            background: 'color-mix(in srgb, var(--notice-accent) 16%, transparent)',
            boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--notice-accent) 22%, transparent)',
          }}
          data-notice-glyph=""
        >
          <Glyph className={visual.wide ? 'h-auto w-6' : 'size-[22px]'} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
          <p className="m-0 text-[15px] font-semibold leading-snug tracking-tight">{notice.title}</p>
          {notice.body && <p className="m-0 whitespace-pre-line text-[13px] leading-relaxed text-muted-foreground">{notice.body}</p>}
        </div>
      </div>
      {actions.length > 0 && (
        <div className="relative flex flex-wrap items-center justify-end gap-2">
          {actions.map(({ action, index }) => (
            <Button
              key={`${index}:${action.label}`}
              size="sm"
              variant={index === 0 ? 'default' : 'ghost'}
              className={index === 0 ? 'h-8 rounded-lg px-4 shadow-sm' : 'h-8 rounded-lg px-3 text-muted-foreground'}
              data-notice-action={index}
              onClick={() => act(index)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
      {notice.dismissible && (
        <button
          type="button"
          className="absolute right-2.5 top-2.5 rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground"
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
  const visible = useVisibleNotices();
  // The preview shows every kind at once; the real stack keeps its cap.
  const notices = noticesPreviewActive() ? visible : visible.slice(0, NOTICES_VISIBLE_MAX);

  useEffect(() => {
    if (noticesPreviewRequested(window.location.search)) startNoticesPreview(previewNotices());
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
          className="pointer-events-none fixed bottom-3 left-[calc(var(--timon-nav-w)+0.75rem)] z-40 flex w-[380px] max-w-[calc(100vw-var(--timon-nav-w)-1.5rem)] flex-col gap-2.5"
          data-notices=""
        >
          {notices.map((notice) => (
            <div
              key={`${notice.pluginId}:${notice.id}`}
              role="status"
              className="timon-island pointer-events-auto [--timon-island-fill:hsl(var(--popover))] text-popover-foreground shadow-elev-3"
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
