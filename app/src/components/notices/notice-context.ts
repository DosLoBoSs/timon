'use client';

/**
 * What the two notice slots hand their occupants (docs/NOTICES.md). Neither
 * slot passes props: `NoticesHost` puts the value in context.
 *
 * - An entry of `notices` (a source) reads `useNotices()`: push, update and
 *   take away its own cards, under its plugin's name.
 * - The occupant of `notices.card` reads `useNotice()`: the card it paints and
 *   its two gestures. It never fetches nor remembers anything.
 */

import { createContext, useContext, useMemo } from 'react';
import {
  dismissNotice, pushNotice, removeNotice, runNoticeAction, usePluginNotices,
  type Notice, type NoticeInput,
} from '@/lib/notices';

export type NoticeSource = { pluginId: string; origin: string };

const NoticeSourceContext = createContext<NoticeSource | null>(null);
export const NoticeSourceProvider = NoticeSourceContext.Provider;

export type NoticesValue = {
  /** This plugin's cards still up (not closed), on screen or waiting for room. */
  notices: Notice[];
  /** Shows a card, or updates the one with the same `id`. A closed one stays closed. */
  push: (notice: NoticeInput) => void;
  /** Takes a card off the screen without closing it for good. */
  remove: (id: string) => void;
};

/** Readable by an entry of the `notices` slot; `null` anywhere else. */
export function useNotices(): NoticesValue | null {
  const source = useContext(NoticeSourceContext);
  const notices = usePluginNotices(source?.pluginId ?? '');
  // Stable while the source is: a source pushes from an effect that depends
  // on `push`, and its own push changes `notices`.
  const gestures = useMemo(() => source && {
    push: (notice: NoticeInput) => pushNotice(source.pluginId, source.origin, notice),
    remove: (id: string) => removeNotice(source.pluginId, id),
  }, [source]);
  return useMemo(() => gestures && { notices, ...gestures }, [gestures, notices]);
}

export type NoticeValue = {
  notice: Notice;
  /** Closes the card for good, for this account on every client. Only when `notice.dismissible`. */
  dismiss: () => void;
  /** Runs `notice.actions[index]`: its `onSelect`, its `href`, its `dismiss`. */
  act: (index: number) => void;
};

const NoticeContext = createContext<NoticeValue | null>(null);
export const NoticeProvider = NoticeContext.Provider;

/** Readable by the occupant of `notices.card`; `null` outside a card. */
export function useNotice(): NoticeValue | null {
  return useContext(NoticeContext);
}

export function noticeValue(notice: Notice): NoticeValue {
  return {
    notice,
    dismiss: () => { if (notice.dismissible) dismissNotice(notice.pluginId, notice.id); },
    act: (index: number) => runNoticeAction(notice, index),
  };
}
