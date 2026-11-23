'use client';

/**
 * The detail window of a pull request, opened by a click on its row in the
 * Pull requests widget: what GitHub's page shows, read only. The header (state,
 * author, branches, the chips of the row), then four tabs — the conversation
 * (description, comments, reviews, review threads by file), the commits, the
 * checks (the end of a failed job's log on demand) and the files (each one's
 * diff unfolded on demand, its review threads under their line) — and beside
 * them a column: where the pull request stands with its gestures, then the
 * people, labels, milestone, issues and Timon's own links.
 *
 * Everything here was written on the forge: React escapes it, the markdown is
 * rendered without raw HTML (`forgeMarkdownHtml`), and a link only leaves for
 * an https GitHub address, in a new tab. The gestures on the pull request sit
 * in the column's status card, which stays in view whatever the tab: the one
 * its state calls for filled, the frequent ones under it, the rest in the
 * header's "…" (`pullRequestActions`, shared with the row's menu). The header
 * keeps only icon buttons, so the title has the width.
 */

import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import {
  ChevronRight, CircleAlert, CircleCheck, CircleDot, CircleMinus, ExternalLink, GitCommitHorizontal, GitMerge,
  GitPullRequest, GitPullRequestArrow, GitPullRequestClosed, GitPullRequestDraft, LoaderCircle, Lock, MoreHorizontal, RefreshCw, ScrollText,
} from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WidgetButton, widgetButtonClass } from '@/components/widget-toolbar';
import { t } from '@/lib/i18n';
import { formatDateTime, formatRelativeTime, numberFormat } from '@/lib/intl';
import { NativeViewCover } from '@/lib/native-view-cover';
import { cn } from '@/lib/utils';
import { diffLineKind, patchBody } from './landing-api';
import { DIFF_LINE_CLASS } from './landing-preview-dialog';
import {
  checkCounts, checkSeconds, forgeHref, forgeMarkdownHtml, getCheckLog, getPullRequestDiff, getPullRequestPage, mergeState, placeThreads,
  splitDiffByFile, type CheckLog, type MergeState, type PageCheck, type PageThread, type PageTimelineItem, type PullRequestPage, type Read,
} from './pull-request-page-api';
import { branchChip, branchLock, reviewBadge, type PullActionId, type PullActions, type PullRequestItem } from './pull-requests-model';
import { PullActionButton, PullActionMenuItems } from './pull-request-actions';

const ISLAND = 'rounded-lg bg-foreground/[0.035]';
const CHIP = 'inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[10.5px] font-medium tabular-nums';
const NOTE = 'rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[11.5px] text-amber-800 dark:text-amber-200';
const MUTED_CHIP = 'bg-foreground/[0.06] text-muted-foreground';
/** Diff lines painted per file, and for the whole tab: a huge diff would freeze the window. */
const FILE_LINES_SHOWN = 1500;
const DIFF_LINES_SHOWN = 6000;

const STATE_TONE: Record<string, string> = {
  open: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  draft: MUTED_CHIP,
  merged: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  closed: 'bg-red-500/15 text-red-700 dark:text-red-300',
};

const REVIEW_TONE: Record<string, string> = {
  approved: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  changes_requested: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  review_required: MUTED_CHIP,
  commented: MUTED_CHIP,
  dismissed: MUTED_CHIP,
  pending: MUTED_CHIP,
};

const CHECK_TONE: Record<PageCheck['status'], string> = {
  fail: 'text-red-600 dark:text-red-400',
  pass: 'text-emerald-600 dark:text-emerald-400',
  pending: 'text-amber-600 dark:text-amber-400',
  skipped: 'text-muted-foreground',
};

const CHECK_ICON = { fail: CircleAlert, pass: CircleCheck, pending: CircleDot, skipped: CircleMinus } as const;

/** A link out of the app: only to an https GitHub address, in a new tab. */
function ForgeLink({ href, children, className, label }: { href: string | null; children: ReactNode; className?: string; label?: string }) {
  const safe = forgeHref(href);
  if (!safe) return <span className={className}>{children}</span>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" title={label} aria-label={label}
      className={cn('underline-offset-2 hover:underline', className)}>
      {children}
    </a>
  );
}

/** The first letter of a login, as GitHub's avatar would stand: the app loads no image from elsewhere. */
function Initial({ login }: { login: string | null }) {
  return (
    <span aria-hidden className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground/[0.08] text-[10px] font-semibold uppercase text-foreground/75">
      {(login ?? '?').slice(0, 1)}
    </span>
  );
}

function When({ iso }: { iso: string | null }) {
  if (!iso) return null;
  return <time dateTime={iso} title={formatDateTime(iso)} className="shrink-0 tabular-nums">{formatRelativeTime(iso)}</time>;
}

function Markdown({ text, truncated }: { text: string; truncated: boolean }) {
  const html = useMemo(() => forgeMarkdownHtml(text), [text]);
  if (!html) return <p className="text-[12px] italic text-muted-foreground">{t('pullRequests.detail.noDescription')}</p>;
  return (
    <>
      {/* `chat-bubble` carries the typography of rendered markdown (globals.css). */}
      <div data-pull-markdown="" className="chat-bubble min-w-0 break-words text-[12.5px]" dangerouslySetInnerHTML={{ __html: html }} />
      {truncated && <p className="mt-1 text-[11px] text-muted-foreground">{t('pullRequests.detail.textCut')}</p>}
    </>
  );
}

