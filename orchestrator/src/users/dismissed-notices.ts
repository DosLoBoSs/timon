/**
 * The notices an account closed for good (the bottom-left cards of the
 * `notices` slot, `docs/NOTICES.md`): a list of keys stored as JSON in
 * `user_prefs.dismissed_notices`, so a card closed in the desktop app does not
 * come back in a browser.
 *
 * A key is `<pluginId>:<noticeId>`, written by the client host; the daemon
 * does not know which plugins push which cards and checks the shape only.
 * A notice that must come back for each version carries the version in its id.
 */
import { z } from 'zod';

/** A ceiling, not a product limit: past it the oldest keys are forgotten. */
export const DISMISSED_NOTICES_MAX = 500;

/** `@scope/name:notice-id`, `example-notice:welcome`, `@timon/settings:github-star`. */
export const DISMISSED_NOTICE_KEY_RE = /^[A-Za-z0-9@][A-Za-z0-9@/._:-]{0,199}$/;

export const DismissNoticeBodySchema = z.object({
  id: z.string().regex(DISMISSED_NOTICE_KEY_RE),
}).strict();

/** Appends `key` once, newest last, keeping at most `DISMISSED_NOTICES_MAX`. */
export function addDismissedNotice(list: readonly string[], key: string): string[] {
  const next = list.filter((item) => item !== key);
  next.push(key);
  return next.slice(-DISMISSED_NOTICES_MAX);
}

/** The stored column, read defensively: a malformed value is an empty list, never a throw. */
export function parseStoredDismissedNotices(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  let out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && DISMISSED_NOTICE_KEY_RE.test(item)) out = addDismissedNotice(out, item);
  }
  return out;
}
