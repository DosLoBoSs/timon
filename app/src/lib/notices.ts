'use client';

/**
 * The bottom-left notice cards (docs/NOTICES.md): what the plugins pushed, and
 * which of them the account closed for good.
 *
 * One store for the document. A notice is data — a title, a line, two actions
 * at most — pushed by a plugin (`ctx.notices.push`, or `useNotices()` from an
 * entry of the `notices` slot) and painted by `NoticesHost` through the
 * `notices.card` slot. Its key is `<pluginId>:<id>`: two plugins may both say
 * `welcome`, and the daemon keeps the closed keys per account
 * (`/api/prefs/dismissed-notices`), so a card closed in the desktop app does
 * not come back in a browser.
 *
 * Nothing shows until that list has been read: a card the person closed must
 * not flash in at every load. No session (the sign-in page) means no list,
 * hence no card.
 */

import { useMemo, useSyncExternalStore } from 'react';

export type NoticeTone = 'info' | 'warning' | 'success';

/**
 * One button of a card. `href`: a page of the app (`/settings`) or an
 * `https:` / `http:` address, opened in a new window. `dismiss`: the click
 * also closes the card for good, as its × does.
 */
export type NoticeAction = {
  label: string;
  onSelect?: () => void;
  href?: string;
  dismiss?: boolean;
};

/** What a plugin pushes. `tone` defaults to `info`, `dismissible` to `true`. */
export type NoticeInput = {
  id: string;
  tone?: NoticeTone;
  title: string;
  body?: string;
  actions?: readonly NoticeAction[];
  dismissible?: boolean;
};

/** A notice as the card receives it: defaults applied, owner known. */
export type Notice = {
  id: string;
  pluginId: string;
  tone: NoticeTone;
  title: string;
  body: string | null;
  actions: readonly NoticeAction[];
  dismissible: boolean;
};

/** At most this many cards on screen; the others wait for one to leave. */
export const NOTICES_VISIBLE_MAX = 3;
export const NOTICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
export const NOTICE_TITLE_MAX = 120;
export const NOTICE_BODY_MAX = 400;
export const NOTICE_ACTIONS_MAX = 2;
export const NOTICE_LABEL_MAX = 40;
export const DISMISSED_NOTICES_ENDPOINT = '/api/ui/prefs/dismissed-notices';

const TONES: readonly NoticeTone[] = ['info', 'warning', 'success'];

type Entry = Notice & { origin: string; seq: number };

const entries = new Map<string, Entry>();
/** `null` until the daemon's list was read once. */
let dismissed: Set<string> | null = null;
let sequence = 0;
let version = 0;
const listeners = new Set<() => void>();

