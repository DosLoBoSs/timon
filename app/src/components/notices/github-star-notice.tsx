'use client';

/**
 * "A star on GitHub?" — the product's first notice source (an entry of the
 * `notices` slot, registered by the settings module).
 *
 * Shown once the app has been opened on `GITHUB_STAR_AFTER_DAYS` different
 * days in this browser: a person who came back that often knows what Timon is
 * worth to them. The rule is local and asks no server anything; the days are
 * counted per browser, the closing is remembered per account by the host.
 * Starring or closing ends it for good.
 */

import { useEffect } from 'react';
import { t } from '@/lib/i18n';
import { useNotices } from './notice-context';

export const GITHUB_STAR_NOTICE_ID = 'github-star';
export const GITHUB_STAR_AFTER_DAYS = 5;
export const GITHUB_REPOSITORY_URL = 'https://github.com/ai-timon/timon';
export const USAGE_DAYS_KEY = 'timon-notices-usage-days';

function localDay(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Records today among the days the app was opened, and returns how many
 * different days are known. Kept short: past the threshold, nothing more is
 * needed. An unreadable store counts nothing (private mode, quota).
 */
export function recordUsageDay(storage: Storage, now: Date = new Date()): number {
  let days: string[] = [];
  try {
    const raw = JSON.parse(storage.getItem(USAGE_DAYS_KEY) ?? '[]') as unknown;
    if (Array.isArray(raw)) days = raw.filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
  } catch {
    days = [];
  }
  const today = localDay(now);
  if (!days.includes(today)) days.push(today);
  days = days.slice(-GITHUB_STAR_AFTER_DAYS);
  try {
    storage.setItem(USAGE_DAYS_KEY, JSON.stringify(days));
  } catch {
    return 0;
  }
  return days.length;
}

export function GitHubStarNotice(): null {
  const notices = useNotices();
  const push = notices?.push;
  useEffect(() => {
    if (!push) return;
    let storage: Storage;
    try {
      storage = window.localStorage;
    } catch {
      return;
    }
    if (recordUsageDay(storage) < GITHUB_STAR_AFTER_DAYS) return;
    push({
      id: GITHUB_STAR_NOTICE_ID,
      tone: 'info',
      title: t('notices.githubStar.title'),
      actions: [{ label: t('notices.githubStar.action'), href: GITHUB_REPOSITORY_URL, dismiss: true }],
      dismissible: true,
    });
  }, [push]);
  return null;
}