function More({ count, what }: { count: number; what: 'timeline' | 'threads' | 'commits' | 'files' | 'checks' | 'comments' | 'people' }) {
  if (count <= 0) return null;
  return <p data-pull-more={what} className="text-[11px] tabular-nums text-muted-foreground">{t(`pullRequests.detail.more.${what}`, { count })}</p>;
}

function stateOf(page: Pick<PullRequestPage, 'state' | 'isDraft'>): 'open' | 'draft' | 'merged' | 'closed' {
  return page.state === 'open' && page.isDraft ? 'draft' : page.state;
}

const STATE_ICON = { open: GitPullRequest, draft: GitPullRequestDraft, merged: GitMerge, closed: GitPullRequestClosed } as const;

// ─── Conversation ──────────────────────────────────────────────────────────

function TimelineEntry({ item }: { item: PageTimelineItem }) {
  const head = (
    <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
      <Initial login={item.author} />
      <span className="min-w-0 truncate font-medium text-foreground/90">{item.author ?? t('pullRequests.deletedAuthor')}</span>
      {item.kind === 'review' && (
        <span data-pull-review-state={item.state} className={cn(CHIP, REVIEW_TONE[item.state])}>
          {t(`pullRequests.detail.reviewState.${item.state}`)}
        </span>
      )}
      <span className="ml-auto" />
      {item.kind === 'comment' && item.url
        ? <ForgeLink href={item.url}><When iso={item.createdAt} /></ForgeLink>
        : <When iso={item.createdAt} />}
    </div>
  );
  if (item.kind === 'comment' && item.hidden) {
    return (
      <li data-pull-timeline="comment" className={cn(ISLAND, 'flex flex-col gap-1 px-3 py-2')}>
        {head}
        <p className="text-[11.5px] italic text-muted-foreground">{t('pullRequests.detail.hiddenComment')}</p>
      </li>
    );
  }
  return (
    <li data-pull-timeline={item.kind} className={cn(ISLAND, 'flex flex-col gap-1.5 px-3 py-2')}>
      {head}
      {item.body.trim() && <Markdown text={item.body} truncated={item.bodyTruncated} />}
    </li>
  );
}

function ThreadComments({ thread }: { thread: PageThread }) {
  return (
    <div className="flex flex-col gap-2">
      {thread.comments.map((c, i) => (
        <div key={i} className="flex flex-col gap-1">
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <Initial login={c.author} />
            <span className="min-w-0 truncate font-medium text-foreground/90">{c.author ?? t('pullRequests.deletedAuthor')}</span>
            <span className="ml-auto" />
            <ForgeLink href={c.url}><When iso={c.createdAt} /></ForgeLink>
          </div>
          <Markdown text={c.body} truncated={c.bodyTruncated} />
        </div>
      ))}
      <More count={thread.commentsMore} what="comments" />
    </div>
  );
}

function ThreadChips({ thread }: { thread: PageThread }) {
  return (
    <>
      <span data-pull-thread-state={thread.resolved ? 'resolved' : 'open'}
        className={cn(CHIP, thread.resolved ? MUTED_CHIP : 'bg-amber-500/15 text-amber-700 dark:text-amber-300')}>
        {t(thread.resolved ? 'pullRequests.detail.thread.resolved' : 'pullRequests.detail.thread.open')}
      </span>
      {thread.outdated && <span className={cn(CHIP, MUTED_CHIP)}>{t('pullRequests.detail.thread.outdated')}</span>}
    </>
  );
}

