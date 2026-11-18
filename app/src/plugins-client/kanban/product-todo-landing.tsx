'use client';

/**
 * The product's occupant of `kanban.todo.landing`: where the branch of an
 * idea's jobs stands, as one chip. Read-only and derived by the daemon; the
 * work's own progress is the other chip, never this one.
 *
 * An open, merged or closed pull request is a link that opens it in the
 * browser (a click on it does not open the idea: `BoardCard` leaves links to
 * themselves). Several jobs: the chip shows the one furthest from landing, the
 * tooltip lists them all.
 */

import type { ReactElement } from 'react';
import { GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, type LucideIcon } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { safeHref } from './project-todo-links';
import { useTodoItem } from './todo-badge-slot';
import type { TodoLanding, TodoLandingJob, TodoLandingState } from './project-todo-types';

// Same shape as the urgency and progress chips beside it.
const CHIP = 'inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-[10.5px] font-medium leading-4';

const LANDING_CLASS: Record<TodoLandingState, string> = {
  branch: 'border-transparent bg-foreground/[0.06] text-muted-foreground',
  pending: 'border-transparent bg-amber-500/[0.14] text-amber-700 dark:text-amber-300',
  open: 'border-transparent bg-emerald-500/[0.12] text-emerald-700 dark:text-emerald-400',
  merged: 'border-transparent bg-violet-500/[0.12] text-violet-700 dark:text-violet-300',
  closed: 'border-transparent bg-rose-500/[0.12] text-rose-700 dark:text-rose-300',
};

const LANDING_ICON: Record<TodoLandingState, LucideIcon> = {
  branch: GitBranch,
  pending: GitPullRequestDraft,
  open: GitPullRequest,
  merged: GitMerge,
  closed: GitPullRequestClosed,
};

/** What a job says in a few words: its pull request when it has one. */
export function landingLabel(job: TodoLandingJob): string {
  const number = job.prNumber;
  switch (job.state) {
    case 'branch': return t('projectTodo.landing.branch');
    case 'pending': return t('projectTodo.landing.pending');
    case 'open': return number === null ? t('projectTodo.landing.openNoNumber') : t('projectTodo.landing.open', { number });
    case 'merged': return number === null ? t('projectTodo.landing.mergedNoNumber') : t('projectTodo.landing.merged', { number });
    case 'closed': return number === null ? t('projectTodo.landing.closedNoNumber') : t('projectTodo.landing.closed', { number });
  }
}

const TIP = 'rounded-md bg-popover px-2 py-1 text-[11.5px] text-popover-foreground shadow-elev-2';

/** The chip of `landing`, a link when its pull request has a safe URL. */
export function TodoLandingBadge({ landing }: { landing: TodoLanding }): ReactElement {
  const Icon = LANDING_ICON[landing.state];
  const label = landingLabel(landing);
  const href = safeHref(landing.prUrl);
  const several = landing.jobs.length > 1;
  const detail = landing.jobs.map((job) => `${job.branch}: ${landingLabel(job)}`);
  const accessible = several ? `${label} · ${detail.join(' · ')}` : `${label} · ${landing.branch}`;
  const body = (
    <>
      <Icon className="size-3" aria-hidden />
      <span className="tabular-nums">{label}</span>
      {several && <span className="tabular-nums opacity-70">+{landing.jobs.length - 1}</span>}
    </>
  );
  const chip = href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-todo-landing={landing.state}
      aria-label={`${accessible} · ${t('projectTodo.landing.openPr')}`}
      className={cn(CHIP, LANDING_CLASS[landing.state], 'underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
    >
      {body}
    </a>
  ) : (
    <span data-todo-landing={landing.state} aria-label={accessible} tabIndex={several ? 0 : undefined} className={cn(CHIP, LANDING_CLASS[landing.state])}>
      {body}
    </span>
  );
  return (
    <TooltipProvider delayDuration={300} skipDelayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent side="top" sideOffset={4} className={TIP}>
          {several ? (
            <ul data-todo-landing-jobs={landing.jobs.length} className="flex flex-col gap-0.5">
              {landing.jobs.map((job, i) => <li key={`${job.branch}:${i}`}>{detail[i]}</li>)}
            </ul>
          ) : landing.branch}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Reads the idea from `useTodoItem()`, as a plugin's replacement would. */
export function ProductTodoLanding(): ReactElement | null {
  const landing = useTodoItem()?.landing;
  return landing ? <TodoLandingBadge landing={landing} /> : null;
}
