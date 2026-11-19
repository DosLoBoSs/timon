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