/** One review thread; a resolved one folds, as on GitHub. */
function Thread({ thread, showPath }: { thread: PageThread; showPath: boolean }) {
  const [open, setOpen] = useState(!thread.resolved);
  return (
    <li data-pull-thread="" className={cn(ISLAND, 'flex flex-col gap-1.5 px-3 py-2')}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex min-w-0 items-center gap-1.5 rounded-sm text-left text-[11.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden />
        {showPath && (
          // code-font: a file path
          <span className="min-w-0 truncate font-mono text-[11px]" title={thread.path ?? undefined}>{thread.path ?? t('pullRequests.detail.thread.noFile')}</span>
        )}
        {thread.line !== null && <span className="shrink-0 tabular-nums text-muted-foreground">{t('pullRequests.detail.thread.line', { line: thread.line })}</span>}
        <ThreadChips thread={thread} />
      </button>
      {open && <ThreadComments thread={thread} />}
    </li>
  );
}

type BoxLine = { icon: typeof CircleCheck; tone: string };

const TONE = {
  good: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  bad: 'text-red-600 dark:text-red-400',
  quiet: 'text-muted-foreground',
} as const;

const BOX_CHECKS: Record<'none' | 'failed' | 'pending' | 'passed', BoxLine> = {
  none: { icon: CircleMinus, tone: TONE.quiet },
  failed: { icon: CircleAlert, tone: TONE.bad },
  pending: { icon: CircleDot, tone: TONE.warn },
  passed: { icon: CircleCheck, tone: TONE.good },
};

const BOX_MERGE: Record<MergeState, BoxLine> = {
  ready: { icon: CircleCheck, tone: TONE.good },
  conflict: { icon: CircleAlert, tone: TONE.warn },
  behind: { icon: GitPullRequestArrow, tone: TONE.warn },
  blocked: { icon: CircleAlert, tone: TONE.warn },
  draft: { icon: GitPullRequestDraft, tone: TONE.quiet },
  unknown: { icon: CircleDot, tone: TONE.quiet },
  merged: { icon: GitMerge, tone: 'text-violet-600 dark:text-violet-400' },
  closed: { icon: GitPullRequestClosed, tone: TONE.bad },
};

const BOX_LOCK: BoxLine = { icon: Lock, tone: TONE.quiet };

const BOX_DECISION: Record<NonNullable<PullRequestPage['reviewDecision']>, BoxLine> = {
  approved: { icon: CircleCheck, tone: TONE.good },
  changes_requested: { icon: CircleAlert, tone: TONE.warn },
  review_required: { icon: CircleDot, tone: TONE.quiet },
};

function BoxIcon({ line }: { line: BoxLine }) {
  const Icon = line.icon;
  return <Icon className={cn('size-4 shrink-0', line.tone)} aria-hidden />;
}

const STATUS_LINE = 'flex min-w-0 items-start gap-2 px-1.5 py-1 text-xs font-medium leading-4';

/**
 * Where the pull request stands, as GitHub's merge box says it, and what to
 * do about it: its checks (a click shows them), its merge state, the review
 * decision, a lock on its branch, then the gesture its state calls for,
 * filled, and the frequent others under it. No merge button: a pull request
 * merges on GitHub, by a person.
 */
function StatusCard({ page, pull, actions, onAction, onShowChecks }: {
  page: PullRequestPage;
  pull: PullRequestItem;
  actions: PullActions;
  onAction: (id: PullActionId) => void;
  onShowChecks: () => void;
}) {
  const counts = checkCounts(page.checks);
  const checks = page.checks.length === 0 ? 'none' : counts.fail > 0 ? 'failed' : counts.pending > 0 ? 'pending' : 'passed';
  const merge = mergeState(page);
  const lock = branchLock(pull);
  return (
    <section data-pull-status-card="" aria-label={t('pullRequests.detail.box.label')} className={cn(ISLAND, 'flex flex-col gap-0.5 p-2')}>
      <button type="button" data-pull-box-checks={checks} onClick={onShowChecks} title={t('pullRequests.detail.box.showChecks')}
        className="flex min-w-0 items-start gap-2 rounded-md px-1.5 py-1 text-left hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <BoxIcon line={BOX_CHECKS[checks]} />
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium leading-4">{t(`pullRequests.detail.box.checks.${checks}`)}</span>
          {checks !== 'none' && (
            <span className="block text-[11px] tabular-nums text-muted-foreground">{t('pullRequests.detail.box.checksCount', counts)}</span>
          )}
        </span>
        <ChevronRight className="size-3.5 shrink-0 self-center text-muted-foreground" aria-hidden />
      </button>
      <div data-pull-box-merge={merge} className={STATUS_LINE}>
        <BoxIcon line={BOX_MERGE[merge]} />
        <span className="min-w-0">{t(`pullRequests.detail.box.merge.${merge}`)}</span>
      </div>
      {page.reviewDecision && (
        <div data-pull-box-decision={page.reviewDecision} className={STATUS_LINE}>
          <BoxIcon line={BOX_DECISION[page.reviewDecision]} />
          <span className="min-w-0">{t(`pullRequests.detail.box.decision.${page.reviewDecision}`)}</span>
        </div>
      )}
      {lock && (
        <div data-pull-box-lock={lock} title={t(`pullRequests.lockedHint.${lock}`)} className={STATUS_LINE}>
          <BoxIcon line={BOX_LOCK} />
          <span className="min-w-0">{t(`pullRequests.locked.${lock}`)}</span>
        </div>
      )}
      {page.state === 'open' && (
        <div data-pull-box-actions="" role="group" aria-label={t('pullRequests.detail.actions')} className="flex flex-col gap-1.5 px-1.5 pb-0.5 pt-2">
          <PullActionButton action={actions.primary} primary block onRun={onAction} />
          {actions.secondary.map((action) => <PullActionButton key={action.id} action={action} block onRun={onAction} />)}
        </div>
      )}
    </section>
  );
}

function ConversationTab({ page }: { page: PullRequestPage }) {
  return (
    <div className="flex flex-col gap-3">
      <section data-pull-body="" className={cn(ISLAND, 'flex flex-col gap-1.5 px-3 py-2.5')}>
        <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <Initial login={page.author} />
          <span className="min-w-0 truncate font-medium text-foreground/90">{page.author ?? t('pullRequests.deletedAuthor')}</span>
          <span className="ml-auto" />
          <When iso={page.createdAt} />
        </div>
        <Markdown text={page.body} truncated={page.bodyTruncated} />
      </section>
      <More count={page.timelineMore} what="timeline" />
      {page.timeline.length > 0 && (
        <ul className="flex flex-col gap-2">
          {page.timeline.map((item, i) => <TimelineEntry key={i} item={item} />)}
        </ul>
      )}
      {(page.threads.length > 0 || page.threadsError) && (
        <section aria-label={t('pullRequests.detail.threadsTitle')} className="flex flex-col gap-2">
          <h3 className="text-[11.5px] font-medium text-muted-foreground">
            {t('pullRequests.detail.threadsTitle')}
            {page.threads.length > 0 && (
              <span className="ml-1.5 tabular-nums">
                {t('pullRequests.detail.threadsCount', { open: page.threads.filter((th) => !th.resolved).length, total: page.threads.length })}
              </span>
            )}
          </h3>
          {page.threadsError && <p className="text-[11.5px] text-muted-foreground">{t('pullRequests.detail.threadsError', { detail: page.threadsError })}</p>}
          <ul className="flex flex-col gap-1.5">
            {page.threads.map((thread, i) => <Thread key={i} thread={thread} showPath />)}
          </ul>
          <More count={page.threadsMore} what="threads" />
        </section>
      )}
    </div>
  );
}

// ─── Commits ───────────────────────────────────────────────────────────────

function CommitsTab({ page }: { page: PullRequestPage }) {
  if (page.commits.length === 0) return <p className="text-xs text-muted-foreground">{t('pullRequests.detail.noCommits')}</p>;
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1">
        {page.commits.map((c) => (
          <li key={c.sha} data-pull-commit={c.sha} className={cn(ISLAND, 'flex min-w-0 items-center gap-2 px-2.5 py-1.5')}>
            <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-xs" title={c.headline}>{c.headline}</span>
            <span className="shrink-0 truncate text-[11px] text-muted-foreground">{c.author ?? ''}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground"><When iso={c.date || null} /></span>
            <ForgeLink href={c.url} label={t('pullRequests.detail.openCommit')}>
              {/* code-font: a commit sha */}
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{c.sha.slice(0, 7)}</span>
            </ForgeLink>
          </li>
        ))}
      </ul>
      <More count={page.commitsMore} what="commits" />
    </div>
  );
}

