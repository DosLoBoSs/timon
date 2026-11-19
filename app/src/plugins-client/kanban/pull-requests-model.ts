/**
 * What the "Open pull requests" widget reads from the daemon
 * (`GET /api/projects/:slug/pull-requests`), and the little logic it keeps
 * out of the component: the author filter and the verdict a row shows.
 */

export type ReviewVerdict = 'mergeable' | 'changes_requested' | 'reject' | 'product_decision';
export type ReviewState = 'draft' | 'running' | 'done' | 'failed';

export type PullReview = {
  id: string;
  number: number;
  state: ReviewState;
  agent: string;
  verdict: ReviewVerdict | null;
  report: string | null;
  mission_id: string | null;
  pr_updated_at: string | null;
  updated_at: number;
};

import type { JobLinks } from './landing-api';
import type { BranchGestures, BranchLock } from './forge-branch-api';

/** The way back from a pull request (`forge-links.ts`): our job behind it, when the reader sees it. */
export type PullRequestLinks = JobLinks & { job_id: string | null };

export type PullRequestItem = {
  number: number;
  title: string;
  author: string | null;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  headOwner: string | null;
  external: boolean;
  review: PullReview | null;
  /** Absent from an older daemon. */
  links?: PullRequestLinks;
  /** How GitHub sees the branch against its base (`dirty`: in conflict, `behind`); absent from an older daemon. */
  mergeStateStatus?: string;
  /** What the person may do about the branch (`forge-branch-update.ts`); absent from an older daemon. */
  gestures?: BranchGestures;
};

export type PullRequestList = { repo: string; pulls: PullRequestItem[] };

/** The authors of the list, each once, sorted; a deleted account is left out. */
export function pullAuthors(pulls: readonly PullRequestItem[]): string[] {
  return [...new Set(pulls.map((p) => p.author).filter((a): a is string => !!a))]
    .sort((a, b) => a.localeCompare(b));
}

/** The pull requests of `author`, all of them when it is null. */
export function filterByAuthor(pulls: readonly PullRequestItem[], author: string | null): PullRequestItem[] {
  return author === null ? [...pulls] : pulls.filter((p) => p.author === author);
}

/** What the row says of its review: nothing for a draft never sent. */
export type ReviewBadge =
  | { kind: 'running' }
  | { kind: 'failed' }
  | { kind: 'verdict'; verdict: ReviewVerdict | null; outdated: boolean };

export function reviewBadge(pull: PullRequestItem): ReviewBadge | null {
  const review = pull.review;
  if (!review || review.state === 'draft') return null;
  if (review.state === 'running') return { kind: 'running' };
  if (review.state === 'failed') return { kind: 'failed' };
  // ISO dates compare as text: a later change of the pull request makes the
  // verdict one about code that is no longer there.
  const outdated = !!review.pr_updated_at && !!pull.updatedAt && pull.updatedAt > review.pr_updated_at;
  return { kind: 'verdict', verdict: review.verdict, outdated };
}

/** True while a review runs: the widget then asks again for its verdict. */
export function anyReviewRunning(pulls: readonly PullRequestItem[]): boolean {
  return pulls.some((p) => p.review?.state === 'running');
}

/** What the row says of its branch: only a state that calls for a gesture. */
export function branchChip(pull: PullRequestItem): 'conflict' | 'behind' | null {
  if (pull.mergeStateStatus === 'dirty') return 'conflict';
  if (pull.mergeStateStatus === 'behind' && pull.gestures?.update_branch) return 'behind';
  return null;
}

/**
 * Why the branch cannot be written from here, said on the row: without it,
 * a missing "Update the branch" or "Resolve the conflict…" has no reason.
 */
export function branchLock(pull: PullRequestItem): BranchLock | null {
  return pull.gestures?.locked ?? null;
}

/**
 * How old a hidden tab's list may be before it is read again. The PR tab of
 * the Git stack stays mounted behind the front tab for its count; reading
 * the list at every mount would start `gh` for a list nobody sees.
 */
export const HIDDEN_PULLS_FRESH_MS = 60_000;

/**
 * Whether the widget reads its list now: always in front; behind another tab
 * only when no list was read for the project on this page, or the last one
 * is older than `HIDDEN_PULLS_FRESH_MS`.
 */
export function shouldReadPulls(front: boolean, readAt: number | null, now: number): boolean {
  return front || readAt === null || now - readAt >= HIDDEN_PULLS_FRESH_MS;
}

/** The last list read per project, shared by every PR widget of the page. */
const lastRead = new Map<string, { list: PullRequestList; at: number }>();

export function lastPullList(slug: string): { list: PullRequestList; at: number } | undefined {
  return lastRead.get(slug);
}

export function keepPullList(slug: string, list: PullRequestList, at = Date.now()): void {
  lastRead.set(slug, { list, at });
}

/** For tests: a page that starts with nothing read. */
export function forgetPullListsForTests(): void {
  lastRead.clear();
}