function publish(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function noticeKey(pluginId: string, id: string): string {
  return `${pluginId}:${id}`;
}

/** An app path or an http(s) address; anything else (`javascript:`, `//host`) is refused. */
function hrefAllowed(href: string): boolean {
  if (href.startsWith('/')) return !href.startsWith('//') && !href.startsWith('/\\');
  try {
    const url = new URL(href);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Why a pushed notice is refused, or `null`. */
export function noticeProblem(input: unknown): string | null {
  if (!input || typeof input !== 'object') return 'a notice is an object';
  const n = input as Record<string, unknown>;
  if (typeof n.id !== 'string' || !NOTICE_ID_RE.test(n.id)) return '`id` must be 1-96 letters, digits, `.`, `_`, `:` or `-`';
  if (n.tone !== undefined && !TONES.includes(n.tone as NoticeTone)) return '`tone` must be info, warning or success';
  if (typeof n.title !== 'string' || !n.title.trim() || n.title.length > NOTICE_TITLE_MAX) return `\`title\` must be 1-${NOTICE_TITLE_MAX} characters`;
  if (n.body !== undefined && (typeof n.body !== 'string' || n.body.length > NOTICE_BODY_MAX)) return `\`body\` must be at most ${NOTICE_BODY_MAX} characters`;
  if (n.dismissible !== undefined && typeof n.dismissible !== 'boolean') return '`dismissible` must be a boolean';
  if (n.actions !== undefined) {
    if (!Array.isArray(n.actions) || n.actions.length > NOTICE_ACTIONS_MAX) return `\`actions\` must be a list of at most ${NOTICE_ACTIONS_MAX}`;
    for (const raw of n.actions as unknown[]) {
      const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      if (typeof a.label !== 'string' || !a.label.trim() || a.label.length > NOTICE_LABEL_MAX) return `an action's \`label\` must be 1-${NOTICE_LABEL_MAX} characters`;
      if (a.onSelect !== undefined && typeof a.onSelect !== 'function') return 'an action\'s `onSelect` must be a function';
      if (a.href !== undefined && (typeof a.href !== 'string' || !hrefAllowed(a.href))) return 'an action\'s `href` must be an app path (`/…`) or an http(s) address';
      if (a.onSelect === undefined && a.href === undefined && a.dismiss !== true) return 'an action needs `onSelect`, `href` or `dismiss: true`';
      if (a.dismiss !== undefined && typeof a.dismiss !== 'boolean') return 'an action\'s `dismiss` must be a boolean';
    }
  }
  return null;
}

/**
 * Shows a card, or updates it when `pluginId` already pushed that `id`. A
 * closed one stays closed: pushing it again shows nothing. Throws on an
 * invalid notice, so the plugin's author sees why in the console.
 * `origin` groups what one source pushed, to take it away with the source.
 */
export function pushNotice(pluginId: string, origin: string, input: NoticeInput): void {
  const problem = noticeProblem(input);
  if (problem) throw new Error(`plugin \`${pluginId}\`: notice refused — ${problem}`);
  const key = noticeKey(pluginId, input.id);
  const previous = entries.get(key);
  entries.set(key, {
    id: input.id,
    pluginId,
    tone: input.tone ?? 'info',
    title: input.title,
    body: input.body?.trim() ? input.body : null,
    actions: (input.actions ?? []).map((a) => ({ ...a })),
    dismissible: input.dismissible ?? true,
    origin,
    seq: previous?.seq ?? ++sequence,
  });
  publish();
}

/** Takes a card off the screen, without closing it for good: pushed again, it comes back. */
export function removeNotice(pluginId: string, id: string): void {
  if (entries.delete(noticeKey(pluginId, id))) publish();
}

/** Everything one source pushed: called when the source leaves (plugin off, entry unregistered). */
export function clearNoticesFrom(origin: string): void {
  let changed = false;
  for (const [key, entry] of entries) {
    if (entry.origin === origin) { entries.delete(key); changed = true; }
  }
  if (changed) publish();
}

function strip(entry: Entry): Notice {
  return {
    id: entry.id, pluginId: entry.pluginId, tone: entry.tone, title: entry.title, body: entry.body,
    actions: entry.actions, dismissible: entry.dismissible,
  };
}

/** Every card that may show, in the order they stack: warnings first, then the oldest. */
export function visibleNotices(): Notice[] {
  if (!dismissed) return [];
  const closed = dismissed;
  return [...entries.entries()]
    .filter(([key]) => !closed.has(key))
    .map(([, entry]) => entry)
    .sort((a, b) => (Number(b.tone === 'warning') - Number(a.tone === 'warning')) || a.seq - b.seq)
    .map(strip);
}

/** What `pluginId` pushed and is still up (not closed), whether on screen or waiting. */
export function noticesOf(pluginId: string): Notice[] {
  return visibleNotices().filter((n) => n.pluginId === pluginId);
}

/** Whether the daemon's list has been read: before that, nothing is shown. */
export function dismissedNoticesLoaded(): boolean {
  return dismissed !== null;
}

/**
 * Reads the closed keys from the daemon. A refusal (no session) or a
 * failure leaves the previous state: before the first answer, no card.
 * Keys closed in this page meanwhile are kept.
 */
export async function loadDismissedNotices(): Promise<void> {
  let list: unknown;
  try {
    const res = await fetch(DISMISSED_NOTICES_ENDPOINT, { cache: 'no-store' });
    if (!res.ok) return;
    list = ((await res.json()) as { dismissed?: unknown }).dismissed;
  } catch {
    return;
  }
  if (!Array.isArray(list)) return;
  const next = new Set<string>(dismissed ?? []);
  for (const key of list) if (typeof key === 'string') next.add(key);
  dismissed = next;
  publish();
}

/**
 * Closes a card for good: off the screen at once, then remembered by the
 * daemon for the account. A failed write keeps it closed in this page.
 */
export function dismissNotice(pluginId: string, id: string): void {
  const key = noticeKey(pluginId, id);
  dismissed = new Set(dismissed ?? []);
  dismissed.add(key);
  publish();
  void fetch(DISMISSED_NOTICES_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: key }),
  }).catch(() => { /* kept closed in this page; the next load asks again */ });
}

/**
 * Runs an action of a card: its `onSelect`, then its `href` (an app path in
 * this window, an address in a new one), then closes the card for good when
 * the action says `dismiss`. A throwing `onSelect` does not keep the card.
 */
export function runNoticeAction(notice: Notice, index: number): void {
  const action = notice.actions[index];
  if (!action) return;
  try {
    action.onSelect?.();
  } catch (error) {
    console.error(`[notices] ${notice.pluginId}: action failed`, error);
  }
  if (action.href) {
    if (action.href.startsWith('/')) window.location.assign(action.href);
    else window.open(action.href, '_blank', 'noopener,noreferrer');
  }
  if (action.dismiss) dismissNotice(notice.pluginId, notice.id);
}

export function subscribeNotices(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function noticesVersion(): number {
  return version;
}

/** The cards that may show, re-read on every change; stable between changes. */
export function useVisibleNotices(): Notice[] {
  const v = useSyncExternalStore(subscribeNotices, noticesVersion, noticesVersion);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => visibleNotices(), [v]);
}

/** Same, for one plugin's own cards. */
export function usePluginNotices(pluginId: string): Notice[] {
  const v = useSyncExternalStore(subscribeNotices, noticesVersion, noticesVersion);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => noticesOf(pluginId), [pluginId, v]);
}

export function resetNoticesForTests(): void {
  entries.clear();
  dismissed = null;
  sequence = 0;
  publish();
}