// ─── Checks ────────────────────────────────────────────────────────────────

function duration(seconds: number): string {
  const unit = (n: number, u: 'minute' | 'second') => numberFormat({ style: 'unit', unit: u, unitDisplay: 'narrow' }).format(n);
  return seconds < 60 ? unit(seconds, 'second') : `${unit(Math.floor(seconds / 60), 'minute')} ${unit(seconds % 60, 'second')}`;
}

type LogLoad = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; log: CheckLog };

function CheckRow({ check, project, number }: { check: PageCheck; project: string; number: number }) {
  const [log, setLog] = useState<LogLoad | null>(null);
  const Icon = CHECK_ICON[check.status];
  const seconds = checkSeconds(check);
  const readLog = async () => {
    if (log) { setLog(null); return; }
    if (!check.url) return;
    setLog({ kind: 'loading' });
    const out = await getCheckLog(project, number, check.url);
    setLog(out.ok ? { kind: 'ready', log: out.value } : { kind: 'error', message: out.message });
  };
  return (
    <li data-pull-check={check.name} data-status={check.status} className={cn(ISLAND, 'flex flex-col gap-1.5 px-2.5 py-1.5')}>
      {/* min-h: a row without a link keeps the height of one that has its button. */}
      <div className="flex min-h-7 min-w-0 items-center gap-2">
        <Icon className={cn('size-3.5 shrink-0', CHECK_TONE[check.status])} aria-label={t(`landings.checksIsland.status.${check.status}`)} />
        <span className="min-w-0 flex-1 truncate text-xs" title={check.name}>
          {check.workflow && <span className="text-muted-foreground">{check.workflow} · </span>}
          {check.name}
        </span>
        {seconds !== null && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{duration(seconds)}</span>}
        {check.status === 'fail' && check.url && (
          <WidgetButton
            data-pull-check-log=""
            onClick={() => { void readLog(); }}
            title={t('pullRequests.detail.checkLog')}
            aria-label={t('pullRequests.detail.checkLog')}
            aria-expanded={log !== null}
            icon={log?.kind === 'loading' ? <LoaderCircle className="size-3.5 animate-spin" /> : <ScrollText className="size-3.5" />}
          />
        )}
        {forgeHref(check.url) && (
          <a href={forgeHref(check.url)!} target="_blank" rel="noopener noreferrer"
            title={t('pullRequests.detail.openCheck')} aria-label={t('pullRequests.detail.openCheck')}
            className={widgetButtonClass({ iconOnly: true })}>
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
      {log?.kind === 'error' && <p className="text-[11.5px] text-red-600 dark:text-red-400">{log.message}</p>}
      {log?.kind === 'ready' && (
        <>
          {/* code-font: a CI log */}
          <pre data-pull-check-tail="" className="scrollbar-thin max-h-72 overflow-auto whitespace-pre rounded-md bg-background/70 px-2 py-1.5 font-mono text-[11px] leading-[1.5]">
            {log.log.tail || t('pullRequests.detail.emptyLog')}
          </pre>
          {log.log.truncated && <p className="text-[11px] text-muted-foreground">{t('pullRequests.detail.logCut')}</p>}
        </>
      )}
    </li>
  );
}

const CHECK_ORDER: Record<PageCheck['status'], number> = { fail: 0, pending: 1, pass: 2, skipped: 3 };

function ChecksTab({ page, project }: { page: PullRequestPage; project: string }) {
  if (page.checks.length === 0) return <p className="text-xs text-muted-foreground">{t('pullRequests.detail.noChecks')}</p>;
  const sorted = [...page.checks].sort((a, b) => CHECK_ORDER[a.status] - CHECK_ORDER[b.status]);
  const counts = checkCounts(page.checks);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11.5px] tabular-nums text-muted-foreground">{t('pullRequests.detail.checksSummary', counts)}</p>
      <ul className="flex flex-col gap-1">
        {sorted.map((check, i) => <CheckRow key={`${check.name}-${i}`} check={check} project={project} number={page.number} />)}
      </ul>
      <More count={page.checksMore} what="checks" />
    </div>
  );
}

