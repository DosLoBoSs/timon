'use client';

/**
 * The announcements of the signed notice feed (`timon-notices.json`,
 * docs/NOTICES.md), as an entry of the `notices` slot registered by the client
 * half of `@timon/updates`.
 *
 * The daemon has verified the feed and kept only what this build shows now;
 * this source turns each announcement into a card and takes down the ones the
 * feed no longer lists. Title and body are text, painted as text by the card;
 * the link is an action that opens it in a new window, never anything run.
 * Read again every half hour and when the window comes back.
 */

import { useEffect } from 'react';
import { t } from '@/lib/i18n';
import { NOTICE_ICONS, type NoticeIcon, type NoticeTone } from '@/lib/notices';
import { useNotices } from '@/components/notices/notice-context';

export const UPDATES_NOTICES_URL = '/api/ui/updates/notices';
/** Apart from the module's own cards (`update-<version>`): a feed id can never take one over. */
export const FEED_NOTICE_PREFIX = 'feed.';
export const FEED_REFRESH_MS = 30 * 60_000;

type FeedNotice = {
  id: string; tone: NoticeTone; icon: NoticeIcon | null; title: string; body: string; link: string | null; endsAt: string | null;
};

const TONES: readonly NoticeTone[] = ['info', 'warning', 'success'];

function asFeedNotice(raw: unknown): FeedNotice | null {
  if (!raw || typeof raw !== 'object') return null;
  const n = raw as Record<string, unknown>;
  if (typeof n.id !== 'string' || typeof n.title !== 'string' || typeof n.body !== 'string') return null;
  if (!TONES.includes(n.tone as NoticeTone)) return null;
  const link = typeof n.link === 'string' && n.link.startsWith('https://') ? n.link : null;
  const endsAt = typeof n.endsAt === 'string' ? n.endsAt : null;
  // A daemon newer than this app may name a logo it does not know: the tone's icon then.
  const icon = NOTICE_ICONS.includes(n.icon as NoticeIcon) ? n.icon as NoticeIcon : null;
  return { id: n.id, tone: n.tone as NoticeTone, icon, title: n.title, body: n.body, link, endsAt };
}

export function FeedNotices(): null {
  const notices = useNotices();
  const push = notices?.push;
  const remove = notices?.remove;
  useEffect(() => {
    if (!push || !remove) return;
    let shown = new Set<string>();
    let cancelled = false;
    const load = async () => {
      let list: unknown;
      try {
        const res = await fetch(UPDATES_NOTICES_URL, { cache: 'no-store' });
        if (!res.ok) return;
        list = ((await res.json()) as { notices?: unknown }).notices;
      } catch {
        return;
      }
      if (cancelled || !Array.isArray(list)) return;
      const next = new Set<string>();
      for (const raw of list) {
        const notice = asFeedNotice(raw);
        if (!notice || (notice.endsAt && Date.parse(notice.endsAt) <= Date.now())) continue;
        const id = `${FEED_NOTICE_PREFIX}${notice.id}`;
        try {
          push({
            id,
            tone: notice.tone,
            ...(notice.icon ? { icon: notice.icon } : {}),
            title: notice.title,
            body: notice.body,
            actions: notice.link ? [{ label: t('notices.feed.open'), href: notice.link, dismiss: true }] : [],
            dismissible: true,
          });
          next.add(id);
        } catch {
          // A card the store refuses stays off screen; the others still show.
        }
      }
      for (const id of shown) if (!next.has(id)) remove(id);
      shown = next;
    };
    void load();
    const timer = setInterval(() => { void load(); }, FEED_REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [push, remove]);
  return null;
}