// ─── Files ─────────────────────────────────────────────────────────────────

type DiffLoad = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; files: Map<string, string>; truncated: boolean };

function FilePatch({ patch, threads }: { patch: string; threads: PageThread[] }) {
  const lines = patchBody(patch);
  const shown = lines.slice(0, FILE_LINES_SHOWN);
  const { at, unplaced } = placeThreads(shown, threads);
  return (
    <div className="flex flex-col gap-1.5 px-2 pb-2">
      {/* code-font: a diff */}
      <pre data-pull-file-diff="" className="scrollbar-thin overflow-x-auto rounded-md bg-background/70 py-1.5 font-mono text-[11px] leading-[1.5]">
        {/* w-max + min-w-full: a line's colour spans the scrolled width. */}
        <div className="w-max min-w-full">
          {shown.map((line, i) => (
            <div key={i}>
              <div className={cn('whitespace-pre px-2', DIFF_LINE_CLASS[diffLineKind(line)])} data-kind={diffLineKind(line)}>{line || ' '}</div>
              {at.get(i)?.map((thread, j) => (
                // The thread reads in the product's font: it is prose, not code.
                <div key={j} data-pull-inline-thread="" className="sticky left-0 my-1 ml-2 mr-2 flex max-w-[44rem] flex-col gap-1.5 whitespace-normal rounded-md bg-card px-3 py-2 font-sans text-foreground shadow-elev-1">
                  <div className="flex items-center gap-1.5 text-[11px]"><ThreadChips thread={thread} /></div>
                  <ThreadComments thread={thread} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </pre>
      {lines.length > FILE_LINES_SHOWN && <p className="text-[11px] text-muted-foreground">{t('pullRequests.detail.fileCut')}</p>}
      {unplaced.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {unplaced.map((thread, i) => <Thread key={i} thread={thread} showPath={false} />)}
        </ul>
      )}
    </div>
  );
}

function FilesTab({ page, project }: { page: PullRequestPage; project: string }) {
  const [diff, setDiff] = useState<DiffLoad>({ kind: 'idle' });
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const threadsByPath = useMemo(() => {
    const map = new Map<string, PageThread[]>();
    for (const thread of page.threads) if (thread.path) map.set(thread.path, [...(map.get(thread.path) ?? []), thread]);
    return map;
  }, [page.threads]);

  // The diff is read once, at the first file unfolded: the list comes with the page.
  const toggle = (path: string) => {
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path); else n.add(path);
      return n;
    });
    if (diff.kind !== 'idle') return;
    setDiff({ kind: 'loading' });
    void getPullRequestDiff(project, page.number).then((out: Read<{ diff: string; truncated: boolean }>) => {
      if (!out.ok) { setDiff({ kind: 'error', message: out.message }); return; }
      const lines = out.value.diff.split('\n');
      const cut = lines.length > DIFF_LINES_SHOWN;
      setDiff({ kind: 'ready', files: splitDiffByFile(cut ? lines.slice(0, DIFF_LINES_SHOWN).join('\n') : out.value.diff), truncated: out.value.truncated || cut });
    });
  };

  if (page.files.length === 0) return <p className="text-xs text-muted-foreground">{t('pullRequests.detail.noFiles')}</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11.5px] tabular-nums text-muted-foreground">
        {t('pullRequests.detail.filesSummary', { files: page.changedFiles })}
        {' '}
        <span className="text-emerald-700 dark:text-emerald-300">+{page.additions}</span>
        {' '}
        <span className="text-red-700 dark:text-red-300">−{page.deletions}</span>
      </p>
      {diff.kind === 'error' && <p className="text-xs text-red-600 dark:text-red-400">{diff.message}</p>}
      {diff.kind === 'ready' && diff.truncated && <p className={NOTE}>{t('pullRequests.dialog.diffCut')}</p>}
      <ul className="flex flex-col gap-1.5">
        {page.files.map((file) => {
          const isOpen = open.has(file.path);
          const threads = threadsByPath.get(file.path) ?? [];
          const patch = diff.kind === 'ready' ? diff.files.get(file.path) : undefined;
          return (
            <li key={file.path} data-pull-file={file.path} className={ISLAND}>
              <button type="button" onClick={() => toggle(file.path)} aria-expanded={isOpen}
                className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-90')} aria-hidden />
                {/* code-font: a file path */}
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={file.path}>{file.path}</span>
                {threads.length > 0 && (
                  <span className={cn(CHIP, MUTED_CHIP)} title={t('pullRequests.detail.threadsTitle')}>{t('pullRequests.detail.fileThreads', { count: threads.length })}</span>
                )}
                <span className="shrink-0 text-[11px] tabular-nums">
                  <span className="text-emerald-700 dark:text-emerald-300">+{file.additions}</span>
                  {' '}
                  <span className="text-red-700 dark:text-red-300">−{file.deletions}</span>
                </span>
              </button>
              {isOpen && (
                diff.kind === 'loading' || diff.kind === 'idle'
                  ? <p className="px-3 pb-2 text-[11.5px] text-muted-foreground">{t('pullRequests.loading')}</p>
                  : diff.kind === 'ready' && patch !== undefined
                    ? <FilePatch patch={patch} threads={threads} />
                    : diff.kind === 'ready' && <p className="px-3 pb-2 text-[11.5px] text-muted-foreground">{t('pullRequests.detail.noPatch')}</p>
              )}
            </li>
          );
        })}
      </ul>
      <More count={page.filesMore} what="files" />
    </div>
  );
}

// ─── Side ──────────────────────────────────────────────────────────────────

function SideRow({ label, children, data }: { label: string; children: ReactNode; data: string }) {
  return (
    <div data-pull-side={data} className="flex flex-col gap-1">
      <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1 text-xs">{children}</dd>
    </div>
  );
}

function People({ logins, more }: { logins: string[]; more: number }) {
  if (logins.length === 0) return <span className="text-muted-foreground">{t('pullRequests.detail.none')}</span>;
  return (
    <>
      {logins.map((login) => (
        <span key={login} className="inline-flex min-w-0 items-center gap-1"><Initial login={login} /><span className="truncate">{login}</span></span>
      ))}
      {more > 0 && <span className="tabular-nums text-muted-foreground">{t('pullRequests.detail.more.people', { count: more })}</span>}
    </>
  );
}

/** Timon's own links: the job behind the pull request and the ideas it carries. */
function TimonLinks({ pull, onOpenJob, onOpenTodo }: {
  pull: PullRequestItem;
  onOpenJob: (id: string) => void;
  onOpenTodo: (id: number) => void;
}) {
  const links = pull.links;
  if (!links || (!links.job_id && links.todos.length === 0)) return null;
  return (
    <dl data-pull-timon="" className={cn(ISLAND, 'flex flex-col gap-3 px-3 py-2.5')}>
      {links.job_id && (
        <SideRow label={t('pullRequests.detail.job')} data="job">
          <button type="button" data-pull-open-job={links.job_id} onClick={() => onOpenJob(links.job_id!)}
            className="rounded-sm text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {t('pullRequests.showJob')}
          </button>
        </SideRow>
      )}
      {links.todos.length > 0 && (
        <SideRow label={t('landings.links.todo', { count: links.todos.length })} data="todos">
          {links.todos.map((todo) => (
            <button key={todo.id} type="button" data-pull-open-todo={todo.id} onClick={() => onOpenTodo(todo.id)} title={todo.text}
              className="min-w-0 max-w-full truncate rounded-sm text-left text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {todo.text}
            </button>
          ))}
        </SideRow>
      )}
    </dl>
  );
}

/**
 * The column beside the tabs. Its status card sticks to the top: what the
 * person can do stays in view while the people and links scroll under it.
 */
function SidePanel({ page, repo, card, timon }: { page: PullRequestPage; repo: string | null; card: ReactNode; timon: ReactNode }) {
  return (
    <div data-pull-side-column="" className="scrollbar-thin flex min-h-0 flex-col gap-3 md:overflow-y-auto">
      {/* An opaque ground under the card: the rows scroll beneath it. */}
      <div className="bg-popover md:sticky md:top-0 md:z-10">{card}</div>
      <dl className={cn(ISLAND, 'flex flex-col gap-3 px-3 py-2.5')}>
        <SideRow label={t('pullRequests.detail.reviewers')} data="reviewers">
          <People logins={page.reviewRequests} more={page.reviewRequestsMore} />
        </SideRow>
        <SideRow label={t('pullRequests.detail.assignees')} data="assignees">
          <People logins={page.assignees} more={page.assigneesMore} />
        </SideRow>
        <SideRow label={t('pullRequests.detail.labels')} data="labels">
          {page.labels.length === 0
            ? <span className="text-muted-foreground">{t('pullRequests.detail.none')}</span>
            : page.labels.map((label) => (
              <span key={label.name} className={cn(CHIP, MUTED_CHIP)}>
                {label.color && /^[0-9a-f]{6}$/i.test(label.color) && (
                  <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: `#${label.color}` }} />
                )}
                {label.name}
              </span>
            ))}
        </SideRow>
        <SideRow label={t('pullRequests.detail.milestone')} data="milestone">
          {page.milestone
            ? <ForgeLink href={page.milestone.url}>{page.milestone.title}</ForgeLink>
            : <span className="text-muted-foreground">{t('pullRequests.detail.none')}</span>}
        </SideRow>
        <SideRow label={t('pullRequests.detail.issues')} data="issues">
          {page.closingIssues.length === 0
            ? <span className="text-muted-foreground">{t('pullRequests.detail.none')}</span>
            : page.closingIssues.map((issue) => {
              const same = issue.repo !== null && repo !== null && issue.repo.toLowerCase() === repo.toLowerCase();
              const text = same || issue.repo === null ? `#${issue.number}` : `${issue.repo}#${issue.number}`;
              return <ForgeLink key={text} href={issue.url} className="tabular-nums text-primary">{text}</ForgeLink>;
            })}
        </SideRow>
      </dl>
      {timon}
    </div>
  );
}

// ─── The window ────────────────────────────────────────────────────────────

type PageLoad = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; page: PullRequestPage };

export function PullRequestDialog({ project, repo, pull, actions, onAction, links, onOpenJob, onOpenTodo, onClose }: {
  project: string;
  repo: string | null;
  /** The row the window was opened from: its title shows at once, its chips and links come from the list. */
  pull: PullRequestItem;
  /** Its gestures, as `pullRequestActions` places them; the row's menu lists the same. */
  actions: PullActions;
  onAction: (id: PullActionId) => void;
  /** The job and the ideas behind it, after the gestures in "…". */
  links: ReactNode;
  /** Timon's links (job, ideas): the window closes before the one they open. */
  onOpenJob: (id: string) => void;
  onOpenTodo: (id: number) => void;
  onClose: () => void;
}): ReactElement {
  const [load, setLoad] = useState<PageLoad>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState('conversation');

  useEffect(() => {
    let alive = true;
    setLoad({ kind: 'loading' });
    void getPullRequestPage(project, pull.number, pull.updatedAt ? { updated: pull.updatedAt } : {}).then((out) => {
      if (!alive) return;
      setLoad(out.ok ? { kind: 'ready', page: out.value } : { kind: 'error', message: out.message });
    });
    return () => { alive = false; };
  }, [project, pull.number, pull.updatedAt]);

  const refresh = async () => {
    setRefreshing(true);
    const out = await getPullRequestPage(project, pull.number, { fresh: true });
    setRefreshing(false);
    setLoad(out.ok ? { kind: 'ready', page: out.value } : { kind: 'error', message: out.message });
  };

  const page = load.kind === 'ready' ? load.page : null;
  const state = stateOf(page ?? { state: 'open', isDraft: pull.isDraft });
  const StateIcon = STATE_ICON[state];
  const chip = branchChip(pull);
  const lock = branchLock(pull);
  const badge = reviewBadge(pull);
  const author = page?.author ?? pull.author;
  const head = page
    ? (page.isCrossRepository && page.headOwner ? `${page.headOwner}:${page.headRef}` : page.headRef)
    : null;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent data-pull-dialog={pull.number} className="flex h-[min(88vh,52rem)] max-w-[1000px] flex-col gap-3 overflow-hidden">
        <div className="flex min-w-0 items-start gap-2 pr-6">
          <DialogTitle className="flex min-w-0 flex-1 items-start gap-2 text-sm leading-5">
            <StateIcon className={cn('mt-0.5 size-4 shrink-0', state === 'open' ? 'text-emerald-600 dark:text-emerald-400' : state === 'merged' ? 'text-violet-600 dark:text-violet-400' : state === 'closed' ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground')} aria-hidden />
            <span data-pull-title="" className="line-clamp-2 min-w-0 break-words" title={page?.title ?? pull.title}>{page?.title ?? pull.title}</span>
            <span className="shrink-0 font-normal tabular-nums text-muted-foreground">#{pull.number}</span>
          </DialogTitle>
          <div data-pull-header-tools="" className="-mt-0.5 flex shrink-0 items-center">
            <span className="flex items-center gap-0.5">
              <WidgetButton
                data-pull-refresh=""
                onClick={() => { void refresh(); }}
                disabled={refreshing || load.kind === 'loading'}
                title={t('pullRequests.detail.refresh')}
                aria-label={t('pullRequests.detail.refresh')}
                icon={<RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />}
              />
              {forgeHref(pull.url) && (
                <a href={forgeHref(pull.url)!} target="_blank" rel="noopener noreferrer" data-pull-forge=""
                  title={t('pullRequests.openOnForge')} aria-label={t('pullRequests.openOnForge')}
                  className={widgetButtonClass({ iconOnly: true })}>
                  <ExternalLink className="size-3.5" />
                </a>
              )}
              <Dropdown.Root modal={false}>
                <Dropdown.Trigger asChild>
                  <button type="button" data-pull-dialog-menu="" title={t('pullRequests.more')} aria-label={t('pullRequests.more')} className={widgetButtonClass({ iconOnly: true })}>
                    <MoreHorizontal className="size-3.5" />
                  </button>
                </Dropdown.Trigger>
                <Dropdown.Portal>
                  <Dropdown.Content sideOffset={6} align="end" className="z-[60] min-w-44 rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-elev-2">
                    <NativeViewCover />
                    <PullActionMenuItems actions={actions.overflow} onRun={onAction} />
                    {links}
                  </Dropdown.Content>
                </Dropdown.Portal>
              </Dropdown.Root>
            </span>
          </div>
        </div>
        <DialogDescription className="sr-only">{t('pullRequests.detail.description')}</DialogDescription>

        <div data-pull-header="" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
          <span data-pull-state={state} className={cn(CHIP, STATE_TONE[state])}>{t(`pullRequests.detail.state.${state}`)}</span>
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <Initial login={author} />
            <span className="font-medium text-foreground/90">{author ?? t('pullRequests.deletedAuthor')}</span>
          </span>
          {page && head && (
            <span className="min-w-0 truncate" title={`${head} → ${page.baseRef}`}>
              {t('pullRequests.detail.branches', { commits: page.commits.length + page.commitsMore, base: page.baseRef, head })}
            </span>
          )}
          {page?.createdAt && <span>{t('pullRequests.detail.opened')} <When iso={page.createdAt} /></span>}
          {page?.mergeable === 'mergeable' && !chip && (
            <span data-pull-mergeable="" className={cn(CHIP, 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300')}>{t('pullRequests.detail.mergeable')}</span>
          )}
          {chip && (
            <span data-pull-branch={chip} className={cn(CHIP, chip === 'conflict' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : MUTED_CHIP)}>
              {t(`pullRequests.branch.${chip}`)}
            </span>
          )}
          {!chip && page?.mergeable === 'conflicting' && (
            <span data-pull-branch="conflict" className={cn(CHIP, 'bg-amber-500/15 text-amber-700 dark:text-amber-300')}>{t('pullRequests.branch.conflict')}</span>
          )}
          {page?.reviewDecision && (
            <span data-pull-decision={page.reviewDecision} className={cn(CHIP, REVIEW_TONE[page.reviewDecision])}>
              {t(`pullRequests.detail.decision.${page.reviewDecision}`)}
            </span>
          )}
          {lock && <span data-pull-locked={lock} title={t(`pullRequests.lockedHint.${lock}`)} className={cn(CHIP, MUTED_CHIP)}>{t(`pullRequests.locked.${lock}`)}</span>}
          {badge && badge.kind === 'verdict' && (
            <span className={cn(CHIP, MUTED_CHIP)}>{t('pullRequests.detail.timonVerdict', { verdict: t(`pullRequests.verdict.${badge.verdict ?? 'none'}`) })}</span>
          )}
        </div>

        {load.kind === 'error' && (
          <div className="flex items-center gap-2">
            <p className="text-xs text-red-600 dark:text-red-400">{load.message}</p>
            <WidgetButton onClick={() => { void refresh(); }} label={t('pullRequests.detail.retry')} />
          </div>
        )}
        {load.kind === 'loading' && <p className="text-xs text-muted-foreground">{t('pullRequests.loading')}</p>}

        {page && (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_16rem]">
            <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 min-w-0 flex-col gap-2">
              <TabsList className="h-8 self-start">
                <TabsTrigger value="conversation" data-pull-tab="conversation" className="text-xs">
                  {t('pullRequests.detail.tab.conversation')}
                  <span className="ml-1.5 tabular-nums text-muted-foreground">{page.timeline.length + page.timelineMore}</span>
                </TabsTrigger>
                <TabsTrigger value="commits" data-pull-tab="commits" className="text-xs">
                  {t('pullRequests.detail.tab.commits')}
                  <span className="ml-1.5 tabular-nums text-muted-foreground">{page.commits.length + page.commitsMore}</span>
                </TabsTrigger>
                <TabsTrigger value="checks" data-pull-tab="checks" className="text-xs">
                  {t('pullRequests.detail.tab.checks')}
                  <span className="ml-1.5 tabular-nums text-muted-foreground">{page.checks.length + page.checksMore}</span>
                </TabsTrigger>
                <TabsTrigger value="files" data-pull-tab="files" className="text-xs">
                  {t('pullRequests.detail.tab.files')}
                  <span className="ml-1.5 tabular-nums text-muted-foreground">{page.changedFiles}</span>
                </TabsTrigger>
              </TabsList>
              <TabsContent value="conversation" className="scrollbar-thin mt-0 min-h-0 flex-1 overflow-y-auto pr-1">
                <ConversationTab page={page} />
              </TabsContent>
              <TabsContent value="commits" className="scrollbar-thin mt-0 min-h-0 flex-1 overflow-y-auto pr-1">
                <CommitsTab page={page} />
              </TabsContent>
              <TabsContent value="checks" className="scrollbar-thin mt-0 min-h-0 flex-1 overflow-y-auto pr-1">
                <ChecksTab page={page} project={project} />
              </TabsContent>
              <TabsContent value="files" className="scrollbar-thin mt-0 min-h-0 flex-1 overflow-y-auto pr-1">
                <FilesTab page={page} project={project} />
              </TabsContent>
            </Tabs>
            <SidePanel
              page={page}
              repo={repo}
              card={<StatusCard page={page} pull={pull} actions={actions} onAction={onAction} onShowChecks={() => setTab('checks')} />}
              timon={<TimonLinks pull={pull} onOpenJob={onOpenJob} onOpenTodo={onOpenTodo} />}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
